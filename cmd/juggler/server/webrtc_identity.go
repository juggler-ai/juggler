//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"

	"github.com/pion/webrtc/v4"
)

// webRTCIdentityFileName is the durable store for this machine's WebRTC peer
// identity — the DTLS certificate (and its private key) Juggler presents on
// every peer connection. Kept in the per-user config dir so it survives across
// restarts, exactly like credentials.json.
const webRTCIdentityFileName = "webrtc-identity.pem"

// webRTCIdentityValidity is how long a freshly-minted identity certificate is
// valid. WebRTC peers authenticate by the DTLS fingerprint carried in the SDP,
// not by chain/expiry validation, so a long lifetime simply avoids ever
// rotating (and thereby changing) a machine's stable identity in practice; the
// file is regenerated only if it is missing, unreadable, or has lapsed.
const webRTCIdentityValidity = 100 * 365 * 24 * time.Hour

// webRTCIdentityPath returns the absolute path of the persistent WebRTC
// identity file inside the per-user config directory.
func webRTCIdentityPath() string {
	return filepath.Join(userpaths.ConfigDir(), webRTCIdentityFileName)
}

// PeerIdentityFingerprint returns the SHA-256 DTLS fingerprint of this machine's
// persistent WebRTC identity, and true when one is loaded. Because the identity
// is reused across restarts, the fingerprint is stable — so a tunnel/rendezvous
// provider can fold it into a shareable Direct P2P link (or a remote client can
// pin it) and the link keeps working after Juggler is stopped and started again,
// instead of a fresh identity invalidating it on every launch. Returns "",
// false when no persistent identity is available (pion is minting ephemeral
// per-connection certificates).
func (s *Server) PeerIdentityFingerprint() (string, bool) {
	if s.webrtcCert == nil {
		return "", false
	}
	fps, err := s.webrtcCert.GetFingerprints()
	if err != nil || len(fps) == 0 {
		return "", false
	}
	return fps[0].Value, true
}

// loadOrCreateWebRTCCertificate returns the persistent WebRTC identity stored at
// path, minting and persisting a fresh one when none is usable yet.
//
// Reusing one certificate across process restarts is what lets a phone keep a
// working Direct P2P link after Juggler is stopped and started again: the peer's
// DTLS fingerprint — the cryptographic identity a remote client (or a rendezvous
// provider building a shareable link) can pin — stays the same instead of being
// regenerated on every launch. The same certificate is also reused for every
// peer connection within a single run.
//
// A new certificate is written atomically with owner-only permissions (it holds
// a private key). Regeneration happens only when the file is absent, corrupt, or
// past its NotAfter; a still-valid file is always reused verbatim so the
// fingerprint is bit-for-bit stable.
func loadOrCreateWebRTCCertificate(path string) (*webrtc.Certificate, error) {
	if cert, ok := loadWebRTCCertificate(path); ok {
		return cert, nil
	}

	cert, err := newPersistentWebRTCCertificate()
	if err != nil {
		return nil, err
	}
	if err := writeWebRTCCertificate(path, cert); err != nil {
		return nil, err
	}
	return cert, nil
}

// loadWebRTCCertificate reads and validates a stored identity. It returns ok
// false (rather than an error) for any recoverable condition — no file yet, an
// unparseable file, or a lapsed certificate — so the caller mints a replacement
// instead of failing to start.
func loadWebRTCCertificate(path string) (*webrtc.Certificate, bool) {
	data, err := atomicio.RobustReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			jlog.Info("WebRTC identity: cannot read %s (%v); minting a new one", path, err)
		}
		return nil, false
	}
	cert, err := webrtc.CertificateFromPEM(string(data))
	if err != nil {
		jlog.Info("WebRTC identity: %s is unreadable (%v); minting a new one", path, err)
		return nil, false
	}
	if time.Now().After(cert.Expires()) {
		jlog.Info("WebRTC identity: %s has expired; minting a new one", path)
		return nil, false
	}
	return cert, true
}

// newPersistentWebRTCCertificate mints a long-lived self-signed certificate to
// serve as this machine's stable WebRTC identity. It uses a far-future NotAfter
// (unlike webrtc.GenerateCertificate, whose ~one-month lifetime would force the
// identity to churn) so a persisted identity effectively never rotates.
func newPersistentWebRTCCertificate() (*webrtc.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate WebRTC identity key: %w", err)
	}
	// A 130-bit random serial, matching webrtc.GenerateCertificate's own bound.
	maxSerial := new(big.Int).Sub(new(big.Int).Exp(big.NewInt(2), big.NewInt(130), nil), big.NewInt(1))
	serial, err := rand.Int(rand.Reader, maxSerial)
	if err != nil {
		return nil, fmt.Errorf("generate WebRTC identity serial: %w", err)
	}
	now := time.Now()
	cert, err := webrtc.NewCertificate(key, x509IdentityTemplate(serial, now))
	if err != nil {
		return nil, fmt.Errorf("create WebRTC identity certificate: %w", err)
	}
	return cert, nil
}

// writeWebRTCCertificate persists cert (certificate + private key PEM blocks)
// atomically with 0600 permissions, mirroring how credentials.json is stored:
// a unique temp file in the same directory, then an atomic rename, so a torn or
// world-readable file is never observable.
func writeWebRTCCertificate(path string, cert *webrtc.Certificate) error {
	pem, err := cert.PEM()
	if err != nil {
		return fmt.Errorf("encode WebRTC identity: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create WebRTC identity directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "webrtc-identity-*.pem.tmp")
	if err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // no-op once the rename succeeds
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if _, err := tmp.WriteString(pem); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	if err := atomicio.RobustRename(tmpName, path); err != nil {
		return fmt.Errorf("write WebRTC identity: %w", err)
	}
	return nil
}

// x509IdentityTemplate is the shared template for a persistent identity
// certificate: a self-signed leaf, valid from just before now until far in the
// future, labelled so a human inspecting the file can tell what it is.
func x509IdentityTemplate(serial *big.Int, now time.Time) x509.Certificate {
	name := pkix.Name{CommonName: "Juggler WebRTC identity"}
	return x509.Certificate{
		SerialNumber: serial,
		Subject:      name,
		Issuer:       name,
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.Add(webRTCIdentityValidity),
		Version:      2,
	}
}
