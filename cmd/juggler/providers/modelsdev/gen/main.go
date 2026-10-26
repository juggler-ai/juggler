//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Command gen refreshes the models.dev snapshot compiled into Juggler: it
// fetches the catalogue, trims it (modelsdev.Trim) and writes snapshot.json,
// then prints what changed so the refresh can be reviewed before it is
// committed. Run it through `make models-sync`, or `go generate` in the
// package directory.
//
// It is a development tool: it is not linked into the app, which never
// contacts models.dev.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"

	"juggler/cmd/juggler/providers/modelsdev"
	"juggler/internal/httpx"
)

const (
	defaultSource = "https://models.dev/api.json"
	// The catalogue was about 6 MB in October 2026 and grows; the cap is a
	// guard against a broken response, not a budget.
	maxBody = 64 << 20
)

func main() {
	out := flag.String("o", "snapshot.json", "snapshot file to write")
	source := flag.String("url", defaultSource, "models.dev api.json to fetch")
	from := flag.String("from", "", "read api.json from this file instead of fetching (the snapshot still records -url as its source)")
	raw := flag.String("raw", "", "also keep the untrimmed api.json here, for the drift audit of the built-in tables (TestModelsDevDrift)")
	flag.Parse()

	if err := run(*out, *source, *from, *raw); err != nil {
		fmt.Fprintf(os.Stderr, "models-sync: %v\n", err)
		os.Exit(1)
	}
}

func run(out, source, from, keepRaw string) error {
	raw, err := load(source, from)
	if err != nil {
		return err
	}
	if keepRaw != "" {
		if err := os.MkdirAll(filepath.Dir(keepRaw), 0o755); err != nil {
			return err
		}
		if err := writeAtomic(keepRaw, raw); err != nil {
			return err
		}
	}
	next, err := modelsdev.Trim(raw, source, time.Now().UTC().Format(time.DateOnly))
	if err != nil {
		return err
	}
	encoded, err := next.Encode()
	if err != nil {
		return err
	}

	var prev modelsdev.Snapshot
	if old, err := os.ReadFile(out); err == nil {
		// A previous file that does not decode is reported as all-new rather
		// than blocking the refresh that replaces it.
		_ = json.Unmarshal(old, &prev)
	}

	if err := writeAtomic(out, encoded); err != nil {
		return err
	}
	report(os.Stdout, prev, next, len(encoded))
	return nil
}

func load(source, from string) ([]byte, error) {
	if from != "" {
		return os.ReadFile(from)
	}
	req, err := http.NewRequest(http.MethodGet, source, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "juggler-models-sync")
	resp, err := httpx.Client(2 * time.Minute).Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching %s: %w", source, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetching %s: %s", source, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody+1))
	if err != nil {
		return nil, fmt.Errorf("reading %s: %w", source, err)
	}
	if len(body) > maxBody {
		return nil, fmt.Errorf("%s is larger than %d bytes; raise maxBody if that is expected", source, maxBody)
	}
	return body, nil
}

func writeAtomic(path string, data []byte) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".snapshot-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// CreateTemp makes the file owner-only; this one is a source file.
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

// report prints the refresh's summary: totals, then each provider added or
// removed and each model whose limits or modalities changed. A model merely
// added or removed under a known provider is counted, not listed — those are
// the bulk of every refresh and the diff names them anyway.
func report(w io.Writer, prev, next modelsdev.Snapshot, size int) {
	models := 0
	for _, p := range next.Providers {
		models += len(p.Models)
	}
	fmt.Fprintf(w, "models.dev snapshot %s: %d providers, %d models, %d KB\n", next.Fetched, len(next.Providers), models, size/1024)
	if prev.Providers == nil {
		return
	}

	var lines []string
	added, removed, changed := 0, 0, 0
	for id, np := range next.Providers {
		op, existed := prev.Providers[id]
		if !existed {
			lines = append(lines, fmt.Sprintf("  + provider %s (%s, %d models)", id, np.API, len(np.Models)))
			continue
		}
		if op.API != np.API {
			lines = append(lines, fmt.Sprintf("  ~ provider %s base URL %s → %s", id, op.API, np.API))
		}
		for mid, nm := range np.Models {
			om, had := op.Models[mid]
			switch {
			case !had:
				added++
			case om.Context != nm.Context || om.Output != nm.Output || fmt.Sprint(om.Input) != fmt.Sprint(nm.Input):
				changed++
				lines = append(lines, fmt.Sprintf("  ~ %s/%s %s → %s", id, mid, describe(om), describe(nm)))
			}
		}
		for mid := range op.Models {
			if _, kept := np.Models[mid]; !kept {
				removed++
			}
		}
	}
	for id, op := range prev.Providers {
		if _, kept := next.Providers[id]; !kept {
			lines = append(lines, fmt.Sprintf("  - provider %s (%d models)", id, len(op.Models)))
		}
	}
	sort.Strings(lines)
	fmt.Fprintf(w, "since %s: %d models added, %d removed, %d changed\n", prev.Fetched, added, removed, changed)
	for _, l := range lines {
		fmt.Fprintln(w, l)
	}
}

func describe(m modelsdev.Model) string {
	return fmt.Sprintf("%d/%d %v", m.Context, m.Output, m.InputModalities())
}
