//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"juggler/internal/userpaths"
)

// TestIdentityPersistsAndReloads is the guarantee behind a pinnable machine:
// minting an identity, then loading it again (as a restarted server would),
// yields the same fingerprint from a byte-identical file, and the file is
// owner-only because it holds a private key.
func TestIdentityPersistsAndReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), identityFileName)

	first := New(path)
	fp1 := first.Fingerprint()
	if fp1 == "" {
		t.Fatal("a fresh identity has no fingerprint")
	}
	created, err := os.ReadFile(path)
	if err != nil || len(created) == 0 {
		t.Fatalf("identity file after create: %v (%d bytes)", err, len(created))
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("identity file perms = %o, want 0600", perm)
		}
	}

	if fp2 := New(path).Fingerprint(); fp2 != fp1 {
		t.Fatalf("fingerprint changed across reload: %q -> %q", fp1, fp2)
	}
	reloaded, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(created) != string(reloaded) {
		t.Fatal("identity file was rewritten on reload; it must be reused verbatim")
	}
}

// TestIdentityLoadsOnlyWhenAsked: a peer reads or mints its identity the first
// time it is asked for it, not when made, so a process that makes one and never
// serves a tunnel (bare juggler attaching to a running server) writes nothing.
func TestIdentityLoadsOnlyWhenAsked(t *testing.T) {
	path := filepath.Join(t.TempDir(), identityFileName)
	p := New(path)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("making a peer touched its identity file: %v", err)
	}
	fp := p.Fingerprint()
	if fp == "" {
		t.Fatal("the first ask minted no identity")
	}
	cert, ok := loadCertificate(path)
	if !ok || fingerprint(cert) != fp {
		t.Fatalf("the file holds another identity than the peer presents (%v)", ok)
	}
	if again := p.Fingerprint(); again != fp {
		t.Fatalf("a second ask changed the fingerprint: %q -> %q", fp, again)
	}
}

// TestFirstMintersAgreeOnOneIdentity: processes minting the identity at once,
// on a machine that has none yet, end with the one identity they all present
// and the file holds — a second minter adopts the first's file rather than
// writing over it, so no running server presents a fingerprint the file has
// already lost.
func TestFirstMintersAgreeOnOneIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), identityFileName)
	const minters = 8
	fps := make(chan string, minters)
	start := make(chan struct{})
	for range minters {
		go func() {
			<-start
			fps <- New(path).Fingerprint()
		}()
	}
	close(start)
	seen := map[string]bool{}
	for range minters {
		seen[<-fps] = true
	}
	cert, ok := loadCertificate(path)
	if !ok {
		t.Fatal("no identity on disk after the minters")
	}
	if len(seen) != 1 || !seen[fingerprint(cert)] {
		t.Fatalf("%d minters presented %d identities %v; the file holds %q", minters, len(seen), seen, fingerprint(cert))
	}
}

// TestIdentityIsPerMachine: the identity lives in the user's config dir, one
// for the machine, so every session it serves is reached as the same peer.
func TestIdentityIsPerMachine(t *testing.T) {
	if got, want := IdentityPath(), filepath.Join(userpaths.ConfigDir(), "webrtc-identity.pem"); got != want {
		t.Fatalf("IdentityPath() = %q, want %q", got, want)
	}
}

// TestIdentityRegeneratedWhenCorrupt: a garbage identity file is replaced with
// a fresh, valid one rather than wedging startup.
func TestIdentityRegeneratedWhenCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), identityFileName)
	if err := os.WriteFile(path, []byte("not a pem file"), 0o600); err != nil {
		t.Fatal(err)
	}
	presented := New(path).Fingerprint()
	cert, ok := loadCertificate(path)
	if !ok {
		t.Fatal("identity file still unreadable after regeneration")
	}
	if got, want := fingerprint(cert), presented; got != want || got == "" {
		t.Fatalf("regenerated file fingerprint %q, peer presents %q", got, want)
	}
}

// TestIdentityUnwritableIsEphemeral: when the identity can be neither read
// nor written, the peer still answers, with no lasting fingerprint.
func TestIdentityUnwritableIsEphemeral(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if fp := New(filepath.Join(blocker, identityFileName)).Fingerprint(); fp != "" {
		t.Fatalf("an unwritable identity has fingerprint %q, want none", fp)
	}
}
