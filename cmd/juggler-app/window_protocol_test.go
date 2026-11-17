//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// versionServer is a server by URL whose GET /api/version answers body.
func versionServer(t *testing.T, body string) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/version" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

// TestServerFit: which servers' pages this app shows, by what each says in GET
// /api/version. A server too old to state a protocol speaks 1, which this app
// still serves; one whose pages need a newer app than this, or that speaks
// older than this app serves, does not fit — and says which side is behind.
func TestServerFit(t *testing.T) {
	cases := []struct {
		name, body, want string
	}{
		{"this build's server", `{"version":"v9","windowProtocol":` + strconv.Itoa(windowProtocol) + `,"minAppWindowProtocol":` + strconv.Itoa(windowProtocol) + `}`, fitsApp},
		{"a server that states no protocol (0.7.x)", `{"version":"v0.7.9","embedVersion":0}`, fitsApp},
		{"a session server's /api/version", `{"version":"v0.8.1","name":"devbox"}`, fitsApp},
		{"a server whose pages need a newer app", `{"version":"v9.9.9","windowProtocol":99,"minAppWindowProtocol":99}`, appTooOld},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			info, ok := probeServer(context.Background(), versionServer(t, c.body))
			if !ok {
				t.Fatal("the server answered, but the probe says it did not")
			}
			if got := serverFit(info); got != c.want {
				t.Errorf("serverFit(%+v) = %q, want %q", info, got, c.want)
			}
		})
	}
	// Unreachable while this app serves protocol 1, which every server speaks,
	// so asserted on the rule itself.
	if got := serverFit(serverInfo{WindowProtocol: minServerWindowProtocol - 1, MinAppWindowProtocol: 1}); got != serverTooOld {
		t.Errorf("a server older than this app serves = %q, want %q", got, serverTooOld)
	}
}

// TestIncompatibleServerShowsAStandIn: a main window on a server whose pages
// need a newer app shows a stand-in naming both versions and saying to update
// the app — never the server's page, whose actions this app would refuse one
// by one as a bare "Not Found". A server that fits is shown as before.
func TestIncompatibleServerShowsAStandIn(t *testing.T) {
	a := newTestAppState(t)

	newer := versionServer(t, `{"version":"v9.9.9","windowProtocol":99,"minAppWindowProtocol":99,"name":"devbox"}`)
	v := a.framedPageView(windowSpec{url: newer, connected: true}, newer, false)
	if v.standIn == nil || v.standIn.kind != standInIncompatible {
		t.Fatalf("view = %+v, want the incompatible stand-in", v)
	}
	text := ""
	for _, m := range v.standIn.message {
		text += a.tr(m) + "\n"
	}
	for _, want := range []string{"v9.9.9", core.Version, "Update the Juggler app"} {
		if !strings.Contains(text, want) {
			t.Errorf("the stand-in says %q, want it to say %q", text, want)
		}
	}
	actions := map[string]bool{}
	for _, b := range v.standIn.buttons {
		actions[b.action] = true
	}
	for _, want := range []string{"open-in-browser", "retry-server", "open-local"} {
		if !actions[want] {
			t.Errorf("the stand-in has no %s button: %+v", want, v.standIn.buttons)
		}
	}

	same := versionServer(t, `{"version":"v1","windowProtocol":`+strconv.Itoa(windowProtocol)+`,"minAppWindowProtocol":`+strconv.Itoa(windowProtocol)+`}`)
	if v := a.framedPageView(windowSpec{url: same, connected: true}, same, false); v.standIn != nil {
		t.Fatalf("a server that fits got a stand-in: %+v", v.standIn)
	}
}

// TestHandOffNoticeNamesBothVersions: a launch handed to a running app of
// another version says so in the window it opens — the user started one
// version and is looking at another — and a launch of the same version, or one
// too old to say, says nothing.
func TestHandOffNoticeNamesBothVersions(t *testing.T) {
	a := newTestAppState(t)
	for _, c := range []struct {
		name, launched string
		says           bool
	}{
		{"same version", core.Version, false},
		{"a launcher too old to say", "", false},
		{"another version", "v99.0.0", true},
	} {
		data := application.SecondInstanceData{AdditionalData: map[string]string{launcherVersionKey: c.launched}}
		got := a.handOffNotice(data)
		if !c.says {
			if got != "" {
				t.Errorf("%s: notice %q, want none", c.name, got)
			}
			continue
		}
		if !strings.Contains(got, c.launched) || !strings.Contains(got, core.Version) {
			t.Errorf("%s: notice %q, want both %s and %s", c.name, got, c.launched, core.Version)
		}
	}
	if opts := singleInstanceOptions(nil, nil); opts.AdditionalData[launcherVersionKey] != core.Version {
		t.Errorf("a second launch hands over %v, want its version", opts.AdditionalData)
	}
}

// TestPageURLTellsThePageItsApp: every page the app loads is told the app's
// window-control protocol and version, which is how the page of a newer server
// knows to fall back on what this app can do.
func TestPageURLTellsThePageItsApp(t *testing.T) {
	q := query(t, windowOpts{})
	if got := q.Get("ctlProtocol"); got != strconv.Itoa(windowProtocol) {
		t.Errorf("ctlProtocol = %q, want %d", got, windowProtocol)
	}
	if got := q.Get("appVersion"); got != core.Version {
		t.Errorf("appVersion = %q, want %q", got, core.Version)
	}
}
