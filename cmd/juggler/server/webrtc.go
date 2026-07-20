//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"time"

	"juggler/internal/jlog"

	"github.com/pion/webrtc/v4"
)

type webrtcSignalRequest struct {
	Role  string                    `json:"role"`
	Offer webrtc.SessionDescription `json:"offer"`
}

type webrtcSignalResponse struct {
	Answer webrtc.SessionDescription `json:"answer"`
}

type webrtcICEConfig struct {
	Servers []webrtc.ICEServer
}

const (
	webRTCChunkType = "__juggler_dc_chunk"
	webRTCChunkSize = 16 * 1024
)

// dataChannelIngressKind is the MarkRemoteIngress kind for synthetic requests
// dispatched from a WebRTC DataChannel by the http-over-DC dispatcher.
const dataChannelIngressKind = "datachannel"

// RendezvousProtocolVersion is the http-over-DataChannel / signaling protocol
// version the binary speaks. It is published by handleVersion so a remote
// bootstrap page (e.g. the juggler.studio rendezvous client) can refuse to
// boot against a mismatched binary.
const RendezvousProtocolVersion = 2

type webRTCChunk struct {
	Type  string `json:"type"`
	ID    string `json:"id"`
	Index int    `json:"index"`
	Total int    `json:"total"`
	Data  string `json:"data"`
}

type webRTCChunkAssembly struct {
	total    int
	parts    []string
	received int
}

// handleWebRTCSignal exchanges one non-trickle SDP offer/answer pair over the
// LAN HTTP path. Once ICE succeeds, all realtime protocol messages flow over the
// browser-created DataChannel and the signaling path goes idle. It owns only HTTP
// request parsing/validation; the peer-connection core is acceptWebRTCOffer,
// shared with the juggler.studio rendezvous client.
func (s *Server) handleWebRTCSignal(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	var req webrtcSignalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid WebRTC offer", http.StatusBadRequest)
		return
	}
	if req.Role == "engine" {
		http.Error(w, "WebRTC engine role is not supported", http.StatusForbidden)
		return
	}
	if req.Offer.Type != webrtc.SDPTypeOffer || req.Offer.SDP == "" {
		http.Error(w, "missing WebRTC offer", http.StatusBadRequest)
		return
	}

	answer, err := s.acceptWebRTCOffer(r.Context(), req.Offer)
	if err != nil {
		status := http.StatusInternalServerError
		var bad *badOfferError
		if errors.As(err, &bad) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(webrtcSignalResponse{Answer: *answer})
}

// badOfferError marks a core failure caused by a malformed client offer so the
// HTTP handler can answer 400; every other core error is an internal 500.
type badOfferError struct{ err error }

func (e *badOfferError) Error() string { return e.err.Error() }
func (e *badOfferError) Unwrap() error { return e.err }

// acceptWebRTCOffer builds the peer connection for one already-validated SDP
// offer, wires the browser-created "juggler" DataChannel to the realtime loop,
// and returns the local SDP answer. It is the shared core for both the LAN
// /api/webrtc/signal HTTP handler and the outbound juggler.studio rendezvous
// client. On any error it closes the peer connection before returning. ctx
// bounds the synchronous setup/ICE-gathering phase only; the established
// connection outlives ctx on its own pcCtx.
func (s *Server) acceptWebRTCOffer(ctx context.Context, offer webrtc.SessionDescription) (*webrtc.SessionDescription, error) {
	return s.acceptWebRTCOfferWithICEConfig(ctx, offer, webrtcICEConfig{
		Servers: []webrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}},
	})
}

func (s *Server) acceptWebRTCOfferWithICEConfig(ctx context.Context, offer webrtc.SessionDescription, iceConfig webrtcICEConfig) (*webrtc.SessionDescription, error) {
	cfg := webrtc.Configuration{ICEServers: iceConfig.Servers}
	// Present the persistent identity so this peer's DTLS fingerprint is stable
	// across restarts (and across every connection within a run). When it is
	// nil — a first run whose identity could not be persisted — pion mints an
	// ephemeral certificate per connection, the pre-persistence behaviour.
	if s.webrtcCert != nil {
		cfg.Certificates = []webrtc.Certificate{*s.webrtcCert}
	}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}

	pcCtx, cancelPC := context.WithCancel(context.Background())
	startupTimer := time.AfterFunc(2*time.Minute, func() {
		cancelPC()
		_ = pc.Close()
	})
	var startOnce sync.Once
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "juggler" {
			_ = dc.Close()
			return
		}
		client := newWebRTCClient(dc, pc, s.stats)
		msgCh := make(chan []byte, 100)
		done := make(chan struct{})
		incomingChunks := make(map[string]*webRTCChunkAssembly)
		var doneOnce sync.Once

		dc.OnOpen(func() {
			startupTimer.Stop()
			startOnce.Do(func() {
				go s.runRealtimeClientLoop(pcCtx, client, msgCh, done)
			})
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if !msg.IsString {
				return
			}
			s.dispatchWebRTCFrame(client, append([]byte(nil), msg.Data...), incomingChunks, msgCh)
		})
		dc.OnClose(func() {
			cancelPC()
			doneOnce.Do(func() {
				close(done)
				close(msgCh)
			})
		})
		pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
			// Only Failed/Closed are terminal. Disconnected is TRANSIENT — ICE
			// enters it after a few missed consent/STUN responses (a brief Wi-Fi
			// hiccup, a NAT rebind, a momentary CPU stall) and recovers back to
			// Connected on its own; pion only escalates to Failed (~25s later) if
			// the path is genuinely dead. Tearing the DataChannel down on
			// Disconnected killed otherwise-recoverable sessions after ~a minute
			// (worse over the TURN-less studio path, which has no relay to smooth
			// a blip, and worse on Firefox, which trips Disconnected sooner). Ride
			// it out and let ICE either recover or escalate to Failed.
			if state == webrtc.PeerConnectionStateFailed || state == webrtc.PeerConnectionStateClosed {
				cancelPC()
				client.Close()
			}
		})
	})

	gatherComplete := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetRemoteDescription(offer); err != nil {
		_ = pc.Close()
		return nil, &badOfferError{fmt.Errorf("set remote description: %w", err)}
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("create answer: %w", err)
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		return nil, fmt.Errorf("set local description: %w", err)
	}

	select {
	case <-gatherComplete:
	case <-ctx.Done():
		_ = pc.Close()
		return nil, ctx.Err()
	case <-time.After(5 * time.Second):
		jlog.Info("WebRTC: ICE gathering timed out; returning partial answer")
	}

	local := pc.LocalDescription()
	if local == nil {
		_ = pc.Close()
		return nil, errors.New("missing local description")
	}
	return local, nil
}

// dispatchWebRTCFrame routes one inbound DataChannel text frame. Frame-type
// routing is centralized here so additional multiplexed protocols can be added
// as new branches without touching the OnMessage wiring:
//   - __juggler_dc_chunk: reassemble, then dispatch the completed frame.
//   - __juggler_http_req: http-over-DC; dispatch through s.router and reply with
//     a __juggler_http_res frame instead of forwarding to msgCh.
//   - anything else (realtime WS JSON): forward to msgCh -> runRealtimeClientLoop.
func (s *Server) dispatchWebRTCFrame(client *webRTCClient, data []byte, chunks map[string]*webRTCChunkAssembly, msgCh chan<- []byte) {
	assembled, complete := assembleWebRTCChunk(chunks, data)
	isChunk := isWebRTCChunk(data)
	if complete {
		data = assembled
	} else if isChunk {
		return
	}
	if isHTTPOverDCRequest(data) {
		// Dispatch off the read loop so a slow handler never blocks chunk
		// reassembly or the realtime protocol. Each response carries its own id,
		// so concurrent responses interleave safely.
		go s.handleHTTPOverDC(client, data)
		return
	}
	select {
	case msgCh <- data:
	default:
		jlog.Error("WebRTC: inbound message queue full, dropping")
	}
}

const (
	httpOverDCRequestType  = "__juggler_http_req"
	httpOverDCResponseType = "__juggler_http_res"
)

type httpOverDCRequest struct {
	Type    string            `json:"type"`
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type httpOverDCResponse struct {
	Type         string              `json:"type"`
	ID           string              `json:"id"`
	Status       int                 `json:"status"`
	Headers      map[string][]string `json:"headers"`
	Body         string              `json:"body"`
	BodyEncoding string              `json:"bodyEncoding"`
}

// isHTTPOverDCRequest peeks the frame's type without fully decoding it.
func isHTTPOverDCRequest(data []byte) bool {
	var hdr struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &hdr) == nil && hdr.Type == httpOverDCRequestType
}

// handleHTTPOverDC services one __juggler_http_req frame: it reconstructs a
// synthetic *http.Request, marks it as rendezvous ingress (so the LAN gate admits
// it while the engine WS role still refuses it), dispatches it through s.router
// via an httptest recorder, and sends the captured response back as a
// __juggler_http_res frame. SendRaw chunks the reply through the same
// __juggler_dc_chunk envelope automatically. Bodies are base64 in both
// directions so binary assets (fonts, images) travel uniformly.
func (s *Server) handleHTTPOverDC(client *webRTCClient, frame []byte) {
	var req httpOverDCRequest
	if err := json.Unmarshal(frame, &req); err != nil {
		jlog.Error("WebRTC http-over-DC: bad request frame: %v", err)
		return
	}

	var bodyReader io.Reader
	if req.Body != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			jlog.Error("WebRTC http-over-DC: bad body base64 for %s: %v", req.Path, err)
			return
		}
		bodyReader = bytes.NewReader(decoded)
	}

	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	httpReq := httptest.NewRequest(method, req.Path, bodyReader)
	for k, v := range req.Headers {
		httpReq.Header.Set(k, v)
	}
	httpReq = MarkRemoteIngress(httpReq, dataChannelIngressKind)

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, httpReq)
	res := rec.Result()
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		jlog.Error("WebRTC http-over-DC: read response body for %s: %v", req.Path, err)
		return
	}

	payload, err := json.Marshal(httpOverDCResponse{
		Type:         httpOverDCResponseType,
		ID:           req.ID,
		Status:       res.StatusCode,
		Headers:      res.Header,
		Body:         base64.StdEncoding.EncodeToString(body),
		BodyEncoding: "base64",
	})
	if err != nil {
		jlog.Error("WebRTC http-over-DC: marshal response for %s: %v", req.Path, err)
		return
	}
	client.SendRaw(payload)
}

type webRTCClient struct {
	id        string
	role      ClientRole
	info      ClientInfo
	dc        *webrtc.DataChannel
	pc        *webrtc.PeerConnection
	send      chan wsMessage
	closeOnce sync.Once
	stats     *wsStats
}

func newWebRTCClient(dc *webrtc.DataChannel, pc *webrtc.PeerConnection, stats *wsStats) *webRTCClient {
	c := &webRTCClient{
		id:   generateClientID(),
		role: ClientRoleViewer,
		// A data-channel viewer always reaches us over the WebRTC peer transport;
		// there is no HTTP request (hence no User-Agent) at channel-open time.
		info:  ClientInfo{Origin: "remote", Detail: remoteTransportLabel(dataChannelIngressKind), ConnectedAt: time.Now().UnixMilli()},
		dc:    dc,
		pc:    pc,
		send:  make(chan wsMessage, 256),
		stats: stats,
	}
	go c.writePump()
	return c
}

func (c *webRTCClient) ClientID() string       { return c.id }
func (c *webRTCClient) ClientRole() ClientRole { return c.role }
func (c *webRTCClient) ClientInfo() ClientInfo { return c.info }

func (c *webRTCClient) writePump() {
	for msg := range c.send {
		payload := msg.raw
		if payload == nil {
			var err error
			payload, err = json.Marshal(msg.json)
			if err != nil {
				jlog.Error("WebRTC marshal error for client %s: %v", c.id, err)
				continue
			}
		}
		c.stats.record(statsOut, payload, c.role)
		if err := c.sendTextChunked(payload); err != nil {
			jlog.Error("WebRTC write error for client %s: %v", c.id, err)
			return
		}
	}
}

func (c *webRTCClient) sendTextChunked(payload []byte) error {
	if len(payload) <= webRTCChunkSize {
		return c.dc.SendText(string(payload))
	}
	id := fmt.Sprintf("%s-%d", c.id, time.Now().UnixNano())
	total := (len(payload) + webRTCChunkSize - 1) / webRTCChunkSize
	for i := 0; i < total; i++ {
		start := i * webRTCChunkSize
		end := start + webRTCChunkSize
		if end > len(payload) {
			end = len(payload)
		}
		chunk, err := json.Marshal(webRTCChunk{
			Type:  webRTCChunkType,
			ID:    id,
			Index: i,
			Total: total,
			Data:  string(payload[start:end]),
		})
		if err != nil {
			return err
		}
		if err := c.dc.SendText(string(chunk)); err != nil {
			return err
		}
	}
	return nil
}

func isWebRTCChunk(data []byte) bool {
	var hdr struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &hdr) == nil && hdr.Type == webRTCChunkType
}

func assembleWebRTCChunk(chunks map[string]*webRTCChunkAssembly, data []byte) ([]byte, bool) {
	var chunk webRTCChunk
	if err := json.Unmarshal(data, &chunk); err != nil || chunk.Type != webRTCChunkType {
		return nil, false
	}
	if chunk.ID == "" || chunk.Total <= 0 || chunk.Index < 0 || chunk.Index >= chunk.Total {
		return nil, false
	}
	entry := chunks[chunk.ID]
	if entry == nil {
		entry = &webRTCChunkAssembly{total: chunk.Total, parts: make([]string, chunk.Total)}
		chunks[chunk.ID] = entry
	}
	if entry.total != chunk.Total {
		delete(chunks, chunk.ID)
		return nil, false
	}
	if entry.parts[chunk.Index] == "" {
		entry.parts[chunk.Index] = chunk.Data
		entry.received++
	}
	if entry.received != entry.total {
		return nil, false
	}
	delete(chunks, chunk.ID)
	var totalLen int
	for _, part := range entry.parts {
		totalLen += len(part)
	}
	buf := make([]byte, 0, totalLen)
	for _, part := range entry.parts {
		buf = append(buf, part...)
	}
	return buf, true
}

func (c *webRTCClient) trySend(msg wsMessage) (sent bool) {
	defer func() {
		if recover() != nil {
			sent = false
		}
	}()
	c.send <- msg
	return true
}

func (c *webRTCClient) Send(msg any) bool        { return c.trySend(wsMessage{json: msg}) }
func (c *webRTCClient) SendRaw(data []byte) bool { return c.trySend(wsMessage{raw: data}) }

func (c *webRTCClient) Close() {
	c.closeOnce.Do(func() {
		close(c.send)
		_ = c.dc.Close()
		_ = c.pc.Close()
	})
}
