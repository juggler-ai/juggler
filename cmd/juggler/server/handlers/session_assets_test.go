//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
