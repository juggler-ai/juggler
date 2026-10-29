//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package modelsdev

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
)

// textOnly reports whether a sorted modality list says text and nothing else,
// the case Model leaves empty.
func textOnly(input []string) bool {
	return len(input) == 0 || (len(input) == 1 && input[0] == "text")
}

// Encode writes a snapshot as snapshot.json: valid JSON, keys sorted, and one
// line per model, so that a refresh reads in a diff as the models it changed.
func (s Snapshot) Encode() ([]byte, error) {
	var b bytes.Buffer
	b.WriteString("{\n")
	fmt.Fprintf(&b, "  \"source\": %s,\n", mustJSON(s.Source))
	fmt.Fprintf(&b, "  \"fetched\": %s,\n", mustJSON(s.Fetched))
	b.WriteString("  \"providers\": {")
	for i, id := range sortedKeys(s.Providers) {
		p := s.Providers[id]
		if i > 0 {
			b.WriteByte(',')
		}
		fmt.Fprintf(&b, "\n    %s: {\n", mustJSON(id))
		fmt.Fprintf(&b, "      \"name\": %s,\n", mustJSON(p.Name))
		fmt.Fprintf(&b, "      \"api\": %s,\n", mustJSON(p.API))
		if p.Doc != "" {
			fmt.Fprintf(&b, "      \"doc\": %s,\n", mustJSON(p.Doc))
		}
		b.WriteString("      \"models\": {")
		for j, mid := range sortedKeys(p.Models) {
			if j > 0 {
				b.WriteByte(',')
			}
			line, err := json.Marshal(p.Models[mid])
			if err != nil {
				return nil, err
			}
			fmt.Fprintf(&b, "\n        %s: %s", mustJSON(mid), line)
		}
		b.WriteString("\n      }\n    }")
	}
	b.WriteString("\n  }\n}\n")
	return b.Bytes(), nil
}

func decodeSnapshot(data []byte) (Snapshot, error) {
	var s Snapshot
	if err := json.Unmarshal(data, &s); err != nil {
		return Snapshot{}, fmt.Errorf("decoding models.dev snapshot: %w", err)
	}
	return s, nil
}

// mustJSON encodes a string as a JSON string literal; strings always encode.
func mustJSON(s string) string {
	out, _ := json.Marshal(s)
	return string(out)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
