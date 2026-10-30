//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"image"
	// Register the decoders image.DecodeConfig reads dimensions with, and
	// FitImageForModel decodes with: png/jpeg/gif from the stdlib, webp from
	// x/image (decode only — nothing here encodes webp).
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "golang.org/x/image/webp"

	"juggler/cmd/juggler/core"
	"juggler/internal/atomicio"
)

// AssetStagingGrace is how long a freshly-written asset is protected from the
// GC sweep even when no live doc item references it yet. An attachment is
// uploaded (and its bytes land on disk) BEFORE the user sends the message that
// references it — until send, the only reference is client-side JS state the
// server cannot see. Without this window, any unrelated debounced save during
// composition would reclaim the staged bytes out from under the pending send,
// leaving the just-sent message's <img> pointing at a deleted file (404).
const AssetStagingGrace = 5 * time.Minute

// AssetRef is a small, doc-storable reference to a content-addressed binary
// asset (e.g. an image attached to a message). The bytes themselves live
// out-of-doc under <convDir>/assets/<ID>.<ext>; only this reference is stored
// in the Yjs doc, so attachments are never re-synced to every client or
// re-sent to the model as part of doc state.
type AssetRef struct {
	ID       string `json:"id"`               // lowercase hex SHA-256 of the bytes
	Mime     string `json:"mime"`             // e.g. "image/png"
	Filename string `json:"filename"`         // original/display filename (may be empty)
	Bytes    int    `json:"bytes"`            // size in bytes
	Width    int    `json:"width,omitempty"`  // image width in px (0 if unknown)
	Height   int    `json:"height,omitempty"` // image height in px (0 if unknown)
}

// AssetStore persists per-conversation binary attachments as content-addressed
// files under <convDir>/assets/<sha256>.<ext>.
//
// It mirrors TransactionStore: path resolution is delegated to a
// PathProviderFunc supplied by the session store, so the asset store knows
// nothing about the project path or the per-conversation folder naming scheme.
//
// Writes are idempotent — the filename IS the content hash, so an asset that
// already exists on disk is never rewritten. This gives natural dedup and
// makes concurrent saves of the same bytes safe without any locking (the
// filesystem rename is the only shared mutation, and it is atomic).
type AssetStore struct {
	pathProvider PathProviderFunc
}

// NewAssetStore returns a store backed by the given path provider.
// The <convDir>/assets/ directory is created lazily on Save.
func NewAssetStore(pathProvider PathProviderFunc) *AssetStore {
	return &AssetStore{pathProvider: pathProvider}
}

// dir returns the per-conversation assets directory or "" if the conversation
// is unknown to the path provider.
func (s *AssetStore) dir(convID string) string {
	if s == nil || s.pathProvider == nil {
		return ""
	}
	convDir, ok := s.pathProvider(convID)
	if !ok {
		return ""
	}
	return core.ConvAssetsDir(convDir)
}

// find locates the on-disk file for a sha, returning its full path and the
// file extension (without the leading dot). ok is false if no such asset
// exists. Temp files left by an interrupted write are ignored.
func (s *AssetStore) find(convID, sha string) (path, ext string, ok bool) {
	dir := s.dir(convID)
	if dir == "" {
		return "", "", false
	}
	matches, _ := filepath.Glob(filepath.Join(dir, sha+".*"))
	for _, m := range matches {
		if strings.HasSuffix(m, ".tmp") {
			continue
		}
		return m, strings.TrimPrefix(filepath.Ext(m), "."), true
	}
	return "", "", false
}

// Save writes data to <convDir>/assets/<sha256>.<ext> and returns a reference.
// The write is content-addressed and idempotent: if a file with the same hash
// already exists, the bytes are by definition identical, so the rewrite is
// skipped. Width/Height are populated best-effort by decoding image dimensions
// (png/jpeg/gif/webp; any other format left 0). Returns an error if the conversation
// is unknown to the path provider.
func (s *AssetStore) Save(convID string, data []byte, mime string) (AssetRef, error) {
	sum := sha256.Sum256(data)
	sha := hex.EncodeToString(sum[:])
	ext := extForMime(mime)

	ref := AssetRef{ID: sha, Mime: mime, Bytes: len(data)}
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(data)); err == nil {
		ref.Width = cfg.Width
		ref.Height = cfg.Height
	}

	dir := s.dir(convID)
	if dir == "" {
		return ref, fmt.Errorf("asset store: unknown conversation %q", convID)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return ref, fmt.Errorf("create assets dir: %w", err)
	}
	dst := filepath.Join(dir, sha+"."+ext)
	if _, err := os.Stat(dst); err == nil {
		return ref, nil // already stored — content-addressed dedup
	}
	tmp := dst + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return ref, fmt.Errorf("write asset temp: %w", err)
	}
	if err := atomicio.RobustRename(tmp, dst); err != nil {
		os.Remove(tmp)
		return ref, fmt.Errorf("rename asset: %w", err)
	}
	return ref, nil
}

// Get reads an asset's bytes and resolved mime type. Returns os.ErrNotExist
// if the asset is absent.
func (s *AssetStore) Get(convID, sha string) (data []byte, mime string, err error) {
	p, ext, ok := s.find(convID, sha)
	if !ok {
		return nil, "", os.ErrNotExist
	}
	data, err = os.ReadFile(p)
	if err != nil {
		return nil, "", err
	}
	return data, mimeForExt(ext), nil
}

// Open returns a reader over an asset's bytes plus its resolved mime type, for
// streaming without buffering the whole file. The caller must Close the
// reader. Returns os.ErrNotExist if the asset is absent.
func (s *AssetStore) Open(convID, sha string) (rc *os.File, mime string, err error) {
	p, ext, ok := s.find(convID, sha)
	if !ok {
		return nil, "", os.ErrNotExist
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, "", err
	}
	return f, mimeForExt(ext), nil
}

// Path returns the on-disk path for an asset and whether it exists.
func (s *AssetStore) Path(convID, sha string) (string, bool) {
	p, _, ok := s.find(convID, sha)
	return p, ok
}

// List returns the asset shas currently on disk for a conversation (each file
// basename without its extension). Returns an empty slice (no error) if the
// directory does not exist.
func (s *AssetStore) List(convID string) ([]string, error) {
	dir := s.dir(convID)
	if dir == "" {
		return nil, nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read assets dir: %w", err)
	}
	shas := make([]string, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if strings.HasSuffix(name, ".tmp") {
			continue
		}
		shas = append(shas, strings.TrimSuffix(name, filepath.Ext(name)))
	}
	return shas, nil
}

// Delete removes a single asset. Missing files are not an error. It outlasts
// a read of the asset under way, such as the HTTP handler serving it.
func (s *AssetStore) Delete(convID, sha string) error {
	p, _, ok := s.find(convID, sha)
	if !ok {
		return nil
	}
	if err := atomicio.RobustRemove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete asset: %w", err)
	}
	return nil
}

// DeleteAll removes the entire assets directory for a conversation.
// Used when a conversation is deleted.
func (s *AssetStore) DeleteAll(convID string) error {
	dir := s.dir(convID)
	if dir == "" {
		return nil
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove assets dir: %w", err)
	}
	return nil
}

// CopyAll copies every asset from srcConvID's directory into dstConvID's
// directory. Used when duplicating a conversation so the copy's attachment
// refs still resolve. A missing source directory is not an error.
func (s *AssetStore) CopyAll(srcConvID, dstConvID string) error {
	shas, err := s.List(srcConvID)
	if err != nil {
		return err
	}
	for _, sha := range shas {
		data, mime, err := s.Get(srcConvID, sha)
		if err != nil {
			return fmt.Errorf("read src asset %s: %w", sha, err)
		}
		if _, err := s.Save(dstConvID, data, mime); err != nil {
			return err
		}
	}
	return nil
}

// Sweep deletes any asset whose sha is not in liveSet. Caller is responsible
// for building liveSet from every attachment ref reachable from the live items
// tree (and anything resurrectable via undo, once that is wired).
//
// grace protects freshly-written files: an asset whose on-disk mtime is younger
// than grace is never reclaimed even when unreferenced, covering the window
// between upload and the send that references it (see AssetStagingGrace). Pass 0
// to reclaim unconditionally.
func (s *AssetStore) Sweep(convID string, liveSet map[string]bool, grace time.Duration) error {
	shas, err := s.List(convID)
	if err != nil {
		return err
	}
	cutoff := time.Now().Add(-grace)
	for _, sha := range shas {
		if liveSet[sha] {
			continue
		}
		if grace > 0 {
			if p, ok := s.Path(convID, sha); ok {
				if fi, err := os.Stat(p); err == nil && fi.ModTime().After(cutoff) {
					continue // staged but not yet referenced — keep within grace
				}
			}
		}
		if err := s.Delete(convID, sha); err != nil {
			return err
		}
	}
	return nil
}

// TextAssetMime is the type a stored text asset carries: UTF-8 plain text, such
// as one side of an edit's diff. It is kept as a .txt file.
const TextAssetMime = "text/plain"

// extForMime maps a supported mime type to its on-disk file extension.
// Unknown types fall back to "bin".
func extForMime(mime string) string {
	switch mime {
	case TextAssetMime:
		return "txt"
	case "image/png":
		return "png"
	case "image/jpeg":
		return "jpeg"
	case "image/gif":
		return "gif"
	case "image/webp":
		return "webp"
	default:
		return "bin"
	}
}

// mimeForExt maps a stored file extension back to its mime type. Unknown
// extensions fall back to a generic binary type.
func mimeForExt(ext string) string {
	switch strings.ToLower(ext) {
	case "txt":
		return TextAssetMime
	case "png":
		return "image/png"
	case "jpeg", "jpg":
		return "image/jpeg"
	case "gif":
		return "image/gif"
	case "webp":
		return "image/webp"
	default:
		return "application/octet-stream"
	}
}
