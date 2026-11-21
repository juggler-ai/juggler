//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package claudecode

import (
	"context"
	"errors"
	"os"

	"juggler/cmd/juggler/msg"
	"juggler/cmd/juggler/providers/provider"
)

// Several Claude Code accounts — two subscriptions, a personal and a work
// login — are the same unmodified claude CLI, each run with its own
// CLAUDE_CONFIG_DIR, which is Anthropic's documented way to keep several
// logins. The user signs each one in inside the CLI (/login); Juggler never
// reads, copies or moves a token between config dirs, never runs
// `claude auth login` or `setup-token`, and never switches a conversation to
// another account on its own (docs/provider-auth-policy.md).
//
// The type's default account is the claude Juggler always ran: it inherits
// Juggler's environment untouched. Each further account is registered as its
// own provider ("claudecode-work"), so a conversation picks its account by
// picking one of its models, and everything keyed by provider name — the
// conversation's claude process, its login state, its usage — is its own.

// TypeName is the provider type, and the id of its default account.
const TypeName = "claudecode"

// AccountType gives the type what its further accounts need.
func AccountType(t *provider.TypeInfo) {
	t.Instantiate = Instantiate
	t.Discover = Discover
	t.PrepareSettings = PrepareSettings
	t.SignInCommand = SignInCommand
	t.LoginKey = LoginKey
	t.Forget = Forget
}

// defaultAccountID is the default account's provider id: the type's bare name,
// which conversations and settings that name Claude Code's default account
// carry.
const defaultAccountID = TypeName

// configDirSetting is the account setting holding an extra account's config dir.
const configDirSetting = "configDir"

// account is the Claude Code login a Client's claude runs under. The zero value
// is the type's default account.
type account struct {
	// name is the account's provider id; "" for the default account.
	name string
	// configDir is an extra account's config dir, absolute and canonical
	// (provider.CanonicalDir); "" for the default account.
	configDir string
}

// id is the account's provider id.
func (a account) id() string {
	if a.name == "" {
		return defaultAccountID
	}
	return a.name
}

// accountInitializer is the provider initializer for one account: NewClient,
// with every Client it builds running claude as that account.
func accountInitializer(a account) provider.ProviderInitializer {
	return func(cfg provider.Config) (provider.Provider, error) {
		p, err := NewClient(cfg)
		if err != nil {
			return nil, err
		}
		p.(*Client).acct = a
		return p, nil
	}
}

// Instantiate builds the provider for one extra account from its
// accounts.json entry: the default account's provider, under the account's id
// and name, running claude in the account's config dir. It has no AutoDetect —
// the server would record an enabled flag for it — because an extra account is
// switched on by existing.
func Instantiate(acct provider.Account) (provider.ProviderInfo, provider.ProviderInitializer, error) {
	dir, _ := acct.Settings[configDirSetting].(string)
	if dir == "" {
		return provider.ProviderInfo{}, nil, errors.New("no config dir")
	}
	a := account{name: acct.ID, configDir: dir}
	info := Info()
	info.Name = acct.ID
	info.Type = TypeName
	info.DisplayName = acct.DisplayName
	if info.DisplayName == "" {
		info.DisplayName = Info().DisplayName
	}
	info.AutoDetect = nil
	info.ReadinessCheck = func() (bool, msg.Message) { return readinessOf(a) }
	info.AccountLabel = accountLabel(a.id())
	return info, accountInitializer(a), nil
}

// PrepareSettings validates an extra account's settings and gives its config
// dir its one spelling, before it is saved. The CLI keys its macOS Keychain
// entry on the config dir's path, so "~/.claude-work/" and
// "/Users/me/.claude-work" must not be two accounts. A dir that does not exist
// yet is left for the CLI to create, which it does on its first run.
func PrepareSettings(settings map[string]any) (map[string]any, error) {
	raw, _ := settings[configDirSetting].(string)
	dir, err := provider.PrepareAccountDir(raw, defaultConfigDir())
	if err != nil {
		return nil, err
	}
	return map[string]any{configDirSetting: dir}, nil
}

// LoginKey is the login an account's settings name: its config dir.
func LoginKey(settings map[string]any) string {
	raw, _ := settings[configDirSetting].(string)
	return provider.FolderLoginKey(raw)
}

// SignInCommand is the command that opens claude as an account, for the user
// to sign it in with /login; "" for an account with none to give.
func SignInCommand(acct provider.Account) string {
	dir, _ := acct.Settings[configDirSetting].(string)
	if dir == "" {
		return ""
	}
	return signInCommand(dir)
}

// signInCommand runs claude in configDir, spelt exactly as Juggler runs it: a
// different spelling of the same folder is a different Keychain entry.
func signInCommand(configDir string) string {
	return provider.SignInCommandLine("CLAUDE_CONFIG_DIR", configDir, "claude")
}

// signInHintFor is the readiness hint for an account that is not signed in:
// the default account's own words, or the command that opens an extra
// account's claude.
func signInHintFor(a account) msg.Message {
	if a.configDir == "" {
		return claudeSignInHint
	}
	return msg.New("This Claude Code account isn't signed in. Run {command} in a terminal and use /login.",
		"command", signInCommand(a.configDir))
}

// probeAccount asks claude whether account a is signed in, and keeps who is.
func probeAccount(a account) authProbeVerdict {
	return keepProbe(a, authStatusProbe(context.Background(), a.configDir))
}

// keepProbe records what a probe of account a answered: whether it is signed
// in, and who as.
func keepProbe(a account, res authProbeResult) authProbeVerdict {
	r := loginFor(a.id())
	r.lastVerdict.Store(int32(res.verdict))
	if res.email != "" {
		setAccountLabel(a.id(), res.email)
	} else if res.verdict == authProbeSignedIn {
		r.noEmail.Store(true)
	}
	return res.verdict
}

// probeInBackground asks claude about account a, off the caller's path and at
// most once per authProbeInterval, when there is something to learn: whether
// an added account no turn has confirmed yet is signed in, or who an account
// is signed in as — the default account's only once there is another to tell
// it apart from in the model picker. A changed answer republishes the
// providers.
func probeInBackground(a account) {
	id := a.id()
	r := loginFor(id)
	unsure := a.configDir != "" && currentClaudeLoginState(id) == loginUnknown
	wantLabel := accountLabel(id) == "" && !r.noEmail.Load() && (a.configDir != "" || hasExtraAccounts())
	if !unsure && !wantLabel || !authProbeDue(id) {
		return
	}
	// Taken here, on the caller's goroutine: the probe outlives the call.
	probe := authStatusProbe
	go func() {
		before := r.lastVerdict.Load()
		if keepProbe(a, probe(context.Background(), a.configDir)) != authProbeVerdict(before) {
			provider.AccountChanged()
		}
	}()
}

// hasExtraAccounts reports whether an account beyond the default is registered.
func hasExtraAccounts() bool {
	for _, info := range provider.ListProviderInfos() {
		if info.Type == TypeName && info.Name != defaultAccountID {
			return true
		}
	}
	return false
}

// accountLabel is who the account id was last seen signed in as, or "".
func accountLabel(id string) string {
	if p := loginFor(id).label.Load(); p != nil {
		return *p
	}
	return ""
}

// setAccountLabel records who account id is signed in as, and shows it on the
// account's card and, where it tells two accounts apart, in the picker.
func setAccountLabel(id, label string) {
	loginFor(id).label.Store(&label)
	provider.SetAccountLabel(id, label)
}

// defaultConfigDir is the config dir the default account's claude uses: the
// CLAUDE_CONFIG_DIR Juggler inherited, or ~/.claude, resolved as the CLI
// resolves it when run from Juggler's own working directory.
func defaultConfigDir() string {
	wd, _ := os.Getwd()
	return claudeConfigDir(wd, "")
}
