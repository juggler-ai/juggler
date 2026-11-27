//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// The preview's bounds in core: lines shown, and archive entries listed.
const (
	previewLines   = 20
	previewEntries = 50
)

// dropUpload posts body to the drop handler under filename.
func dropUpload(api *SessionAPI, convID, filename string, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/api/session/conversations/"+convID+"/drops", bytes.NewReader(body))
	req.Header.Set(DropFilenameHeader, url.PathEscape(filename))
	req = mux.SetURLVars(req, map[string]string{"convId": convID})
	rr := httptest.NewRecorder()
	api.HandleUploadDrop(rr, req)
	return rr
}

func decodeDropRef(t *testing.T, rr *httptest.ResponseRecorder) core.DropRef {
	t.Helper()
	wantStatus(t, "upload", rr, http.StatusOK)
	var ref core.DropRef
	if err := json.Unmarshal(rr.Body.Bytes(), &ref); err != nil {
		t.Fatalf("answer is not a core.DropRef: %v (%q)", err, rr.Body.String())
	}
	return ref
}

// dropsDirEntries lists the drops folder's top level.
func dropsDirEntries(t *testing.T, api *SessionAPI) []string {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(api.manager().GetProjectPath(), core.DropsDirName))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	return names
}

// TestHandleUploadDrop_StoresTextWithPreview pins a text drop's whole answer:
// stored byte for byte at the content-addressed project path it names, in a
// folder that ignores itself in git, with its line count and first lines.
func TestHandleUploadDrop_StoresTextWithPreview(t *testing.T) {
	api, convID := newProgramsFixture(t)
	var body strings.Builder
	body.WriteString("id,name\n")
	for i := range 30000 {
		fmt.Fprintf(&body, "%d,row %d\n", i, i)
	}
	data := []byte(body.String())

	ref := decodeDropRef(t, dropUpload(api, convID, "sales 2025.csv", data))

	sum := sha256.Sum256(data)
	wantSHA := hex.EncodeToString(sum[:])
	wantPath := ".juggler-drops/" + wantSHA[:12] + "/sales 2025.csv"
	if ref.Path != wantPath || ref.SHA256 != wantSHA || ref.Bytes != int64(len(data)) || ref.Filename != "sales 2025.csv" {
		t.Fatalf("ref = %+v, want path %q, sha %s, %d bytes", ref, wantPath, wantSHA, len(data))
	}
	project := api.manager().GetProjectPath()
	if ref.AbsPath != filepath.Join(project, filepath.FromSlash(wantPath)) {
		t.Errorf("absPath %q is not the project path %q", ref.AbsPath, wantPath)
	}
	stored, err := os.ReadFile(ref.AbsPath)
	if err != nil || !bytes.Equal(stored, data) {
		t.Fatalf("stored file differs (err %v, %d bytes, want %d)", err, len(stored), len(data))
	}
	ignore, err := os.ReadFile(filepath.Join(project, core.DropsDirName, ".gitignore"))
	if err != nil || !strings.Contains(string(ignore), "\n*\n") {
		t.Errorf("drops .gitignore = %q (%v), want one ignoring everything", ignore, err)
	}

	p := ref.Preview
	if !p.Text || p.Lines != 30001 {
		t.Errorf("preview text=%v lines=%d, want text with 30001 lines", p.Text, p.Lines)
	}
	headLines := strings.Split(strings.TrimSuffix(p.Head, "\n"), "\n")
	if len(headLines) != previewLines || headLines[0] != "id,name" || headLines[1] != "0,row 0" {
		t.Errorf("preview head has %d lines starting %q, want %d from the header", len(headLines), headLines[:2], previewLines)
	}
}

// TestHandleUploadDrop_SameBytesOneFile pins that dropping the same file twice
// answers the same path and leaves one file and no upload temporaries.
func TestHandleUploadDrop_SameBytesOneFile(t *testing.T) {
	api, convID := newProgramsFixture(t)
	data := []byte("same bytes\n")
	first := decodeDropRef(t, dropUpload(api, convID, "a.txt", data))
	second := decodeDropRef(t, dropUpload(api, convID, "a.txt", data))
	if first.AbsPath != second.AbsPath {
		t.Fatalf("second drop at %q, first at %q", second.AbsPath, first.AbsPath)
	}
	if got := dropsDirEntries(t, api); len(got) != 2 { // .gitignore + one hash folder
		t.Errorf("drops folder holds %q, want .gitignore and one folder", got)
	}
}

// TestHandleUploadDrop_OverCapLeavesNothing pins that a body past the cap is
// refused with a 413 and leaves no partial file behind, whether the length is
// declared up front or only discovered while streaming.
func TestHandleUploadDrop_OverCapLeavesNothing(t *testing.T) {
	api, convID := newProgramsFixture(t)
	old := maxDropBytes
	maxDropBytes = 1024
	t.Cleanup(func() { maxDropBytes = old })

	wantStatus(t, "declared over", dropUpload(api, convID, "big.bin", make([]byte, 2048)), http.StatusRequestEntityTooLarge)

	req := httptest.NewRequest(http.MethodPost, "/api/session/conversations/"+convID+"/drops", bytes.NewReader(make([]byte, 2048)))
	req.ContentLength = -1 // streamed: only the copy finds it is too large
	req = mux.SetURLVars(req, map[string]string{"convId": convID})
	rr := httptest.NewRecorder()
	api.HandleUploadDrop(rr, req)
	wantStatus(t, "streamed over", rr, http.StatusRequestEntityTooLarge)

	if got := dropsDirEntries(t, api); len(got) != 1 || got[0] != ".gitignore" {
		t.Errorf("drops folder holds %q after refusals, want only .gitignore", got)
	}
	wantStatus(t, "empty", dropUpload(api, convID, "e.txt", nil), http.StatusBadRequest)
}

// TestHandleUploadDrop_PreviewsBinaryAndZip pins the preview of what is not
// text: a binary file says only its type, and a zip lists its entries.
func TestHandleUploadDrop_PreviewsBinaryAndZip(t *testing.T) {
	api, convID := newProgramsFixture(t)

	bin := decodeDropRef(t, dropUpload(api, convID, "blob.bin", []byte{0x01, 0x00, 0x02, 0xff}))
	if bin.Preview.Text || bin.Preview.Head != "" || bin.Preview.Mime != "application/octet-stream" {
		t.Errorf("binary preview = %+v, want non-text application/octet-stream", bin.Preview)
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for i := range previewEntries + 5 {
		f, _ := zw.Create(fmt.Sprintf("dir/file%02d.txt", i))
		_, _ = f.Write([]byte("x"))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	z := decodeDropRef(t, dropUpload(api, convID, "bundle.zip", buf.Bytes()))
	if z.Preview.Mime != "application/zip" || z.Preview.EntryCount != previewEntries+5 ||
		len(z.Preview.Entries) != previewEntries || z.Preview.Entries[0] != "dir/file00.txt" {
		t.Errorf("zip preview = %+v, want %d of %d entries listed", z.Preview, previewEntries, previewEntries+5)
	}
}
