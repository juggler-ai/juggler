//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/server/handlers"
	"juggler/web"
)

// compressTestAsset is an embedded asset well over compressMinSize.
const compressTestAsset = "js/app.js"

func newCompressTestServer(t *testing.T) *Server {
	t.Helper()
	s := &Server{
		router:        mux.NewRouter(),
		staticVersion: "ztest",
		serverAPIs:    serverAPIs{extensionsAPI: handlers.NewExtensionsAPI(fstest.MapFS{}, "", "")},
	}
	s.setupRoutes()
	return s
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip body does not decode: %v", err)
	}
	return out
}

func hasVaryAcceptEncoding(h http.Header) bool {
	for _, v := range h.Values("Vary") {
		for _, f := range strings.Split(v, ",") {
			if strings.EqualFold(strings.TrimSpace(f), "Accept-Encoding") {
				return true
			}
		}
	}
	return false
}

// checkContentLength fails unless Content-Length is absent or names the body
// exactly as sent.
func checkContentLength(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	cl := rec.Header().Get("Content-Length")
	if cl == "" {
		return
	}
	if n, err := strconv.Atoi(cl); err != nil || n != rec.Body.Len() {
		t.Fatalf("Content-Length %q, body is %d bytes", cl, rec.Body.Len())
	}
}

// TestCompressStaticAssets: a remote client that accepts gzip gets a versioned
// embedded asset gzipped (twice, the second from the cache), byte-identical once
// decoded; a loopback client and a remote one that did not ask get it as is.
// Every one of them is told the response varies by Accept-Encoding.
func TestCompressStaticAssets(t *testing.T) {
	want, err := fs.ReadFile(web.Files, compressTestAsset)
	if err != nil {
		t.Fatal(err)
	}
	s := newCompressTestServer(t)
	url := "/vztest/" + compressTestAsset

	get := func(method, remoteAddr, acceptEncoding string, tag bool) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, url, nil)
		req.RemoteAddr = remoteAddr
		if acceptEncoding != "" {
			req.Header.Set("Accept-Encoding", acceptEncoding)
		}
		if tag {
			req = withRemoteIngress(req)
		}
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s %s from %s: status %d", method, url, remoteAddr, rec.Code)
		}
		if !hasVaryAcceptEncoding(rec.Header()) {
			t.Errorf("%s from %s (Accept-Encoding %q): no Vary: Accept-Encoding; got %q", method, remoteAddr, acceptEncoding, rec.Header().Values("Vary"))
		}
		if method != "HEAD" { // a HEAD's Content-Length is its GET's
			checkContentLength(t, rec)
		}
		return rec
	}

	for i, c := range []struct {
		name       string
		remoteAddr string
		tag        bool
	}{
		{"LAN peer", "192.168.1.20:51000", false},
		{"LAN peer, from the cache", "192.168.1.20:51000", false},
		{"remote ingress over loopback", "127.0.0.1:51000", true},
	} {
		rec := get("GET", c.remoteAddr, "br, gzip, deflate", c.tag)
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("case %d (%s): Content-Encoding %q, want gzip", i, c.name, got)
		}
		// Only the cache knows the gzipped length up front; streamed, it is dropped.
		if rec.Header().Get("Content-Length") == "" {
			t.Errorf("case %d (%s): no Content-Length, so not served from the cache", i, c.name)
		}
		if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
			t.Fatalf("case %d (%s): decoded body differs from %s (%d vs %d bytes)", i, c.name, compressTestAsset, len(got), len(want))
		}
		if !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/javascript") {
			t.Errorf("case %d (%s): Content-Type %q", i, c.name, rec.Header().Get("Content-Type"))
		}
	}

	head := get("HEAD", "192.168.1.20:51000", "gzip", false)
	if head.Header().Get("Content-Encoding") != "gzip" || head.Body.Len() != 0 {
		t.Fatalf("HEAD: Content-Encoding %q, %d body bytes", head.Header().Get("Content-Encoding"), head.Body.Len())
	}

	for _, c := range []struct {
		name, remoteAddr, acceptEncoding string
	}{
		{"loopback", "127.0.0.1:51000", "gzip"},
		{"remote without Accept-Encoding", "192.168.1.20:51000", ""},
		{"remote refusing gzip", "192.168.1.20:51000", "gzip;q=0, br"},
	} {
		rec := get("GET", c.remoteAddr, c.acceptEncoding, false)
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Fatalf("%s: Content-Encoding %q, want identity", c.name, got)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Fatalf("%s: body differs from %s", c.name, compressTestAsset)
		}
	}

	// A range request is answered from the file, uncompressed.
	req := httptest.NewRequest("GET", url, nil)
	req.RemoteAddr = "192.168.1.20:51000"
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-99")
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, req)
	if rec.Code != http.StatusPartialContent || rec.Header().Get("Content-Encoding") != "" || !bytes.Equal(rec.Body.Bytes(), want[:100]) {
		t.Fatalf("Range: status %d, Content-Encoding %q, %d bytes", rec.Code, rec.Header().Get("Content-Encoding"), rec.Body.Len())
	}
}

// remoteGzipRequest is a request from a LAN peer that accepts gzip.
func remoteGzipRequest(method, target string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	req.RemoteAddr = "192.168.1.20:51000"
	req.Header.Set("Accept-Encoding", "gzip")
	return req
}

// TestCompressDynamicResponses: an API response is gzipped as it streams, with
// its Content-Length dropped and a strong ETag weakened; a small or
// already-encoded one, or one of a type not worth compressing, goes as is.
func TestCompressDynamicResponses(t *testing.T) {
	s := &Server{}
	big := []byte(`{"items":[` + strings.Repeat(`{"name":"a file","size":1234},`, 200) + `{}]}`)

	serve := func(h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		s.compressMiddleware(h).ServeHTTP(rec, req)
		checkContentLength(t, rec)
		return rec
	}

	// Large JSON, written in pieces with an explicit Content-Length and ETag.
	rec := serve(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(big)))
		w.Header().Set("ETag", `"abc"`)
		_, _ = w.Write(big[:10])
		_, _ = w.Write(big[10:])
	}, remoteGzipRequest("GET", "/api/session"))
	if rec.Header().Get("Content-Encoding") != "gzip" || !bytes.Equal(gunzip(t, rec.Body.Bytes()), big) {
		t.Fatalf("large JSON: Content-Encoding %q", rec.Header().Get("Content-Encoding"))
	}
	if !hasVaryAcceptEncoding(rec.Header()) {
		t.Errorf("large JSON: no Vary")
	}
	if got := rec.Header().Get("ETag"); got != `W/"abc"` {
		t.Errorf("large JSON: ETag %q, want it weakened", got)
	}

	// Large JSON with no Content-Length, in small writes: buffered, then gzipped.
	rec = serve(func(w http.ResponseWriter, r *http.Request) {
		handlers.WriteJSON(w, r, 0, map[string]string{"text": string(big)})
	}, remoteGzipRequest("GET", "/api/ops/call"))
	if rec.Header().Get("Content-Encoding") != "gzip" || !bytes.Contains(gunzip(t, rec.Body.Bytes()), []byte(`a file`)) {
		t.Fatalf("streamed JSON: Content-Encoding %q", rec.Header().Get("Content-Encoding"))
	}

	identity := []struct {
		name string
		h    http.HandlerFunc
	}{
		{"small JSON", func(w http.ResponseWriter, r *http.Request) {
			handlers.WriteJSON(w, r, 0, map[string]bool{"ok": true})
		}},
		{"already encoded", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Content-Encoding", "br")
			_, _ = w.Write(big)
		}},
		{"PNG", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(big)
		}},
		{"not modified", func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotModified)
		}},
	}
	for _, c := range identity {
		rec := serve(c.h, remoteGzipRequest("GET", "/api/x"))
		if got := rec.Header().Get("Content-Encoding"); got == "gzip" {
			t.Errorf("%s: gzipped", c.name)
		}
	}
}

// TestCompressLeavesStreamsAlone: through the middleware, an SSE stream is
// delivered uncompressed and each flush reaches the client as it happens, and
// a WebSocket-style upgrade can still hijack the connection.
func TestCompressLeavesStreamsAlone(t *testing.T) {
	s := &Server{}
	tagRemote := func(h http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			h.ServeHTTP(w, withRemoteIngress(r))
		})
	}
	mux := http.NewServeMux()
	firstSent := make(chan struct{})
	release := make(chan struct{})
	mux.HandleFunc("/api/events", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "data: "+strings.Repeat("x", 2000)+"\n\n")
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("flush: %v", err)
		}
		close(firstSent)
		<-release
	})
	mux.HandleFunc("/ws", func(w http.ResponseWriter, _ *http.Request) {
		conn, rw, err := http.NewResponseController(w).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		defer conn.Close()
		_, _ = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nhello")
		_ = rw.Flush()
	})
	srv := httptest.NewServer(tagRemote(s.compressMiddleware(mux)))
	defer srv.Close()

	// SSE: the first event arrives, as is, while the handler is still running.
	req, _ := http.NewRequest("GET", srv.URL+"/api/events", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	tr := &http.Transport{DisableCompression: true}
	defer tr.CloseIdleConnections()
	res, err := tr.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	<-firstSent
	if got := res.Header.Get("Content-Encoding"); got != "" {
		t.Errorf("SSE: Content-Encoding %q", got)
	}
	line, err := bufio.NewReader(res.Body).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "data: xxx") {
		t.Errorf("SSE: first line %q, err %v", line, err)
	}
	close(release)
	res.Body.Close()

	// Upgrade: the handler hijacks and its raw bytes reach the client.
	conn, err := net.Dial("tcp", srv.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_, _ = io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nAccept-Encoding: gzip\r\n\r\n")
	got, _ := io.ReadAll(conn)
	if !bytes.HasPrefix(got, []byte("HTTP/1.1 101")) || !bytes.HasSuffix(got, []byte("hello")) {
		t.Fatalf("upgrade: got %q", got)
	}
}
