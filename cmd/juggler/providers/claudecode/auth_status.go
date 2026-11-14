//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"bytes"
	"context"
	"encoding/json"
	"time"

	"juggler/cmd/juggler/msg"
)

// authProbeVerdict is what `claude auth status` told us. The third case is the
// important one: the CLI is old enough not to have the subcommand, or answered
// with something we can't read, and we must not pretend either way.
type authProbeVerdict int

const (
	authProbeUnknown authProbeVerdict = iota
	authProbeSignedIn
	authProbeSignedOut
)

// claudeAuthStatusTimeout bounds the probe. It reads a local credential store,
// so anything approaching this means the CLI is wedged, and a wedged probe must
// not hold up a provider refresh.
const claudeAuthStatusTimeout = 10 * time.Second

// authProbeInterval throttles the probe. Provider refreshes are triggered by
// several unrelated things (a credential file changing, a settings save,
// startup), and while the sign-in is expired every one of them would otherwise
// spawn a process.
const authProbeInterval = 10 * time.Second

// authProbeResult is what one auth-status probe found: the verdict, and who is
// signed in when it said.
type authProbeResult struct {
	verdict authProbeVerdict
	// email is the signed-in account's address, when the CLI reports one.
	// Display only, never identity.
	email string
}

// authStatusProbe is the seam tests replace. Production always uses
// runClaudeAuthStatus.
var authStatusProbe = runClaudeAuthStatus

// claudeCLIInstalled is the seam tests replace so readiness doesn't depend on
// what the machine has installed. Production always uses detectClaudeCLI.
var claudeCLIInstalled = detectClaudeCLI

// claudeNotInstalledHint is the readiness hint when no claude CLI can be
// located: shown beside the greyed-out models and on the provider's settings
// card, directly above its CLI-path field. It names both ways out, since a CLI
// Juggler can't find is fixed by pointing at it, and one that isn't there by
// installing it — and names no place, because it is read in two.
var claudeNotInstalledHint = msg.New("Claude Code CLI not found — install it, or enter the path to claude.")

// runClaudeAuthStatus asks the CLI whether it is signed in.
//
// `claude auth status` is the only supported way to ask: it is non-interactive,
// prints JSON when stdout is not a terminal, and never opens a browser. Reading
// the credential store ourselves was rejected — it is the Keychain on macOS and
// a file elsewhere, the schema is internal, and rotation can leave the two
// disagreeing.
//
// The subcommand does not exist on older CLI builds. That is not an error worth
// reporting: it simply means we cannot know, which authProbeUnknown says.
//
// configDir is the account's config dir, "" for the default account.
func runClaudeAuthStatus(ctx context.Context, configDir string) authProbeResult {
	bin := claudeBinary()
	if bin == "" {
		return authProbeResult{verdict: authProbeUnknown}
	}
	ctx, cancel := context.WithTimeout(ctx, claudeAuthStatusTimeout)
	defer cancel()

	cmd := claudeCommand(ctx, bin, []string{"auth", "status"})
	cmd.Env = spawnEnv(bin, testExtraSpawnEnv, configDir)
	// No stdin. Nothing here should ever be able to wait for a person.
	cmd.Stdin = nil
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	// The exit status is deliberately ignored: it has been observed non-zero
	// alongside a perfectly good "loggedIn": true, because unrelated warnings
	// reach it too. The JSON is the answer; the exit code is noise.
	_ = cmd.Run()

	return authProbeResult{verdict: parseClaudeAuthStatus(stdout.Bytes()), email: parseClaudeAuthEmail(stdout.Bytes())}
}

// parseClaudeAuthStatus reads the probe's stdout. Split out from the spawn
// because this is the part that breaks when the CLI changes its output, and it
// is worth testing against every shape it might produce.
func parseClaudeAuthStatus(stdout []byte) authProbeVerdict {
	var parsed struct {
		// A pointer so an object that simply lacks the field is told apart from
		// one that reports false. Decoding into a bool would silently read a
		// "Did you mean…?" JSON blob as "signed out" and disable the provider.
		LoggedIn *bool `json:"loggedIn"`
	}
	if err := json.Unmarshal(bytes.TrimSpace(stdout), &parsed); err != nil {
		return authProbeUnknown
	}
	if parsed.LoggedIn == nil {
		return authProbeUnknown
	}
	if *parsed.LoggedIn {
		return authProbeSignedIn
	}
	return authProbeSignedOut
}

// parseClaudeAuthEmail reads who is signed in from the probe's stdout, or ""
// when it does not say.
func parseClaudeAuthEmail(stdout []byte) string {
	var parsed struct {
		Email string `json:"email"`
	}
	if json.Unmarshal(bytes.TrimSpace(stdout), &parsed) != nil {
		return ""
	}
	return parsed.Email
}

// authProbeDue rate-limits the probe to one spawn per authProbeInterval, per
// account.
func authProbeDue(id string) bool {
	probeAt := &loginFor(id).authProbeAt
	now := time.Now().UnixNano()
	last := probeAt.Load()
	if last != 0 && now-last < int64(authProbeInterval) {
		return false
	}
	return probeAt.CompareAndSwap(last, now)
}

// readinessOf reports whether the CLI can serve a turn as account a right now,
// and if not why. Registered as each account's ReadinessCheck, so a false here
// makes the provider unavailable and shows the hint.
//
// It first refuses when no CLI can be located at all. The provider is a toggle,
// so switching it on in settings credentials it whether or not claude is
// installed; counted as available, a missing CLI would win the default model,
// keep the setup wizard away, and fail every turn. This is no fail-closed probe:
// the lookup is a stat, re-run on every refresh (claudeBinary re-resolves
// whenever it holds no runnable path), so an install or a path set in settings re-enables the
// provider on the next refresh.
//
// Beyond that it refuses on one signal only: a real turn that failed to
// authenticate. The probe is never allowed to disable the provider, because
// `claude auth status` has been observed reporting "loggedIn": true in a context where a turn had
// just taken a genuine 401, and reporting false where an interactive login was
// working fine. A wrong answer in that direction takes away the user's only way
// of working.
//
// While expired, the probe runs — throttled — and can only ever RE-ENABLE. It
// clears the expiry when it says signed in, and equally when it cannot answer at
// all. That second case is not laziness: an old CLI has no `auth status`, and if
// only a successful turn could clear the expiry, a provider we had disabled
// could never be re-enabled by one. Letting the turn through means the worst
// case is the same error again, reported properly, instead of a dead end.
//
// An added account differs in one way: before a turn has confirmed it, it is
// most often not signed in yet, so the last probe's definite "signed out"
// keeps it unready, with the command that signs it in. That probe runs in the
// background (probeInBackground), never on the path of a refresh.
func readinessOf(a account) (bool, msg.Message) {
	if !claudeCLIInstalled() {
		return false, claudeNotInstalledHint
	}
	id := a.id()
	probeInBackground(a)
	switch currentClaudeLoginState(id) {
	case loginExpired:
		if !authProbeDue(id) || probeAccount(a) == authProbeSignedOut {
			return false, signInHintFor(a)
		}
		clearClaudeLoginExpired(id)
	case loginUnknown:
		if a.configDir != "" && authProbeVerdict(loginFor(id).lastVerdict.Load()) == authProbeSignedOut {
			return false, signInHintFor(a)
		}
	case loginConfirmed:
	}
	return true, msg.Message{}
}
