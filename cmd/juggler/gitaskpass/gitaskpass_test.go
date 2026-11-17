//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitaskpass

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// What git and ssh ask, as each prints it under LC_ALL=C, and what the client
// is to show for it: a name typed in the open, a secret masked, or a yes/no.
func TestAskpassClassify(t *testing.T) {
	cases := []struct {
		prompt, sshPrompt string
		want              Kind
	}{
		{"Username for 'https://example.com': ", "", KindText},
		{"Password for 'https://jules@example.com': ", "", KindSecret},
		{"Enter passphrase for key '/home/jules/.ssh/id_ed25519': ", "", KindSecret},
		{"jules@example.com's password: ", "", KindSecret},
		{"Enter passphrase for /home/jules/.ssh/id_ed25519: ", "", KindSecret}, // ssh-add's wording
		{"Enter PIN for ECDSA-SK key /home/jules/.ssh/id_ecdsa_sk: ", "", KindSecret},
		{"The authenticity of host 'example.com (192.0.2.1)' can't be established.\n" +
			"ED25519 key fingerprint is SHA256:abc.\n" +
			"Are you sure you want to continue connecting (yes/no/[fingerprint])? ", "", KindConfirm},
		{"Allow use of key /home/jules/.ssh/id_ed25519?\nKey fingerprint SHA256:abc.", "confirm", KindConfirm},
		{"Confirm user presence for key ECDSA-SK SHA256:abc", "none", KindNotice},
		{"Something no version of git or ssh has asked yet: ", "", KindSecret},
		{"Enter passphrase for key '/k': ", "secret", KindSecret},
	}
	for _, c := range cases {
		if got := Classify(c.prompt, c.sshPrompt); got != c.want {
			t.Errorf("Classify(%q, %q) = %q, want %q", c.prompt, c.sshPrompt, got, c.want)
		}
	}
}

// The helper is the server's own binary run again, so it must not take over a
// run of that binary that only happens to inherit the variables — a pre-push
// hook calling `juggler server status`, say. It answers only to the variables
// with exactly one argument, and a prompt, which a subcommand never is, has a
// space in it.
func TestAskpassInvoked(t *testing.T) {
	both := map[string]string{EnvAddr: "127.0.0.1:1", EnvToken: "t"}
	cases := []struct {
		name string
		args []string
		env  map[string]string
		want bool
	}{
		{"a prompt", []string{"Password for 'https://example.com': "}, both, true},
		{"no variables", []string{"Password: "}, nil, false},
		{"no token", []string{"Password: "}, map[string]string{EnvAddr: "127.0.0.1:1"}, false},
		{"a subcommand", []string{"serve"}, both, false},
		{"a subcommand with arguments", []string{"server", "status"}, both, false},
		{"a flag", []string{"--port=8080"}, both, false},
		{"nothing", nil, both, false},
	}
	for _, c := range cases {
		getenv := func(k string) string { return c.env[k] }
		if got := Invoked(c.args, getenv); got != c.want {
			t.Errorf("%s: Invoked(%q) = %v, want %v", c.name, c.args, got, c.want)
		}
	}
}

// The environment a network command is given: both askpass variables pointing
// at the helper, ssh made to use it even with a terminal about, and DISPLAY —
// which an older ssh needs before it will run any askpass — only when unset.
func TestAskpassEnv(t *testing.T) {
	env := Env("/bin/juggler", "127.0.0.1:5000", "tok", func(string) string { return "" })
	for _, want := range []string{
		"GIT_ASKPASS=/bin/juggler", "SSH_ASKPASS=/bin/juggler", "SSH_ASKPASS_REQUIRE=force",
		EnvAddr + "=127.0.0.1:5000", EnvToken + "=tok",
	} {
		if !slices.Contains(env, want) {
			t.Errorf("env %q lacks %q", env, want)
		}
	}
	if !slices.ContainsFunc(env, func(kv string) bool { return strings.HasPrefix(kv, "DISPLAY=") }) {
		t.Errorf("env %q sets no DISPLAY where none was set", env)
	}
	kept := Env("/bin/juggler", "a", "t", func(k string) string {
		if k == "DISPLAY" {
			return ":7"
		}
		return ""
	})
	if slices.ContainsFunc(kept, func(kv string) bool { return strings.HasPrefix(kv, "DISPLAY=") }) {
		t.Errorf("env %q overrides a DISPLAY already set", kept)
	}
}

// helperAgainst runs Main against handler as the server, and returns its exit
// status and what it printed.
func helperAgainst(t *testing.T, handler http.HandlerFunc, prompt string) (int, string) {
	t.Helper()
	srv := httptest.NewServer(handler)
	defer srv.Close()
	env := map[string]string{EnvAddr: strings.TrimPrefix(srv.URL, "http://"), EnvToken: "the-token", "SSH_ASKPASS_PROMPT": "confirm"}
	var out strings.Builder
	code := Main([]string{prompt}, func(k string) string { return env[k] }, &out)
	return code, out.String()
}

func TestAskpassHelperPrintsTheAnswer(t *testing.T) {
	var got Request
	code, out := helperAgainst(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != Path {
			t.Errorf("helper asked %s %s, want POST %s", r.Method, r.URL.Path, Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&got); err != nil {
			t.Error(err)
		}
		_ = json.NewEncoder(w).Encode(Answer{Answer: "s3cret"})
	}, "Password for 'https://example.com': ")
	if code != 0 || out != "s3cret\n" {
		t.Errorf("answered helper = %d %q, want 0 and the answer on a line", code, out)
	}
	if got.Token != "the-token" || got.Prompt != "Password for 'https://example.com': " || got.SSHPrompt != "confirm" {
		t.Errorf("helper sent %+v", got)
	}
}

func TestAskpassHelperDeclinedExitsOne(t *testing.T) {
	code, out := helperAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(Answer{Declined: true})
	}, "Password: ")
	if code != 1 || out != "" {
		t.Errorf("declined helper = %d %q, want 1 and nothing printed", code, out)
	}
	code, out = helperAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "no such token", http.StatusForbidden)
	}, "Password: ")
	if code != 1 || out != "" {
		t.Errorf("refused helper = %d %q, want 1 and nothing printed", code, out)
	}
}

func TestAskpassHelperServerGoneExitsOne(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	env := map[string]string{EnvAddr: addr, EnvToken: "t"}
	var out strings.Builder
	if code := Main([]string{"Password: "}, func(k string) string { return env[k] }, &out); code != 1 || out.Len() != 0 {
		t.Errorf("helper with no server = %d %q, want 1 and nothing printed", code, out.String())
	}

	// A server that takes the question and then goes away mid-wait.
	code, out2 := helperAgainst(t, func(w http.ResponseWriter, _ *http.Request) {
		conn, _, err := w.(http.Hijacker).Hijack()
		if err == nil {
			_ = conn.Close()
		}
	}, "Password: ")
	if code != 1 || out2 != "" {
		t.Errorf("helper whose server hung up = %d %q, want 1 and nothing printed", code, out2)
	}
}
