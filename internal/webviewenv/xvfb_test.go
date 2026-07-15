//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webviewenv

import (
	"reflect"
	"testing"
)

func TestXvfbRelaunchArgv(t *testing.T) {
	const xvfbPath = "/usr/bin/xvfb-run"
	lookPath := func(installed bool) func(string) (string, error) {
		return func(name string) (string, error) {
			if installed && name == "xvfb-run" {
				return xvfbPath, nil
			}
			return "", errNotFound
		}
	}
	lookupEnv := func(set ...string) func(string) (string, bool) {
		return func(k string) (string, bool) {
			for _, s := range set {
				if s == k {
					return "1", true
				}
			}
			return "", false
		}
	}
	cases := []struct {
		name             string
		goos             string
		display, wayland string
		envSet           []string
		xvfbInstalled    bool
		want             []string
	}{
		{"headless linux with xvfb relaunches", "linux", "", "", nil, true,
			[]string{xvfbPath, "-a", "/opt/juggler", "--port", "7777"}},
		{"x11 display present is a no-op", "linux", ":0", "", nil, true, nil},
		{"wayland display present is a no-op", "linux", "", "wayland-0", nil, true, nil},
		{"user opt-out is respected", "linux", "", "", []string{noXvfbEnv}, true, nil},
		{"already relaunched never loops", "linux", "", "", []string{xvfbMarkerEnv}, true, nil},
		{"xvfb-run not installed is a no-op", "linux", "", "", nil, false, nil},
		{"darwin is always a no-op", "darwin", "", "", nil, true, nil},
		{"windows is always a no-op", "windows", "", "", nil, true, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := xvfbRelaunchArgv(tc.goos, tc.display, tc.wayland,
				lookupEnv(tc.envSet...), lookPath(tc.xvfbInstalled),
				"/opt/juggler", []string{"--port", "7777"})
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("xvfbRelaunchArgv = %v, want %v", got, tc.want)
			}
		})
	}
}
