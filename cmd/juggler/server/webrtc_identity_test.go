//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

// fingerprintOf returns the SHA-256 DTLS fingerprint value of a certificate,
// failing the test if it cannot be derived.
func fingerprintOf(t *testing.T, cert *webrtc.Certificate) string {
	t.Helper()
	fps, err := cert.GetFingerprints()
	if err != nil || len(fps) == 0 {
		t.Fatalf("GetFingerprints: %v (n=%d)", err, len(fps))
	}
	return fps[0].Value
}

// TestWebRTCIdentityPersistsAndReloads is the core guarantee behind a stable
// Direct P2P link: minting an identity, then loading it again (as a restarted
// process would), yields the SAME fingerprint from a byte-identical file.
func TestWebRTCIdentityPersistsAndReloads(t *testing.T) {
	path := filepath.Join(t.TempDir(), webRTCIdentityFileName)

	first, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("first load-or-create: %v", err)
	}
	fp1 := fingerprintOf(t, first)

	bytesAfterCreate, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read identity file: %v", err)
	}
	if len(bytesAfterCreate) == 0 {
		t.Fatal("identity file is empty after create")
	}

	// Owner-only permissions: the file holds a private key. File modes are a
	// POSIX concept; skip the assertion on Windows.
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat identity file: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("identity file perms = %o, want 0600", perm)
		}
	}

	second, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("second load-or-create: %v", err)
	}
	fp2 := fingerprintOf(t, second)

	if fp1 != fp2 {
		t.Fatalf("fingerprint changed across reload: %q -> %q", fp1, fp2)
	}

	bytesAfterReload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("re-read identity file: %v", err)
	}
	if string(bytesAfterCreate) != string(bytesAfterReload) {
		t.Fatal("identity file was rewritten on reload; must be reused verbatim")
	}
}

// TestWebRTCIdentityRegeneratedWhenCorrupt verifies a garbage identity file is
// replaced with a fresh, valid one rather than wedging startup.
func TestWebRTCIdentityRegeneratedWhenCorrupt(t *testing.T) {
	path := filepath.Join(t.TempDir(), webRTCIdentityFileName)
	if err := os.WriteFile(path, []byte("not a pem file"), 0o600); err != nil {
		t.Fatalf("seed corrupt file: %v", err)
	}

	cert, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("load-or-create over corrupt file: %v", err)
	}
	// The file is now a real identity we can reload to the same fingerprint.
	reloaded, ok := loadWebRTCCertificate(path)
	if !ok {
		t.Fatal("identity file still unreadable after regeneration")
	}
	if got, want := fingerprintOf(t, reloaded), fingerprintOf(t, cert); got != want {
		t.Fatalf("regenerated file fingerprint %q != returned %q", got, want)
	}
}

// TestWebRTCIdentityRegeneratedWhenExpired verifies a lapsed identity is rotated
// rather than reused (the rare, years-out case), producing a new fingerprint.
func TestWebRTCIdentityRegeneratedWhenExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), webRTCIdentityFileName)

	expired := mintExpiredCertificate(t)
	expiredFP := fingerprintOf(t, expired)
	if err := writeWebRTCCertificate(path, expired); err != nil {
		t.Fatalf("write expired identity: %v", err)
	}
	// Sanity: the loader rejects it as unusable.
	if _, ok := loadWebRTCCertificate(path); ok {
		t.Fatal("expired identity should not load as usable")
	}

	fresh, err := loadOrCreateWebRTCCertificate(path)
	if err != nil {
		t.Fatalf("load-or-create over expired file: %v", err)
	}
	if fingerprintOf(t, fresh) == expiredFP {
		t.Fatal("expired identity was reused instead of rotated")
	}
	if time.Now().After(fresh.Expires()) {
		t.Fatal("freshly minted identity is already expired")
	}
}

// TestPeerIdentityFingerprint covers the accessor both ways: no identity ->
// ("", false); a loaded identity -> its fingerprint and true.
func TestPeerIdentityFingerprint(t *testing.T) {
	s := &Server{}
	if fp, ok := s.PeerIdentityFingerprint(); ok || fp != "" {
		t.Fatalf("no identity: got (%q, %v), want (\"\", false)", fp, ok)
	}

	cert, err := loadOrCreateWebRTCCertificate(filepath.Join(t.TempDir(), webRTCIdentityFileName))
	if err != nil {
		t.Fatalf("load-or-create: %v", err)
	}
	s.webrtcCert = cert

	fp, ok := s.PeerIdentityFingerprint()
	if !ok {
		t.Fatal("loaded identity: ok = false, want true")
	}
	if want := fingerprintOf(t, cert); fp != want {
		t.Fatalf("fingerprint = %q, want %q", fp, want)
	}
}

// TestTunnelHostExposesPeerIdentity verifies the capability handed to tunnel
// providers reports the same stable fingerprint as the server — this is what a
// Direct P2P provider reads to build a link that survives a restart.
func TestTunnelHostExposesPeerIdentity(t *testing.T) {
	cert, err := loadOrCreateWebRTCCertificate(filepath.Join(t.TempDir(), webRTCIdentityFileName))
	if err != nil {
		t.Fatalf("load-or-create: %v", err)
	}
	s := &Server{webrtcCert: cert}

	hostFP, hostOK := tunnelHost{s}.PeerIdentityFingerprint()
	srvFP, srvOK := s.PeerIdentityFingerprint()
	if hostFP != srvFP || hostOK != srvOK {
		t.Fatalf("tunnelHost (%q,%v) != server (%q,%v)", hostFP, hostOK, srvFP, srvOK)
	}
	if !hostOK {
		t.Fatal("tunnelHost reported no identity")
	}
}

// TestAcceptWebRTCOfferPresentsPersistentIdentityAcrossRestarts is the
// end-to-end proof: two independent servers sharing one identity file (a
// stop/start of the same machine) each answer a real guest offer, and both
// answers carry the SAME persistent DTLS fingerprint. The remote peer therefore
// sees an unchanged identity across the restart — the basis for a Direct P2P
// link that keeps working.
func TestAcceptWebRTCOfferPresentsPersistentIdentityAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), webRTCIdentityFileName)

	answerFor := func() (string, string) {
		t.Helper()
		cert, err := loadOrCreateWebRTCCertificate(path)
		if err != nil {
			t.Fatalf("load-or-create: %v", err)
		}
		s := &Server{webrtcCert: cert, stats: newWSStats()}

		// Guest peer: empty ICE config -> host candidates only, so gathering
		// completes promptly with no STUN/network round trip.
		pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
		if err != nil {
			t.Fatalf("guest NewPeerConnection: %v", err)
		}
		defer func() { _ = pc.Close() }()
		if _, err := pc.CreateDataChannel("juggler", nil); err != nil {
			t.Fatalf("guest CreateDataChannel: %v", err)
		}
		offer, err := pc.CreateOffer(nil)
		if err != nil {
			t.Fatalf("guest CreateOffer: %v", err)
		}
		gather := webrtc.GatheringCompletePromise(pc)
		if err := pc.SetLocalDescription(offer); err != nil {
			t.Fatalf("guest SetLocalDescription: %v", err)
		}
		select {
		case <-gather:
		case <-time.After(20 * time.Second):
			t.Fatal("guest ICE gathering timed out")
		}

		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		answer, err := s.acceptWebRTCOfferWithICEConfig(ctx, *pc.LocalDescription(), webrtcICEConfig{})
		if err != nil {
			t.Fatalf("acceptWebRTCOffer: %v", err)
		}
		fp, ok := s.PeerIdentityFingerprint()
		if !ok {
			t.Fatal("server reported no persistent identity")
		}
		return answer.SDP, fp
	}

	sdp1, fp1 := answerFor() // first boot
	sdp2, fp2 := answerFor() // after a restart

	if fp1 != fp2 {
		t.Fatalf("persistent fingerprint changed across restart: %q -> %q", fp1, fp2)
	}
	// The answer SDP must actually advertise the persistent fingerprint (SDP
	// uses upper-case hex; compare case-insensitively).
	for i, sdp := range []string{sdp1, sdp2} {
		if !strings.Contains(strings.ToLower(sdp), strings.ToLower(fp1)) {
			t.Fatalf("answer %d SDP does not carry the persistent fingerprint %q", i+1, fp1)
		}
	}
}

// mintExpiredCertificate builds a syntactically valid but already-expired
// identity certificate for the rotation test.
func mintExpiredCertificate(t *testing.T) *webrtc.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	name := pkix.Name{CommonName: "Juggler WebRTC identity (expired)"}
	cert, err := webrtc.NewCertificate(key, x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      name,
		Issuer:       name,
		NotBefore:    time.Now().Add(-48 * time.Hour),
		NotAfter:     time.Now().Add(-24 * time.Hour),
		Version:      2,
	})
	if err != nil {
		t.Fatalf("NewCertificate: %v", err)
	}
	return cert
}
