//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler"
)

func TestResolveVersionMarksAnUnstampedBuild(t *testing.T) {
	tests := []struct {
		name     string
		stamped  string
		embedded string
		want     string
	}{
		{"a release stamp is reported verbatim", "v0.6.1", "v0.6.1", "v0.6.1"},
		{"an unstamped build reports the embedded version, marked", "", "v0.6.1", "v0.6.1-dev"},
		{"surrounding whitespace is not part of a version", "", "v0.6.1\n", "v0.6.1-dev"},
		{"an already marked stamp is not marked twice", "", "v0.6.1-dev", "v0.6.1-dev"},
		{"with nothing to report, the old bare word stands", "", "", "dev"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := resolveVersion(tc.stamped, tc.embedded); got != tc.want {
				t.Errorf("resolveVersion(%q, %q) = %q, want %q", tc.stamped, tc.embedded, got, tc.want)
			}
		})
	}
}

// The embedded copy is what an unstamped build reports, and the file is what
// every stamped build is linked with. They are the same version or the two
// disagree about what this tree is.
func TestEmbeddedVersionMatchesTheVERSIONFile(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "VERSION"))
	if err != nil {
		t.Fatalf("reading the VERSION file: %v", err)
	}
	want := strings.TrimSpace(string(raw))
	if want == "" {
		t.Fatal("the VERSION file is empty")
	}
	if got := strings.TrimSpace(juggler.VersionFile); got != want {
		t.Errorf("embedded version = %q, VERSION file = %q", got, want)
	}
}

// A test binary is never stamped, so this is also a check that the fallback
// reaches the real Version the rest of the app reads.
func TestVersionOfAnUnstampedTestBinaryIsMarked(t *testing.T) {
	if stampedVersion != "" {
		t.Skipf("this test binary was stamped with %q", stampedVersion)
	}
	if !strings.HasSuffix(Version, devSuffix) {
		t.Errorf("Version = %q, want a %q suffix", Version, devSuffix)
	}
}

// TestIsTestVersion pins what the install figures leave out, and — just as
// deliberately — what they keep. A build from source is a real install; a server
// the suites spawn is not, and behaves identically apart from what it calls
// itself.
func TestIsTestVersion(t *testing.T) {
	suite := []string{"v0.6.1-test", "0.6.1-test", "v1.0.0-test"}
	counted := []string{"v0.6.1", "0.6.1", "v0.7.0-beta.1", "dev", "v0.6.1-dev", ""}

	for _, v := range suite {
		if !IsTestVersion(v) {
			t.Errorf("IsTestVersion(%q) = false, want true", v)
		}
	}
	for _, v := range counted {
		if IsTestVersion(v) {
			t.Errorf("IsTestVersion(%q) = true, want false", v)
		}
	}
}
