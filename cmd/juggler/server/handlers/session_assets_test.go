//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/gorilla/mux"
)

// assetUpload posts body to the asset upload handler with the given content type.
func assetUpload(api *SessionAPI, convID, contentType string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/session/conversations/"+convID+"/assets", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	req = mux.SetURLVars(req, map[string]string{"convId": convID})
	rr := httptest.NewRecorder()
	api.HandleUploadAsset(rr, req)
	return rr
}

// assetGet fetches one stored asset through the GET handler.
func assetGet(api *SessionAPI, convID, sha string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/"+convID+"/assets/"+sha, nil)
	req = mux.SetURLVars(req, map[string]string{"convId": convID, "sha": sha})
	rr := httptest.NewRecorder()
	api.HandleGetAsset(rr, req)
	return rr
}

// TestAssetRoutes_TextRoundTrip pins that a UTF-8 text body — a side of an edit's
// diff — is stored and served back byte for byte as text, under the same
// content-addressed id an identical upload gets.
func TestAssetRoutes_TextRoundTrip(t *testing.T) {
	api, convID := newProgramsFixture(t)
	text := []byte("package main\n\nfunc main() { println(\"héllo\") }\n")

	rr := assetUpload(api, convID, "text/plain; charset=utf-8", text)
	wantStatus(t, "upload", rr, http.StatusOK)
	var ref struct {
		ID    string `json:"id"`
		Mime  string `json:"mime"`
		Bytes int    `json:"bytes"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &ref); err != nil {
		t.Fatalf("upload answer is not an AssetRef: %v (%q)", err, rr.Body.String())
	}
	if len(ref.ID) != 64 || ref.Mime != "text/plain" || ref.Bytes != len(text) {
		t.Fatalf("ref = %+v, want a 64-hex id, mime text/plain, %d bytes", ref, len(text))
	}

	got := assetGet(api, convID, ref.ID)
	wantStatus(t, "get", got, http.StatusOK)
	body, _ := io.ReadAll(got.Body)
	if !bytes.Equal(body, text) {
		t.Fatalf("served %q, want %q", body, text)
	}
	if ct := got.Header().Get("Content-Type"); ct != "text/plain; charset=utf-8" {
		t.Fatalf("served Content-Type %q, want text/plain; charset=utf-8", ct)
	}
}

// deniedSendfileWriter stands in for net/http's response: ReadFrom copies
// sniff bytes the ordinary way, then fails with EPERM as a sandboxed sendfile
// does. A zero sniff is the denial arriving before any byte moved.
type deniedSendfileWriter struct {
	*httptest.ResponseRecorder
	sniff int64
}

func (w *deniedSendfileWriter) ReadFrom(r io.Reader) (int64, error) {
	n, err := io.Copy(w.ResponseRecorder, io.LimitReader(r, w.sniff))
	if err != nil {
		return n, err
	}
	return n, &os.SyscallError{Syscall: "sendfile", Err: fs.ErrPermission}
}

// TestAssetRoutes_SendfileDeniedFallsBack checks that complete and ranged
// asset reads survive a sendfile denial, whether or not bytes moved first.
func TestAssetRoutes_SendfileDeniedFallsBack(t *testing.T) {
	api, convID := newProgramsFixture(t)
	body := bytes.Repeat([]byte("source line héllo\n"), 120000)
	upload := assetUpload(api, convID, "text/plain", body)
	wantStatus(t, "upload", upload, http.StatusOK)
	var ref struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(upload.Body.Bytes(), &ref); err != nil || len(ref.ID) != 64 {
		t.Fatalf("upload ref = %+v, error = %v", ref, err)
	}

	get := func(rangeHeader string, sniff int64) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/session/conversations/"+convID+"/assets/"+ref.ID, nil)
		req = mux.SetURLVars(req, map[string]string{"convId": convID, "sha": ref.ID})
		if rangeHeader != "" {
			req.Header.Set("Range", rangeHeader)
		}
		w := &deniedSendfileWriter{ResponseRecorder: httptest.NewRecorder(), sniff: sniff}
		api.HandleGetAsset(w, req)
		return w.ResponseRecorder
	}

	for _, sniff := range []int64{0, 512} {
		t.Run(fmt.Sprintf("sniff=%d", sniff), func(t *testing.T) {
			full := get("", sniff)
			wantStatus(t, "full GET", full, http.StatusOK)
			if !bytes.Equal(full.Body.Bytes(), body) {
				t.Errorf("full GET body differs: got %d bytes, want %d", full.Body.Len(), len(body))
			}
			for name, want := range map[string]string{
				"Content-Type":           "text/plain; charset=utf-8",
				"Cache-Control":          "public, max-age=31536000, immutable",
				"X-Content-Type-Options": "nosniff",
			} {
				if got := full.Header().Get(name); got != want {
					t.Errorf("%s = %q, want %q", name, got, want)
				}
			}

			const start, end = 65530, 131100
			partial := get(fmt.Sprintf("bytes=%d-%d", start, end), sniff)
			wantStatus(t, "range GET", partial, http.StatusPartialContent)
			if !bytes.Equal(partial.Body.Bytes(), body[start:end+1]) {
				t.Errorf("range body differs: got %d bytes, want %d", partial.Body.Len(), end-start+1)
			}
			if got, want := partial.Header().Get("Content-Range"), fmt.Sprintf("bytes %d-%d/%d", start, end, len(body)); got != want {
				t.Errorf("Content-Range = %q, want %q", got, want)
			}
		})
	}
}

// TestAssetRoutes_RefusesWhatIsNotText pins the text path's validation: bytes
// that are not valid UTF-8 are refused, as is any type that is neither an
// image nor plain text. The image path is untouched by it.
func TestAssetRoutes_RefusesWhatIsNotText(t *testing.T) {
	api, convID := newProgramsFixture(t)

	wantStatus(t, "invalid UTF-8", assetUpload(api, convID, "text/plain", []byte{'a', 0xff, 0xfe, 'b'}), http.StatusBadRequest)
	wantStatus(t, "text/html", assetUpload(api, convID, "text/html", []byte("<b>x</b>")), http.StatusBadRequest)
	wantStatus(t, "other charset", assetUpload(api, convID, "text/plain; charset=latin1", []byte("x")), http.StatusBadRequest)
	wantStatus(t, "empty text", assetUpload(api, convID, "text/plain", nil), http.StatusBadRequest)
	wantStatus(t, "image still accepted", assetUpload(api, convID, "image/png", []byte("not really a png")), http.StatusOK)
}
