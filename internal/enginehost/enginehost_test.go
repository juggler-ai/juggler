//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package enginehost

import (
	"errors"
	"strings"
	"testing"
)

// errNotFound stands in for exec.LookPath's not-found error in fakes.
var errNotFound = errors.New("not found")

// lookPathFor returns a LookPath fake that resolves only the named binaries.
func lookPathFor(present ...string) func(string) (string, error) {
	return func(name string) (string, error) {
		for _, p := range present {
			if p == name {
				return "/usr/bin/" + name, nil
			}
		}
		return "", errNotFound
	}
}

func TestParseNodeMajor(t *testing.T) {
	cases := []struct {
		in      string
		wantMaj int
		wantOK  bool
	}{
		{"v22.3.0", 22, true},
		{"v18.19.1", 18, true},
		{"22.3.0", 22, true},
		{"v20", 20, true},
		{"v22.3.0\n", 22, true},
		{"", 0, false},
		{"vX.Y", 0, false},
		{"node", 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.in, func(t *testing.T) {
			maj, ok := parseNodeMajor(tc.in)
			if maj != tc.wantMaj || ok != tc.wantOK {
				t.Errorf("parseNodeMajor(%q) = (%d, %v), want (%d, %v)", tc.in, maj, ok, tc.wantMaj, tc.wantOK)
			}
		})
	}
}

func TestProbeNode(t *testing.T) {
	cases := []struct {
		name        string
		present     bool
		version     string
		versionErr  error
		wantOK      bool
		wantMajor   int
		wantProblem string // substring that must appear in Problem when !wantOK
	}{
		{"missing", false, "", nil, false, 0, "not found"},
		{"current", true, "v22.3.0\n", nil, true, 22, ""},
		{"newer", true, "v24.0.1\n", nil, true, 24, ""},
		{"too old", true, "v18.19.1\n", nil, false, 18, "need ≥ 22"},
		{"exec fails", true, "", errNotFound, false, 0, "--version` failed"},
		{"unparseable", true, "garbage\n", nil, false, 0, "could not parse"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			lookPath := func(string) (string, error) { return "", errNotFound }
			if tc.present {
				lookPath = lookPathFor("node")
			}
			runVersion := func(string) (string, error) { return tc.version, tc.versionErr }

			info := ProbeNode(lookPath, runVersion)
			if info.OK != tc.wantOK {
				t.Fatalf("ProbeNode OK = %v, want %v (info=%+v)", info.OK, tc.wantOK, info)
			}
			if tc.wantOK {
				if info.Major != tc.wantMajor {
					t.Errorf("Major = %d, want %d", info.Major, tc.wantMajor)
				}
				if info.Problem != "" {
					t.Errorf("Problem = %q, want empty on OK", info.Problem)
				}
				return
			}
			if tc.wantProblem != "" && !strings.Contains(info.Problem, tc.wantProblem) {
				t.Errorf("Problem = %q, want it to contain %q", info.Problem, tc.wantProblem)
			}
		})
	}
}

func TestChoose(t *testing.T) {
	okNode := func() NodeInfo { return NodeInfo{Path: "/usr/bin/node", Version: "v22.3.0", Major: 22, OK: true} }
	badNode := func() NodeInfo { return NodeInfo{Problem: "Node.js was not found on PATH"} }
	panicNode := func() NodeInfo { panic("probeNode must not be called") }

	cases := []struct {
		name           string
		goos           string
		env            string
		node           func() NodeInfo
		displayPresent bool
		wantMode       Mode
		wantErr        bool
	}{
		{"auto linux with display and good node uses node", "linux", "", okNode, true, ModeNode, false},
		{"auto headless linux with good node uses node", "linux", "", okNode, false, ModeNode, false},
		{"auto headless linux without node stays webview", "linux", "", badNode, false, ModeWebview, false},
		{"explicit auto linux with display uses node", "linux", "auto", okNode, true, ModeNode, false},
		{"auto headless darwin never probes node", "darwin", "", panicNode, true, ModeWebview, false},
		{"empty auto on darwin", "darwin", "", panicNode, true, ModeWebview, false},
		{"forced webview", "linux", "webview", panicNode, false, ModeWebview, false},
		{"forced webview uppercased", "linux", "WebView", panicNode, false, ModeWebview, false},
		{"forced node with good node", "linux", "node", okNode, false, ModeNode, false},
		{"forced node with padding", "linux", "  node  ", okNode, false, ModeNode, false},
		{"forced node without node errors", "linux", "node", badNode, false, ModeWebview, true},
		{"unknown value errors", "linux", "gtk", panicNode, true, ModeWebview, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string {
				if k == EnvVar {
					return tc.env
				}
				return ""
			}
			mode, reason, err := Choose(tc.goos, getenv, tc.node, tc.displayPresent)
			if (err != nil) != tc.wantErr {
				t.Fatalf("Choose err = %v, wantErr = %v", err, tc.wantErr)
			}
			if err != nil {
				return
			}
			if mode != tc.wantMode {
				t.Errorf("Choose mode = %v, want %v", mode, tc.wantMode)
			}
			if reason == "" {
				t.Errorf("Choose returned an empty reason; the boot log line needs one")
			}
		})
	}
}
