//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/atomicio"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// KeySource indicates where an API key was found
type KeySource string

const (
	KeySourceNone        KeySource = ""               // No key found
	KeySourceCredentials KeySource = "credentials"    // From ~/.juggler/credentials.json
	KeySourceEnvVar      KeySource = "env"            // From environment variable
	KeySourceCodexCLI    KeySource = "codex_cli"      // From ~/.codex/auth.json
	KeySourceCopilot     KeySource = "github_copilot" // Exchanged from the editor's Copilot OAuth login
)

// ProviderCredential is the resolved credential material for one provider.
type ProviderCredential struct {
	APIKey      string
	BearerToken string
	Headers     map[string]string
	KeySource   KeySource
	AuthHint    string
}

// CacheKey returns a non-secret identifier suitable for provider-client cache
// invalidation when credentials change.
func (c ProviderCredential) CacheKey() string {
	material := c.APIKey
	if material == "" {
		material = c.BearerToken
	}
	if material == "" {
		return string(c.KeySource)
	}
	if len(c.Headers) > 0 {
		keys := make([]string, 0, len(c.Headers))
		for key := range c.Headers {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		var b strings.Builder
		b.WriteString(material)
		for _, key := range keys {
			b.WriteString("\n")
			b.WriteString(key)
			b.WriteString(":")
			b.WriteString(c.Headers[key])
		}
		material = b.String()
	}
	sum := sha256.Sum256([]byte(material))
	return fmt.Sprintf("%s:%x", c.KeySource, sum[:8])
}

// CredentialsStore manages provider API keys in the user's home directory
// Keys are stored in ~/.juggler/credentials.json with restrictive permissions (0600)
type CredentialsStore struct {
	filePath string
}

// Credentials holds API keys for all providers
// Keys are stored as a flat map at the top level
// Example: {"anthropic_api_key": "sk-...", "gemini_api_key": "..."}
type Credentials map[string]string

// credFileLocks serialises read-modify-write sequences per credentials file.
// Save() alone is atomic (temp+rename) so the file never tears, but a
// load→modify→save across two concurrent callers can still lose updates: each
// loads a snapshot missing the other's write, mutates its own key, then the
// last atomic rename wins — silently dropping the other key. That is exactly
// how configuring the OpenAI-compatible provider (settings posts one
// PUT /api/config per field, un-awaited) could report "Saved." for every field
// yet persist none. Every mutating method holds the per-path lock across the
// whole sequence. Keyed by file path (not one global lock) so unrelated stores
// don't contend, and so the multiple CredentialsStore instances a process
// creates for the same file (NewCredentialsStore hands out a fresh struct per
// call) still share one lock.
//
// The lock is a 1-capacity channel used as a binary semaphore (the codebase
// forbids sync.Mutex): acquire by sending, release by receiving. credFileGate
// guards creation of the per-path locks the same way.
var (
	credFileGate  = make(chan struct{}, 1)
	credFileLocks = map[string]chan struct{}{}
)

// credFileLock returns the semaphore guarding read-modify-write on path,
// creating it on first use. Acquire with `lock <- struct{}{}`, release with
// `<-lock`.
func credFileLock(path string) chan struct{} {
	credFileGate <- struct{}{}
	defer func() { <-credFileGate }()
	lock, ok := credFileLocks[path]
	if !ok {
		lock = make(chan struct{}, 1)
		credFileLocks[path] = lock
	}
	return lock
}

// NewCredentialsStore creates a new credentials store
// Credentials are stored in ~/.juggler/credentials.json
func NewCredentialsStore() (*CredentialsStore, error) {
	return &CredentialsStore{
		filePath: filepath.Join(userpaths.ConfigDir(), "credentials.json"),
	}, nil
}

// Load reads credentials from the file
// Returns empty credentials if the file doesn't exist or is empty
func (s *CredentialsStore) Load() (Credentials, error) {
	// Check if file exists
	if _, err := os.Stat(s.filePath); os.IsNotExist(err) {
		// File doesn't exist, return empty credentials
		return make(Credentials), nil
	}

	// Read file. RobustReadFile retries on Windows' transient sharing-violation
	// window, which a concurrent Save's temp+rename publish can open under a
	// racing reader; on POSIX it is a direct read with no such window.
	data, err := atomicio.RobustReadFile(s.filePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read credentials file: %w", err)
	}

	// Handle empty file
	if len(data) == 0 {
		return make(Credentials), nil
	}

	// Parse JSON
	var creds Credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("failed to parse credentials file: %w", err)
	}

	// Ensure map is initialized
	if creds == nil {
		creds = make(Credentials)
	}

	return creds, nil
}

// Save writes credentials to the file with restrictive permissions (0600)
func (s *CredentialsStore) Save(creds Credentials) error {
	// Ensure directory exists
	dir := filepath.Dir(s.filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("failed to create credentials directory: %w", err)
	}

	// Marshal to JSON
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal credentials: %w", err)
	}

	// Write atomically (unique temp + rename) so a concurrent save never leaves
	// a torn file. os.WriteFile truncates-then-writes through one fd, so two
	// racing saves could interleave and a shorter write would leave trailing
	// bytes from a longer one — corrupting the JSON ("invalid character after
	// top-level value"). Each save gets its OWN temp via os.CreateTemp (the
	// server is one process with concurrent handlers, so a shared temp name
	// would itself collide), then rename atomically publishes a complete file;
	// last writer wins, every observable state is valid.
	tmp, err := os.CreateTemp(dir, "credentials-*.json.tmp")
	if err != nil {
		return fmt.Errorf("failed to write credentials file: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once the rename succeeds
	if err := tmp.Chmod(0600); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write credentials file: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return fmt.Errorf("failed to write credentials file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("failed to write credentials file: %w", err)
	}
	if err := atomicio.RobustRename(tmpName, s.filePath); err != nil {
		return fmt.Errorf("failed to write credentials file: %w", err)
	}

	return nil
}

// loadForWrite loads credentials for a read-modify-write operation. Unlike
// Load, a corrupt credentials file does not permanently block writes: the
// unparseable file is quarantined (renamed to credentials.json.corrupt) so its
// bytes survive for manual recovery, and an empty set is returned so the user
// can re-enter keys from the settings UI instead of being locked out forever.
func (s *CredentialsStore) loadForWrite() (Credentials, error) {
	creds, err := s.Load()
	if err == nil {
		return creds, nil
	}
	// File exists but is unparseable. Move it aside and start fresh. If the
	// quarantine rename itself fails, surface the original parse error rather
	// than risk clobbering whatever is there.
	quarantine := s.filePath + ".corrupt"
	if renameErr := atomicio.RobustRename(s.filePath, quarantine); renameErr != nil {
		return nil, err
	}
	jlog.Error("[Credentials] Quarantined corrupt credentials file to %s (%v); starting fresh", quarantine, err)
	return make(Credentials), nil
}

// findProviderInfo looks up provider info by name
func findProviderInfo(providerName string) *provider.ProviderInfo {
	providerInfos := provider.ListProviderInfos()
	for _, info := range providerInfos {
		if info.Name == providerName {
			return &info
		}
	}
	return nil
}

// GetAPIKey returns the API key for a specific provider.
// Checks the credentials file first, then falls back to the environment variable.
func (s *CredentialsStore) GetAPIKey(providerName string) (string, error) {
	info := findProviderInfo(providerName)
	if info == nil || info.ConfigKeyName == "" {
		return "", fmt.Errorf("unknown provider: %s", providerName)
	}

	// Check credentials file first
	creds, err := s.Load()
	if err != nil {
		return "", err
	}

	if key := creds[info.ConfigKeyName]; key != "" {
		return key, nil
	}

	// Fall back to environment variable
	if info.EnvVarName != "" {
		if key := os.Getenv(info.EnvVarName); key != "" {
			return key, nil
		}
	}

	return "", nil
}

// GetAPIKeySource returns where the API key for a provider is coming from
func (s *CredentialsStore) GetAPIKeySource(providerName string) KeySource {
	info := findProviderInfo(providerName)
	if info == nil || info.ConfigKeyName == "" {
		return KeySourceNone
	}

	creds, err := s.Load()
	if err != nil {
		return KeySourceNone
	}

	if creds[info.ConfigKeyName] != "" {
		return KeySourceCredentials
	}

	if info.EnvVarName != "" && os.Getenv(info.EnvVarName) != "" {
		return KeySourceEnvVar
	}

	return KeySourceNone
}

// SetAPIKey updates the API key for a specific provider
func (s *CredentialsStore) SetAPIKey(providerName string, apiKey string) error {
	info := findProviderInfo(providerName)
	if info == nil || info.ConfigKeyName == "" {
		return fmt.Errorf("unknown provider: %s", providerName)
	}

	configKeyName := info.ConfigKeyName

	lock := credFileLock(s.filePath)
	lock <- struct{}{}
	defer func() { <-lock }()

	// Load current credentials
	creds, err := s.loadForWrite()
	if err != nil {
		return err
	}

	// Update key in map
	if apiKey == "" {
		// Empty string means delete the key
		delete(creds, configKeyName)
	} else {
		creds[configKeyName] = apiKey
	}

	// Save updated credentials
	return s.Save(creds)
}

// HasKey returns whether a provider has an API key configured
func (s *CredentialsStore) HasKey(providerName string) bool {
	key, err := s.GetAPIKey(providerName)
	return err == nil && key != ""
}

func codexAuthPath() (string, error) {
	if codexHome := os.Getenv("CODEX_HOME"); codexHome != "" {
		return filepath.Join(codexHome, "auth.json"), nil
	}
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("failed to get user home directory: %w", err)
	}
	return filepath.Join(homeDir, ".codex", "auth.json"), nil
}

type codexAuthFile struct {
	AuthMode string `json:"auth_mode"`
	Tokens   struct {
		AccessToken string `json:"access_token"`
		AccountID   string `json:"account_id"`
	} `json:"tokens"`
}

func codexSignInHint(path string) string {
	return fmt.Sprintf("sign in with the Codex app or run `codex login` (checked %s)", path)
}

func loadCodexCLIAccessToken() (string, string, error) {
	path, err := codexAuthPath()
	if err != nil {
		return "", "", err
	}
	hint := codexSignInHint(path)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", "", fmt.Errorf("codex auth not found; %s", hint)
		}
		return "", "", fmt.Errorf("failed to read Codex auth. %s", hint)
	}

	var auth codexAuthFile
	if err := json.Unmarshal(data, &auth); err != nil {
		return "", "", fmt.Errorf("failed to parse Codex auth. %s", hint)
	}
	if auth.AuthMode != "chatgpt" {
		return "", "", fmt.Errorf("codex is not signed in with ChatGPT; %s", hint)
	}
	if auth.Tokens.AccessToken == "" {
		return "", "", fmt.Errorf("codex access token is missing; %s", hint)
	}
	if jwtExpired(auth.Tokens.AccessToken, time.Now()) {
		return "", "", fmt.Errorf("codex access token is expired; %s", hint)
	}
	return auth.Tokens.AccessToken, auth.Tokens.AccountID, nil
}

func jwtExpired(token string, now time.Time) bool {
	parts := strings.Split(token, ".")
	if len(parts) < 2 {
		return true
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return true
	}
	var claims map[string]any
	if err := json.Unmarshal(payload, &claims); err != nil {
		return true
	}
	exp, ok := claims["exp"]
	if !ok {
		return true
	}
	var expUnix int64
	switch v := exp.(type) {
	case float64:
		expUnix = int64(v)
	case string:
		parsed, err := strconv.ParseInt(v, 10, 64)
		if err != nil {
			return true
		}
		expUnix = parsed
	default:
		return true
	}
	return !now.Before(time.Unix(expUnix, 0))
}

// IsProviderEnabled returns whether a keyless provider (like claudecode) is enabled
// Keyless providers store their enabled state as "enabled_<providerName>": "true"
func (s *CredentialsStore) IsProviderEnabled(providerName string) bool {
	creds, err := s.Load()
	if err != nil {
		return false
	}
	return creds["enabled_"+providerName] == "true"
}

// SetProviderEnabled enables or disables a keyless provider
func (s *CredentialsStore) SetProviderEnabled(providerName string, enabled bool) error {
	lock := credFileLock(s.filePath)
	lock <- struct{}{}
	defer func() { <-lock }()

	creds, err := s.loadForWrite()
	if err != nil {
		return err
	}

	key := "enabled_" + providerName
	if enabled {
		creds[key] = "true"
	} else {
		creds[key] = "false"
	}

	return s.Save(creds)
}

// HasProviderFlag returns whether a provider has an enabled/disabled flag set.
// This distinguishes "never configured" from "user explicitly disabled".
func (s *CredentialsStore) HasProviderFlag(providerName string) bool {
	creds, err := s.Load()
	if err != nil {
		return false
	}
	_, exists := creds["enabled_"+providerName]
	return exists
}

// GetRawKey returns the raw string stored under key in the credentials file,
// or "" if missing. No provider-registry lookup or env-var fallback.
func (s *CredentialsStore) GetRawKey(key string) string {
	creds, err := s.Load()
	if err != nil {
		return ""
	}
	return creds[key]
}

// SetRawKey stores an arbitrary key-value pair in the credentials file.
// An empty value deletes the key.
func (s *CredentialsStore) SetRawKey(key, value string) error {
	lock := credFileLock(s.filePath)
	lock <- struct{}{}
	defer func() { <-lock }()

	creds, err := s.loadForWrite()
	if err != nil {
		return err
	}
	if value == "" {
		delete(creds, key)
	} else {
		creds[key] = value
	}
	return s.Save(creds)
}

// GetProviderCredential returns the resolved credential for a provider if available.
func (s *CredentialsStore) GetProviderCredential(providerName string) (ProviderCredential, error) {
	// Find provider info
	providerInfos := provider.ListProviderInfos()
	var providerInfo *provider.ProviderInfo
	for i := range providerInfos {
		if providerInfos[i].Name == providerName {
			providerInfo = &providerInfos[i]
			break
		}
	}
	if providerInfo == nil {
		return ProviderCredential{}, fmt.Errorf("unknown provider: %s", providerName)
	}

	switch providerInfo.EffectiveAuthType() {
	case provider.AuthTypeToggle:
		if !s.IsProviderEnabled(providerName) {
			return ProviderCredential{}, fmt.Errorf("provider %s is not enabled", providerName)
		}
		return ProviderCredential{AuthHint: "Enabled"}, nil

	case provider.AuthTypeOAuthBearer:
		resolver, ok := lookupOAuthBearerSource(providerInfo.AuthSource)
		if !ok {
			return ProviderCredential{}, fmt.Errorf("unsupported OAuth bearer source for provider %s: %s", providerName, providerInfo.AuthSource)
		}
		return resolver()

	case provider.AuthTypeAPIKey:
		apiKey, err := s.GetAPIKey(providerName)
		if err != nil {
			return ProviderCredential{}, err
		}
		if apiKey == "" {
			return ProviderCredential{}, fmt.Errorf("no API key configured for provider: %s", providerName)
		}
		return ProviderCredential{
			APIKey:    apiKey,
			KeySource: s.GetAPIKeySource(providerName),
			AuthHint:  "API key configured",
		}, nil

	default:
		return ProviderCredential{}, fmt.Errorf("unsupported auth type for provider %s: %s", providerName, providerInfo.EffectiveAuthType())
	}
}

// GetProviderCredentialString returns the legacy string credential for a provider.
// New code should use GetProviderCredential so OAuth bearer tokens are not
// mislabeled as API keys.
func (s *CredentialsStore) GetProviderCredentialString(providerName string) (string, error) {
	cred, err := s.GetProviderCredential(providerName)
	if err != nil {
		return "", err
	}
	if cred.APIKey != "" {
		return cred.APIKey, nil
	}
	return cred.BearerToken, nil
}
