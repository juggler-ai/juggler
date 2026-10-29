//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// dialViewerAs opens a real viewer WebSocket presenting the given viewer id
// (verbatim, so a malformed one reaches the server as written) and returns the
// connect frame.
func dialViewerAs(t *testing.T, ts *httptest.Server, viewerID string) (*websocket.Conn, sessionFrame) {
	t.Helper()
	dialURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=viewer&viewerId=" + url.QueryEscape(viewerID)
	conn, resp, err := websocket.DefaultDialer.Dial(dialURL, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("viewer WS dial failed: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no session frame reached the viewer: %v", err)
		}
		var frame sessionFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type == "session" {
			return conn, frame
		}
	}
}

// TestSanitiseViewerID pins the alphabet. The id is chosen by the client and
// handed on to the other viewers, so anything ambiguous is refused outright
// rather than escaped somewhere downstream and forgotten about.
func TestSanitiseViewerID(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"a minted id", "v_0123456789abcdef0123456789abcdef", "v_0123456789abcdef0123456789abcdef"},
		{"letters digits dash underscore", "Aa0-_z", "Aa0-_z"},
		{"empty", "", ""},
		{"at the length cap", strings.Repeat("a", maxViewerIDLen), strings.Repeat("a", maxViewerIDLen)},
		{"one over the cap", strings.Repeat("a", maxViewerIDLen+1), ""},
		{"a space", "v_ 1", ""},
		{"a dot", "v.1", ""},
		{"a slash", "v/1", ""},
		{"a quote", `v"1`, ""},
		{"an angle bracket", "v<1", ""},
		{"non-ascii", "v_é", ""},
		{"a null byte", "v_\x001", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitiseViewerID(tc.in); got != tc.want {
				t.Errorf("sanitiseViewerID(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// TestViewerSocket_ViewerIDSurvivesAReconnect is the whole point of having a
// viewer id at all: the server-assigned client id is new on every connection, so
// anything holding it would lose track of a viewer that merely reloaded. The id
// the viewer names itself by is the one that stays put.
func TestViewerSocket_ViewerIDSurvivesAReconnect(t *testing.T) {
	_, ts := newViewerSocketServer(t)
	const id = "v_0123456789abcdef0123456789abcdef"

	first, firstFrame := dialViewerAs(t, ts, id)
	if firstFrame.ViewerID != id {
		t.Fatalf("connect frame carried viewerId %q, want %q", firstFrame.ViewerID, id)
	}
	_ = first.Close()

	_, secondFrame := dialViewerAs(t, ts, id)
	if secondFrame.ViewerID != id {
		t.Fatalf("after reconnect the viewer id was %q, want %q", secondFrame.ViewerID, id)
	}
	if secondFrame.ClientID == "" || secondFrame.ClientID == firstFrame.ClientID {
		t.Fatalf("the reconnect reused client id %q; the two ids are meant to differ in exactly this case", secondFrame.ClientID)
	}
}

// TestViewerSocket_MalformedViewerIDIsNotAdopted: a rejected id is reported back
// as empty rather than silently kept, so a viewer can tell that nothing can
// address it instead of handing out a name that reaches nobody.
func TestViewerSocket_MalformedViewerIDIsNotAdopted(t *testing.T) {
	_, ts := newViewerSocketServer(t)
	_, frame := dialViewerAs(t, ts, "not a valid id")
	if frame.ViewerID != "" {
		t.Fatalf("a malformed viewer id was adopted as %q, want it dropped", frame.ViewerID)
	}
	if frame.ClientID == "" {
		t.Fatal("the connection was refused; a bad viewer id costs the id, not the connection")
	}
}

// TestViewerSocket_NoViewerIDIsAccepted: the id is optional. A viewer that sends
// none connects normally and is simply not addressable.
func TestViewerSocket_NoViewerIDIsAccepted(t *testing.T) {
	_, ts := newViewerSocketServer(t)
	conn := dialViewer(t, ts)
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no session frame reached the viewer: %v", err)
		}
		var frame sessionFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type != "session" {
			continue
		}
		if frame.ViewerID != "" {
			t.Fatalf("a viewer that sent no id was given %q", frame.ViewerID)
		}
		if frame.ClientID == "" {
			t.Fatal("the connect frame carried no client id")
		}
		return
	}
}

// TestClientHub_DescriptorsCarryTheViewerID: a viewer holding another's id needs
// to know whether it is still connected, and clients-changed is where it looks.
func TestClientHub_DescriptorsCarryTheViewerID(t *testing.T) {
	h := newClientHub()
	defer h.shutdown()

	first := testRoleClient("c1", ClientRoleViewer, "local")
	first.viewerID = "v_first"
	if !h.register(first) {
		t.Fatal("the hub refused the first viewer")
	}
	<-first.send // its own join

	second := testRoleClient("c2", ClientRoleViewer, "local")
	second.viewerID = "v_second"
	if !h.register(second) {
		t.Fatal("the hub refused the second viewer")
	}

	_, list := nextClientsChanged(t, first)
	byID := map[string]string{}
	for _, d := range list {
		byID[d.ID] = d.ViewerID
	}
	if byID["c1"] != "v_first" || byID["c2"] != "v_second" {
		t.Fatalf("descriptors carried viewer ids %v, want c1=v_first c2=v_second", byID)
	}
}

// TestViewerSocket_PopOutNamesItsOwner: a detached pinboard window connects as
// an ordinary viewer, so the descriptor is the only place the other viewers can
// learn it belongs to a window already counted — and not count it again. A
// malformed owner is dropped, as a malformed viewer id is.
func TestViewerSocket_PopOutNamesItsOwner(t *testing.T) {
	_, ts := newViewerSocketServer(t)
	for _, tc := range []struct{ name, owner, want string }{
		{"a valid owner", "v_owner", "v_owner"},
		{"a malformed owner", "not valid", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			self := "v_popout_" + strings.ReplaceAll(tc.name, " ", "_")
			dialURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=viewer&viewerId=" +
				url.QueryEscape(self) + "&owner=" + url.QueryEscape(tc.owner)
			conn, resp, err := websocket.DefaultDialer.Dial(dialURL, nil)
			if resp != nil {
				_ = resp.Body.Close()
			}
			if err != nil {
				t.Fatalf("viewer WS dial failed: %v", err)
			}
			defer func() { _ = conn.Close() }()

			_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for {
				_, msgBytes, err := conn.ReadMessage()
				if err != nil {
					t.Fatalf("no clients-changed naming this viewer arrived: %v", err)
				}
				var frame struct {
					Type    string             `json:"type"`
					Clients []clientDescriptor `json:"clients"`
				}
				if json.Unmarshal(msgBytes, &frame) != nil || frame.Type != "clients-changed" {
					continue
				}
				for _, d := range frame.Clients {
					if d.ViewerID == self {
						if d.OwnerViewerID != tc.want {
							t.Fatalf("descriptor carried owner %q, want %q", d.OwnerViewerID, tc.want)
						}
						return
					}
				}
			}
		})
	}
}

// TestClientHub_DescriptorOmitsAnAbsentViewerID: a client with no id of its own
// leaves the field off the wire rather than publishing an empty name others
// might try to address.
func TestClientHub_DescriptorOmitsAnAbsentViewerID(t *testing.T) {
	d := clientDescriptor{ID: "c1", Origin: "local"}
	encoded, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(encoded), "viewerId") {
		t.Fatalf("an absent viewer id was serialised anyway: %s", encoded)
	}
}
