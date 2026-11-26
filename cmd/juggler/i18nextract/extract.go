//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package i18nextract collects an extension's UI messages into its catalogue,
// as scripts/i18n does for the extensions in this repository, for
// `juggler ext i18n`. The two produce the same en.json and en-XA.json for one
// extension, byte for byte; a test holds every catalogue in the repository to
// that.
//
// The messages are the literal first argument of each call to t() or
// markForTranslation() imported from juggler/i18n (or a module named i18n.js),
// or to a t made by `const t = translator(…)`, keyed `<context>\u0004<source>`
// when the call's options carry a context; the name, description, addLabel,
// eyebrow and setupLabel of each capability's `static MANIFEST`, with a
// workspace provider's recommendations; the manifest's name and its
// settings' labels, help and options; and the name of each identity preset it
// lists. Files under _tests/ are not read.
package i18nextract

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"juggler/cmd/juggler/extmanifest"
	"juggler/cmd/juggler/msg"
)

// ErrNoCatalogue is returned for an extension whose manifest names no
// provides.i18n directory.
var ErrNoCatalogue = errors.New("the manifest names no provides.i18n directory to hold a catalogue")

// Extension is one extension's catalogue directory and the messages its
// source holds.
type Extension struct {
	// Root is the extension directory, as given.
	Root string
	// CatalogDir is Root joined with the manifest's provides.i18n.
	CatalogDir string
	// Messages maps each catalogue key to its English source.
	Messages map[string]string
	// Problems are calls whose message cannot be extracted reliably, each
	// `<file>:<line>: <what is wrong>`.
	Problems []string
}

// CatalogDir is the catalogue directory the manifest at root names: root
// joined with its provides.i18n, which must stay inside root.
func CatalogDir(root string) (string, map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(root, extmanifest.ManifestFileName))
	if err != nil {
		return "", nil, fmt.Errorf("no %s in %s", extmanifest.ManifestFileName, root)
	}
	var manifest map[string]any
	if err := json.Unmarshal(data, &manifest); err != nil {
		return "", nil, fmt.Errorf("invalid manifest: %w", err)
	}
	provides, _ := manifest["provides"].(map[string]any)
	dir, _ := provides["i18n"].(string)
	if dir == "" {
		return "", nil, ErrNoCatalogue
	}
	clean := path.Clean(dir)
	if path.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", nil, fmt.Errorf("provides.i18n %q is outside the extension", dir)
	}
	return filepath.Join(root, filepath.FromSlash(clean)), manifest, nil
}

// Extract collects the messages of the extension at root.
func Extract(root string) (*Extension, error) {
	dir, manifest, err := CatalogDir(root)
	if err != nil {
		return nil, err
	}
	ext := &Extension{Root: root, CatalogDir: dir, Messages: map[string]string{}}
	for _, source := range manifestMessages(manifest) {
		ext.Messages[source] = source
	}
	names, err := presetMessages(root, manifest)
	if err != nil {
		return nil, err
	}
	for _, source := range names {
		ext.Messages[source] = source
	}
	files, err := jsFiles(root)
	if err != nil {
		return nil, err
	}
	for _, rel := range files {
		src, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			return nil, err
		}
		where := filepath.ToSlash(filepath.Join(root, filepath.FromSlash(rel)))
		ext.Problems = append(ext.Problems, extractJS(src, where, ext.Messages)...)
	}
	return ext, nil
}

// jsFiles lists the .js files under root, slash-separated and relative to it,
// sorted, leaving out anything under a _tests directory. Like the readdir walk
// in scripts/i18n it does not descend through a symlinked directory.
func jsFiles(root string) ([]string, error) {
	var out []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".js") {
			return nil
		}
		rel, err := filepath.Rel(root, p)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if !strings.Contains("/"+rel, "/_tests/") {
			out = append(out, rel)
		}
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return utf16Less(out[i], out[j]) })
	return out, err
}

// hasLetter is the test text must pass to be a message rather than a symbol.
var hasLetter = regexp.MustCompile(`[A-Za-z]`)

// manifestMessages is the text an extension manifest shows the user: its name,
// and each setting's label, help and options.
func manifestMessages(manifest map[string]any) []string {
	var out []string
	add := func(v any) {
		if s, ok := v.(string); ok && hasLetter.MatchString(s) {
			out = append(out, s)
		}
	}
	add(manifest["name"])
	settings, _ := manifest["settings"].([]any)
	for _, s := range settings {
		setting, _ := s.(map[string]any)
		add(setting["label"])
		add(setting["help"])
		options, _ := setting["options"].([]any)
		for _, o := range options {
			add(o)
		}
	}
	return out
}

// presetMessages is the name of each identity preset the manifest lists
// (provides.systemPromptPresets), which the preset browser shows translated in
// the extension's catalogue. The files are read as the server reads them
// (extmanifest.ReadPresets), so a file the server would leave out adds
// nothing.
func presetMessages(root string, manifest map[string]any) ([]string, error) {
	provides, _ := manifest["provides"].(map[string]any)
	raw, _ := provides["systemPromptPresets"].([]any)
	var globs []string
	for _, g := range raw {
		if s, ok := g.(string); ok {
			globs = append(globs, s)
		}
	}
	if len(globs) == 0 {
		return nil, nil
	}
	fsys := os.DirFS(root)
	paths, err := extmanifest.ExpandGlobs(fsys, globs)
	if err != nil {
		return nil, err
	}
	presets, _ := extmanifest.ReadPresets(fsys, paths)
	var out []string
	for _, p := range presets {
		if hasLetter.MatchString(p.Name) {
			out = append(out, p.Name)
		}
	}
	return out, nil
}

// Pseudo is the pseudo-locale catalogue for messages.
func Pseudo(messages map[string]string) map[string]string {
	out := make(map[string]string, len(messages))
	for k, v := range messages {
		out[k] = msg.PseudoLocalize(v)
	}
	return out
}
