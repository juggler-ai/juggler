//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math/big"
	"strconv"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/web"
)

// versionedAssetRoots are the directories of web.Files served under
// /v<staticVersion>/ (setupRoutes mounts one route per root). The embedded
// test tree, web.TestFiles, adds testAssetRoot beside them.
var versionedAssetRoots = []string{"css", "js", "extensions", "sdk", "resources", "machine"}

// testAssetRoot is the directory of web.TestFiles served under
// /v<staticVersion>/ in a test-capable build.
const testAssetRoot = "js-tests"

// mintStaticVersion returns the cache-busting segment of every asset URL, /v<version>/.
//
// Served from the embedded tree, assets are cached immutable for a year, so the
// version must change whenever any byte served beneath it does, and should not
// change otherwise: it is a hash of exactly the trees those routes serve —
// web.Files (the embed with any SetOverlay overlay merged in) and web.TestFiles —
// and of the build, so a restart of the same build keeps the browser's cache.
// It is computed on every call, so call it once, after SetOverlay.
//
// Served from disk, files change under a running server and nothing is cached,
// so the version is random per process instead. A tree that cannot be read
// falls back to random too: a version that never hits the cache is merely
// slow, where a stale one would serve old code for a year.
func mintStaticVersion(assetsFromDisk bool) string {
	if assetsFromDisk {
		return generateStaticVersion()
	}
	v, err := hashStaticVersion(core.Version+" "+core.Commit,
		versionedTree{fsys: web.Files, roots: versionedAssetRoots},
		versionedTree{fsys: web.TestFiles, roots: []string{testAssetRoot}},
	)
	if err != nil {
		jlog.Error("Could not hash the static assets, so their URLs change on every restart: %v", err)
		return generateStaticVersion()
	}
	return v
}

// versionedTree is a file tree and the directories of it that are served.
type versionedTree struct {
	fsys  fs.FS
	roots []string
}

// hashStaticVersion returns a version naming the contents of trees and salt:
// a truncated SHA-256 over every regular file under each tree's roots — its
// tree's position, its path and the SHA-256 of its content — walked in the
// lexical order fs.WalkDir gives. Each file's content is hashed separately so
// the outer stream is unambiguous. A root a tree lacks contributes nothing.
func hashStaticVersion(salt string, trees ...versionedTree) (string, error) {
	h := sha256.New()
	_, _ = io.WriteString(h, salt+"\x00")
	for i, tree := range trees {
		for _, root := range tree.roots {
			_, _ = io.WriteString(h, strconv.Itoa(i)+"\x00"+root+"\x00")
			err := fs.WalkDir(tree.fsys, root, func(p string, d fs.DirEntry, err error) error {
				if err != nil {
					if p == root && errors.Is(err, fs.ErrNotExist) {
						return fs.SkipDir
					}
					return err
				}
				if d.IsDir() {
					return nil
				}
				sum, err := hashFile(tree.fsys, p)
				if err != nil {
					return err
				}
				_, _ = io.WriteString(h, p+"\x00")
				_, _ = h.Write(sum)
				return nil
			})
			if err != nil {
				return "", fmt.Errorf("hash %s: %w", root, err)
			}
		}
	}
	return hex.EncodeToString(h.Sum(nil)[:5]), nil
}

// hashFile returns the SHA-256 of the named file's content.
func hashFile(fsys fs.FS, name string) ([]byte, error) {
	f, err := fsys.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return nil, err
	}
	return h.Sum(nil), nil
}

// generateStaticVersion produces a random 4-char base36 string, the version
// of assets that may change under a running server (see mintStaticVersion).
func generateStaticVersion() string {
	versionBytes := make([]byte, 3)
	_, _ = rand.Read(versionBytes)
	n := new(big.Int).SetBytes(versionBytes)
	n.Mod(n, big.NewInt(36*36*36*36))
	v := n.Text(36)
	for len(v) < 4 {
		v = "0" + v
	}
	return v
}
