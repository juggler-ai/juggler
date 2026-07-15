//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webviewenv

import (
	"errors"
	"strings"
	"testing"
)

// errNotFound stands in for exec.LookPath's not-found error in fakes.
var errNotFound = errors.New("not found")

func TestPreflight(t *testing.T) {
	tests := []struct {
		name             string
		goos             string
		display, wayland string
		wantProblem      bool
	}{
		{"linux no display at all", "linux", "", "", true},
		{"linux with X11 display", "linux", ":0", "", false},
		{"linux under wayland", "linux", "", "wayland-0", false},
		{"linux under xvfb", "linux", ":99", "", false},
		{"darwin never preflight-fails", "darwin", "", "", false},
		{"windows never preflight-fails", "windows", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := preflight(tc.goos, tc.display, tc.wayland)
			if tc.wantProblem && got == "" {
				t.Fatalf("preflight(%q, %q, %q) = \"\", want a problem", tc.goos, tc.display, tc.wayland)
			}
			if !tc.wantProblem && got != "" {
				t.Fatalf("preflight(%q, %q, %q) = %q, want \"\"", tc.goos, tc.display, tc.wayland, got)
			}
		})
	}
}

func TestPrepareLinuxWebKit(t *testing.T) {
	cases := []struct {
		name       string
		goos       string
		alreadySet bool
		restricted bool
		wantSet    bool
		wantNote   bool
	}{
		{"linux restricted and unset disables the sandbox", "linux", false, true, true, true},
		{"linux restricted but user already set is left untouched", "linux", true, true, false, false},
		{"linux unrestricted is a no-op", "linux", false, false, false, false},
		{"darwin is always a no-op", "darwin", false, true, false, false},
		{"windows is always a no-op", "windows", false, true, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			set := map[string]bool{disableSandboxEnv: tc.alreadySet}
			lookup := func(k string) (string, bool) {
				if set[k] {
					return "0", true // a prior value exists, of some value
				}
				return "", false
			}
			var gotKey, gotVal string
			setter := func(k, v string) error {
				gotKey, gotVal = k, v
				set[k] = true
				return nil
			}
			note := prepareLinuxWebKit(tc.goos, lookup, setter, func() bool { return tc.restricted })

			didSet := gotKey == disableSandboxEnv && gotVal == "1"
			if didSet != tc.wantSet {
				t.Errorf("env set = %v (key=%q val=%q), want %v", didSet, gotKey, gotVal, tc.wantSet)
			}
			if (note != "") != tc.wantNote {
				t.Errorf("note = %q, want note present = %v", note, tc.wantNote)
			}
		})
	}
}

func TestSandboxRestrictedFrom(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  bool
	}{
		{"apparmor restricted", map[string]string{"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n"}, true},
		{"apparmor allowed", map[string]string{"/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n"}, false},
		{"userns clone disabled", map[string]string{"/proc/sys/kernel/unprivileged_userns_clone": "0"}, true},
		{"max user namespaces zero", map[string]string{"/proc/sys/user/max_user_namespaces": "0"}, true},
		{"max user namespaces plentiful", map[string]string{"/proc/sys/user/max_user_namespaces": "15000"}, false},
		{"nothing present", map[string]string{}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			read := func(p string) (string, bool) { v, ok := tc.files[p]; return v, ok }
			if got := sandboxRestrictedFrom(read); got != tc.want {
				t.Errorf("sandboxRestrictedFrom = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMessagePerOS(t *testing.T) {
	const reason = "the engine webview did not initialise in time"
	// Each OS's message must lead with the reason and carry the fix specific to
	// that platform, so a user on any host gets actionable guidance. On Linux
	// the fix is additionally tailored to the host: an exact install command
	// when a known package manager is present and xvfb is missing, or the bare
	// xvfb-run invocation when it is already installed.
	cases := []struct {
		name     string
		goos     string
		host     linuxHost
		contains []string
		excludes []string
	}{
		{"linux apt without xvfb", "linux", linuxHost{pm: "apt-get"},
			[]string{reason, "sudo apt-get install -y xvfb", "xvfb-run -a juggler", "WEBKIT_DISABLE", "apparmor_restrict_unprivileged_userns", "WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS"},
			nil},
		{"linux dnf without xvfb", "linux", linuxHost{pm: "dnf"},
			[]string{"sudo dnf install -y xorg-x11-server-Xvfb"}, nil},
		{"linux xvfb already installed skips the install step", "linux", linuxHost{pm: "apt-get", hasXvfb: true},
			[]string{"xvfb-run -a juggler"},
			[]string{"install -y xvfb"}},
		{"linux unknown package manager gets generic advice", "linux", linuxHost{},
			[]string{"Xvfb package", "xvfb-run -a juggler"},
			[]string{"install -y"}},
		{"darwin", "darwin", linuxHost{}, []string{reason, "Aqua", "LaunchAgent"}, nil},
		{"windows", "windows", linuxHost{}, []string{reason, "WebView2", "interactive user session"}, nil},
		{"plan9", "plan9", linuxHost{}, []string{reason, "webview runtime"}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			msg := message(tc.goos, reason, tc.host)
			for _, want := range tc.contains {
				if !strings.Contains(msg, want) {
					t.Errorf("message(%q, %+v) missing %q; got:\n%s", tc.goos, tc.host, want, msg)
				}
			}
			for _, unwanted := range tc.excludes {
				if strings.Contains(msg, unwanted) {
					t.Errorf("message(%q, %+v) unexpectedly contains %q; got:\n%s", tc.goos, tc.host, unwanted, msg)
				}
			}
		})
	}
}

func TestDetectLinuxHost(t *testing.T) {
	lookPathFrom := func(present ...string) func(string) (string, error) {
		return func(name string) (string, error) {
			for _, p := range present {
				if p == name {
					return "/usr/bin/" + name, nil
				}
			}
			return "", errNotFound
		}
	}
	cases := []struct {
		name    string
		goos    string
		present []string
		want    linuxHost
	}{
		{"apt host without xvfb", "linux", []string{"apt-get"}, linuxHost{pm: "apt-get"}},
		{"dnf host with xvfb", "linux", []string{"dnf", "xvfb-run"}, linuxHost{pm: "dnf", hasXvfb: true}},
		{"nothing recognised", "linux", nil, linuxHost{}},
		{"non-linux is always the zero value", "darwin", []string{"apt-get", "xvfb-run"}, linuxHost{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := detectLinuxHost(tc.goos, lookPathFrom(tc.present...)); got != tc.want {
				t.Errorf("detectLinuxHost(%q, %v) = %+v, want %+v", tc.goos, tc.present, got, tc.want)
			}
		})
	}
}
