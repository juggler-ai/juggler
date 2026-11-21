//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"os"
	"strings"
)

// ImportSource names the transcript an imported conversation was made from:
// which tool wrote it (Kind, e.g. "claude-code"), that tool's own id for it,
// and a digest of the content that was imported. The same Kind and ID with a
// different Digest is the same session grown since, which imports again as a
// conversation of its own rather than overwriting what the user has done with
// the first.
type ImportSource struct {
	Kind   string `json:"kind"`
	ID     string `json:"id"`
	Digest string `json:"digest"`
}

// Key is the identity a re-import is recognised by.
func (s ImportSource) Key() string { return s.Kind + "\x00" + s.ID + "\x00" + s.Digest }

// Valid reports whether every field is set, which is what makes an import
// recognisable when it is offered again.
func (s ImportSource) Valid() bool {
	return strings.TrimSpace(s.Kind) != "" && strings.TrimSpace(s.ID) != "" && strings.TrimSpace(s.Digest) != ""
}

// WriteImportedConversation fills a just-created conversation folder with an
// imported conversation: its document, and the record of which transcript it
// was made from. The record is what a later import of the same transcript
// finds (ImportedSources), so it is a file of its own rather than a key in the
// document: answering "was this imported already" for every conversation of a
// project then costs a small read each, not a full document decode.
func WriteImportedConversation(convDir string, doc []byte, src ImportSource) error {
	if err := os.WriteFile(ConvDocPath(convDir), doc, 0o644); err != nil {
		return err
	}
	data, err := json.Marshal(src)
	if err != nil {
		return err
	}
	return os.WriteFile(ConvImportRecordPath(convDir), data, 0o644)
}

// readConvImportRecord returns the folder's import record, ok=false when it
// has none or it cannot be read as one.
func readConvImportRecord(convDir string) (ImportSource, bool) {
	data, err := os.ReadFile(ConvImportRecordPath(convDir))
	if err != nil {
		return ImportSource{}, false
	}
	var src ImportSource
	if json.Unmarshal(data, &src) != nil || !src.Valid() {
		return ImportSource{}, false
	}
	return src, true
}

// ImportedSources maps the Key of every transcript this project has imported
// to the conversation made from it — open ones and binned ones alike, since a
// conversation the user binned was imported all the same and offering it
// again would bring back what they threw away.
func (m *SessionManager) ImportedSources() map[string]string {
	dirs, _ := runRead(m, func(s *sessionState) (map[string]string, error) {
		out := map[string]string{}
		for _, idx := range []*ConvDirIndex{s.store.index, s.store.binIndex} {
			if idx == nil {
				continue
			}
			for id, dir := range idx.ByID {
				out[id] = dir
			}
		}
		return out, nil
	})
	// Read outside the actor: one small file per conversation.
	found := map[string]string{}
	for id, dir := range dirs {
		if src, ok := readConvImportRecord(dir); ok {
			found[src.Key()] = id
		}
	}
	return found
}

// RoomForConversations is how many more conversations the session can open
// before it reaches MaxConversations.
func (m *SessionManager) RoomForConversations() int {
	n, _ := runRead(m, func(s *sessionState) (int, error) {
		return MaxConversations - len(s.session.ConversationOrder), nil
	})
	return max(n, 0)
}
