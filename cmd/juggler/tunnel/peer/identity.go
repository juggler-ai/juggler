//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"errors"
	"fmt"
	"io/fs"
	"math/big"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"

	"github.com/pion/webrtc/v4"
)

// identityFileName is the durable store for this machine's peer identity: the
// DTLS certificate (and its private key) the machine server presents on every
// peer connection. One per machine, beside the user's other durable state, so
// its fingerprint is what a remote client pins this machine by.
const identityFileName = "webrtc-identity.pem"

// IdentityPath is where this machine's peer identity is kept.
func IdentityPath() string {
	return filepath.Join(userpaths.ConfigDir(), identityFileName)
}

// fingerprint returns cert's SHA-256 DTLS fingerprint, or "" if it has none.
func fingerprint(cert *webrtc.Certificate) string {
	if cert == nil {
		return ""
	}
	fps, err := cert.GetFingerprints()
	if err != nil || len(fps) == 0 {
		return ""
	}
	return fps[0].Value
}

// loadOrCreateCertificate returns the persistent identity at path, minting and
// persisting a fresh one only when the file is absent or unreadable.
//
// A still-usable file is always reused verbatim, so the DTLS fingerprint — the
// identity a remote client pins — stays byte-for-byte stable across restarts
// and across every peer connection within a run. There is deliberately no
// expiry-driven rotation: the identity is minted far in the future (see
// newIdentity) and WebRTC peers authenticate by the SDP fingerprint, not by
// certificate validity (RFC 8122). Rotating it is a manual act: delete the file.
//
// Where there is no file yet, minters racing to make the first one agree on
// one: each puts its own in place only if none is there by then, and one that
// finds another's there adopts it, so no process presents a fingerprint the
// file has already lost. An unreadable file is replaced outright.
func loadOrCreateCertificate(path string) (*webrtc.Certificate, error) {
	if cert, ok := loadCertificate(path); ok {
		return cert, nil
	}
	_, statErr := os.Lstat(path)
	absent := os.IsNotExist(statErr)
	cert, err := newIdentity()
	if err != nil {
		return nil, err
	}
	won, err := writeCertificate(path, cert, absent)
	if err != nil {
		return nil, err
	}
	if !won {
		if theirs, ok := loadCertificate(path); ok {
			return theirs, nil
		}
		// Theirs is unreadable after all (a hand-made file): replace it.
		if _, err := writeCertificate(path, cert, false); err != nil {
			return nil, err
		}
	}
	return cert, nil
}

// loadCertificate reads and parses a stored identity. It returns ok=false
// (never an error) for any recoverable condition — no file yet, or an
// unparseable one — so the caller mints a replacement instead of failing to
// start. A missing file is silent (the first-run norm); anything else is logged.
func loadCertificate(path string) (*webrtc.Certificate, bool) {
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
	return cert, true
}

// newIdentity mints a long-lived self-signed certificate to serve as this
// machine's stable WebRTC identity. It sets a far-future NotAfter (pion's own
// GenerateCertificate expires in a month, which would churn the identity) so a
// persisted identity effectively never needs rotating. The serial is fixed: this
// is a single self-signed leaf authenticated by fingerprint, not a CA-issued
// cert that must be uniquely numbered.
func newIdentity() (*webrtc.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generate WebRTC identity key: %w", err)
	}
	now := time.Now()
	name := pkix.Name{CommonName: "Juggler WebRTC identity"}
	cert, err := webrtc.NewCertificate(key, x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      name,
		Issuer:       name,
		NotBefore:    now.Add(-time.Hour),
		NotAfter:     now.AddDate(100, 0, 0),
		Version:      2,
	})
	if err != nil {
		return nil, fmt.Errorf("create WebRTC identity certificate: %w", err)
	}
	return cert, nil
}

// writeCertificate persists cert (certificate + private-key PEM blocks)
// atomically with owner-only permissions: a unique temp file in the same
// directory, chmod 0600, then put in place whole — so a torn or
// world-readable file (it holds a private key) is never observable.
//
// With ifAbsent it is put in place only if nothing is at path yet (a hard
// link, which fails if something is), and won says whether it was; a
// filesystem with no hard links falls back to the rename. Otherwise it
// replaces whatever is there, and won is true.
func writeCertificate(path string, cert *webrtc.Certificate, ifAbsent bool) (won bool, err error) {
	pemData, err := cert.PEM()
	if err != nil {
		return false, fmt.Errorf("encode WebRTC identity: %w", err)
	}
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false, fmt.Errorf("create WebRTC identity directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, "webrtc-identity-*.pem.tmp")
	if err != nil {
		return false, fmt.Errorf("write WebRTC identity: %w", err)
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }() // what is left of it once it is in place, or all of it
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("write WebRTC identity: %w", err)
	}
	if _, err := tmp.WriteString(pemData); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("write WebRTC identity: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("write WebRTC identity: %w", err)
	}
	if ifAbsent {
		err := os.Link(tmpName, path)
		if err == nil {
			return true, nil
		}
		if errors.Is(err, fs.ErrExist) {
			return false, nil
		}
		jlog.Info("WebRTC identity: cannot link %s (%v); renaming it into place", path, err)
	}
	if err := atomicio.RobustRename(tmpName, path); err != nil {
		return false, fmt.Errorf("write WebRTC identity: %w", err)
	}
	return true, nil
}
