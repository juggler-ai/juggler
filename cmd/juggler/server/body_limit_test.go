//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

// TestBodyLimitExemptsDropUploads pins that the blanket body cap passes a
// dropped-file upload through whole — its handler streams to disk under its
// own cap — while every other body, the asset upload beside it included, is
// still cut off at the cap.
func TestBodyLimitExemptsDropUploads(t *testing.T) {
	const limit = 1024
	read := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, err := io.Copy(io.Discard, r.Body)
		if err != nil {
			w.WriteHeader(http.StatusRequestEntityTooLarge)
			return
		}
		_, _ = w.Write([]byte(strconv.FormatInt(n, 10)))
	})
	h := withBodyLimit(read, limit)
	post := func(method, path string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, bytes.NewReader(make([]byte, 4*limit)))
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr
	}

	if rr := post(http.MethodPost, "/api/session/conversations/c1/drops"); rr.Code != http.StatusOK || rr.Body.String() != strconv.Itoa(4*limit) {
		t.Errorf("drop upload: status %d, body %q; want the whole %d bytes read", rr.Code, rr.Body.String(), 4*limit)
	}
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/session/conversations/c1/assets"},
		{http.MethodPut, "/api/session/conversations/c1/drops"},
		{http.MethodPost, "/api/session/conversations/c1/drops/extra"},
	} {
		if rr := post(c.method, c.path); rr.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s %s: status %d, want the cap's 413", c.method, c.path, rr.Code)
		}
	}
}
