//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// Which account a claude process runs as is decided by its environment alone,
// so getting it wrong is silent: the turn works, on someone else's plan.

// resetAccountLogin gives a test a fresh login record for a, and forgets it
// afterwards.
func resetAccountLogin(t *testing.T, a account) {
	t.Helper()
	loginRecords.Delete(a.id())
	t.Cleanup(func() { loginRecords.Delete(a.id()) })
}

func mkAccountClient(t *testing.T, a account, model string) *Client {
	t.Helper()
	p, err := accountInitializer(a)(provider.Config{Model: model, ProjectPath: t.TempDir()})
	if err != nil {
		t.Fatalf("account client: %v", err)
	}
	c := p.(*Client)
	t.Cleanup(c.closeSession)
	return c
}

// TestExtraAccountSpawnsIsolated: every claude an extra account starts — a
// turn, the /usage probe, the auth-status probe — runs under its own config
// dir and without a credential variable, any of which would override its
// login and make it the default account. The default account's claude
// inherits the environment exactly as it always has.
func TestExtraAccountSpawnsIsolated(t *testing.T) {
	inherited := t.TempDir()
	t.Setenv("CLAUDE_CONFIG_DIR", inherited)
	tokens := []string{"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"}
	for _, name := range tokens {
		t.Setenv(name, "inherited-"+name)
	}
	work := account{name: "claudecode-work", configDir: t.TempDir()}
	resetAccountLogin(t, work)
	resetLoginState(t, loginUnknown, false)
	tracePath := installFakeClaude(t, fakeModeText, "s-work")

	c := mkAccountClient(t, work, "sonnet")
	sendMsg(t, c, "conv-work", []provider.Message{userMsg("hi")})
	_, _ = c.UsageStats(context.Background())
	_ = runClaudeAuthStatus(context.Background(), work.configDir)

	recs := readTrace(t, tracePath)
	if len(recs) < 3 {
		t.Fatalf("expected a turn, a /usage probe and an auth-status probe to spawn; traced %d", len(recs))
	}
	for _, r := range recs {
		if got := r.Env["CLAUDE_CONFIG_DIR"]; got != work.configDir {
			t.Errorf("%v ran with CLAUDE_CONFIG_DIR=%q; want the account's own %q", r.Argv[1:], got, work.configDir)
		}
		for _, name := range tokens {
			if _, ok := r.Env[name]; ok {
				t.Errorf("%v inherited %s, which overrides the account's login", r.Argv[1:], name)
			}
		}
	}

	if err := os.Remove(tracePath); err != nil {
		t.Fatal(err)
	}
	sendMsg(t, mkClient(t, "sonnet"), "conv-default", []provider.Message{userMsg("hi")})
	recs = readTrace(t, tracePath)
	if len(recs) == 0 {
		t.Fatal("the default account's turn spawned nothing")
	}
	for _, r := range recs {
		if got := r.Env["CLAUDE_CONFIG_DIR"]; got != inherited {
			t.Errorf("the default account ran with CLAUDE_CONFIG_DIR=%q; want the inherited %q", got, inherited)
		}
		for _, name := range tokens {
			if r.Env[name] != "inherited-"+name {
				t.Errorf("the default account lost %s from its environment", name)
			}
		}
	}
}

// TestLoginExpiryIsPerAccount: one account's lapsed login takes away that
// account and no other, and says how to sign that one in.
func TestLoginExpiryIsPerAccount(t *testing.T) {
	stubCLIInstalled(t, true)
	work := account{name: "claudecode-work", configDir: filepath.Join(t.TempDir(), ".claude-work")}
	resetAccountLogin(t, work)
	resetLoginState(t, loginConfirmed, false)

	err := cliAPIError(work, 401, "OAuth token has expired")
	var authErr *provider.AuthError
	if !errors.As(err, &authErr) {
		t.Fatalf("a 401 on the work account gave %T, want an AuthError", err)
	}
	if authErr.Provider != work.id() {
		t.Errorf("the failure names provider %q; want %q, whose settings card fixes it", authErr.Provider, work.id())
	}
	if !strings.Contains(authErr.Hint, work.configDir) {
		t.Errorf("the hint %q does not say which config dir to sign in", authErr.Hint)
	}

	if got := currentClaudeLoginState(defaultAccountID); got != loginConfirmed {
		t.Errorf("the work account's expiry left the default account %v", got)
	}
	if ready, _ := readinessOf(account{}); !ready {
		t.Errorf("the default account went unready because another account's login lapsed")
	}

	stubAuthProbe(t, authProbeSignedOut)
	ready, hint := readinessOf(work)
	if ready {
		t.Fatalf("the work account is ready with its login expired and signed out")
	}
	if !strings.Contains(hint.English(), work.configDir) {
		t.Errorf("the readiness hint %q does not name the work account's config dir", hint.English())
	}

	markClaudeLoginConfirmed(defaultAccountID)
	if got := currentClaudeLoginState(work.id()); got != loginExpired {
		t.Errorf("a turn on the default account cleared the work account's expiry (now %v)", got)
	}
}

// TestDiscoverFindsOtherLogins: further Claude Code logins are found in
// ~/.claude-* and ~/.claude_* and in the config dirs shell rc files name, and
// offered only when `claude auth status` says someone is signed in there. A
// path is probed only if it already holds a .claude.json: the CLI creates its
// config dir on any call, so probing a guess would leave an empty one behind.
func TestDiscoverFindsOtherLogins(t *testing.T) {
	home := t.TempDir()
	mk := func(rel string, signedIn bool) string {
		dir := filepath.Join(home, rel)
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
		if signedIn {
			if err := os.WriteFile(filepath.Join(dir, ".claude.json"), []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		return dir
	}
	work := mk(".claude-work", true)
	mk(".claude_stale", false)
	mk(".claude", true) // the default account's own
	client := mk("elsewhere/client-login", true)
	old := mk(".claude-old", true)
	rc := "alias cc='CLAUDE_CONFIG_DIR=~/elsewhere/client-login claude'\n" +
		"alias ghost='CLAUDE_CONFIG_DIR=$HOME/.claude-ghost claude'\n" +
		"export PATH=$PATH:/opt/bin\n"
	if err := os.WriteFile(filepath.Join(home, ".zshrc"), []byte(rc), 0o600); err != nil {
		t.Fatal(err)
	}

	// The probes run side by side; probedLock is a 1-capacity channel used as
	// a binary semaphore over probed.
	var probed []string
	probedLock := make(chan struct{}, 1)
	prev := authStatusProbe
	authStatusProbe = func(_ context.Context, configDir string) authProbeResult {
		probedLock <- struct{}{}
		probed = append(probed, configDir)
		<-probedLock
		switch configDir {
		case provider.CanonicalDir(work):
			return authProbeResult{verdict: authProbeSignedIn, email: "me@work.test"}
		case provider.CanonicalDir(client):
			return authProbeResult{verdict: authProbeSignedIn, email: "me@client.test"}
		}
		return authProbeResult{verdict: authProbeSignedOut}
	}
	t.Cleanup(func() { authStatusProbe = prev })

	found := map[string]provider.Candidate{}
	for _, c := range discoverIn(context.Background(), home, filepath.Join(home, ".claude")) {
		found[c.Settings["configDir"].(string)] = c
	}

	for dir, label := range map[string]string{work: "me@work.test", client: "me@client.test"} {
		c, ok := found[provider.CanonicalDir(dir)]
		if !ok {
			t.Errorf("%s is not offered; found %v", dir, found)
			continue
		}
		if c.Label != label || c.Type != TypeName || c.Reason != provider.CandidateFound {
			t.Errorf("%s is offered as %+v", dir, c)
		}
	}
	if _, ok := found[provider.CanonicalDir(work)]; ok && found[provider.CanonicalDir(work)].DisplayName != provider.AccountName(Info().DisplayName, "work") {
		t.Errorf("~/.claude-work is offered as %q; want it named for its suffix", found[provider.CanonicalDir(work)].DisplayName)
	}
	for _, dir := range []string{filepath.Join(home, ".claude"), old, filepath.Join(home, ".claude_stale")} {
		if _, ok := found[provider.CanonicalDir(dir)]; ok {
			t.Errorf("%s is offered, but it is the default's, signed out, or holds no login", dir)
		}
	}
	for _, dir := range probed {
		if _, err := os.Stat(filepath.Join(dir, ".claude.json")); err != nil {
			t.Errorf("probed %s, which holds no .claude.json — the CLI would have created it", dir)
		}
	}
	if slices.Contains(probed, filepath.Join(home, ".claude-ghost")) {
		t.Errorf("probed the rc file's ~/.claude-ghost, which does not exist")
	}
}
