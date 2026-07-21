//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/syswake"
	"juggler/cmd/juggler/worker"
	"juggler/internal/jlog"
	"juggler/internal/updatecheck"

	"github.com/gorilla/mux"
	"github.com/gorilla/websocket"
)

// Timeout configuration for background provider/model operations.
const (
	// ProviderInitTimeout bounds a single upstream model-list call. Kept short
	// so that a slow / hung upstream cannot accumulate live TLS connections
	// across repeated UI-driven /api/providers requests.
	ProviderInitTimeout = 30 * time.Second

	// ProvidersReadyTimeout bounds how long a default-model lookup waits for the
	// first provider refresh to populate the cache before deriving an answer
	// from whatever is cached. It exceeds ProviderInitTimeout so the slowest
	// provider's model discovery (e.g. the claudecode CLI) can complete.
	ProvidersReadyTimeout = ProviderInitTimeout + 2*time.Second
)

// sameOriginCheck is the WebSocket upgrader's Origin gate. Browsers send an
// Origin header on cross-origin WebSocket handshakes; a same-origin page
// either omits it or sends one whose host matches the request's Host header.
// Non-browser clients (CLI tools, integration tests) typically omit Origin,
// which we allow — the LAN gate middleware already restricts who can reach
// the listener. The check exists to stop a different web page the user is
// browsing from opening a socket to the local agent.
//
// Every client — LAN browsers, the desktop app's windows, and the hidden
// engine WebView — reaches the server over plain http://<addr>/..., so their
// Origin matches r.Host uniformly and the check needs no special cases.
func sameOriginCheck(r *http.Request) bool {
	// Modern browsers stamp Sec-Fetch-Site on the handshake; a "cross-site" value
	// is a definitive cross-origin signal even when Origin is absent or spoofed,
	// so reject it outright before trusting the Origin/Host comparison below.
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Host == r.Host
}

// unmarshalWS decodes a raw WebSocket message into T, logging a parse error and
// returning ok=false on failure. The caller should `continue` the read loop on
// ok=false.
func unmarshalWS[T any](data []byte, label string) (T, bool) {
	var v T
	if err := json.Unmarshal(data, &v); err != nil {
		jlog.Error("WebSocket: failed to parse %s: %v", label, err)
		return v, false
	}
	return v, true
}

// Server represents the HTTP server
type Server struct {
	router            *mux.Router
	upgrader          websocket.Upgrader
	addr              string
	listener          net.Listener // Bound listener (set after BindPort())
	devMode           bool         // Inspector / right-click menu + front-end JUGGLER_DEV_MODE (no source checkout needed)
	assetsFromDisk    bool         // Serve web assets from the on-disk web/ tree with live reload (requires a source checkout)
	testMode          bool         // Set when test routes are registered; disables network calls in provider listing
	bootProjectPath   string
	opsAPI            *handlers.OpsAPI
	completionsAPI    *handlers.CompletionsAPI
	gitStatusAPI      *handlers.GitStatusAPI
	extensionsAPI     *handlers.ExtensionsAPI
	userCommandsAPI   *handlers.UserCommandsAPI
	skillsAPI         *handlers.SkillsAPI
	skillsRegistryAPI *handlers.SkillsRegistryAPI
	configAPI         *handlers.ConfigAPI
	defaultModelStore *core.DefaultModelStore
	recentsStore      *core.RecentsStore
	recentModelsStore *core.RecentModelsStore

	// systemPromptPresetStore persists user-saved system-prompt presets and the
	// chosen session-default preset id (~/.juggler/system-prompt-presets.json).
	systemPromptPresetStore *core.SystemPromptPresetStore
	indexTemplate           *template.Template // Template for index.html with cache busting
	staticVersion           string             // Random version string for cache-busted static paths
	apiToken                string             // Per-instance token gating the sensitive /api surface + viewer WS (see api_auth.go)
	startTime               time.Time          // Server start time for health/instance endpoint
	shutdownChan            chan struct{}
	shutdownOnce            sync.Once
	workerManager           *worker.Manager      // Go worker manager
	sessionAPI              *handlers.SessionAPI // Kept so RegisterTestRoutes can wire test-mode hooks
	extraRoutes             func(r *mux.Router)  // Optional Config.ExtraRoutes hook, invoked at the end of setupRoutes

	// conversationCache holds the per-conversation Provider.Conversation
	// handles: one handle per (convID, providerName, model), opened lazily
	// on first LLM call, closed on conversation delete or server shutdown.
	conversationCache *conversationCache

	// providersList holds the most recent push-only provider/model snapshot.
	// Populated by RefreshProviders at startup and after each credential
	// mutation; consumed by handleProviders / handleGetContextWindow and
	// broadcast to all clients via the providers-update WS event.
	providersList atomic.Pointer[[]ProviderStatus]
	// refreshToken is a size-1 token that coalesces refreshes — a burst of
	// credential edits collapses into a single recompute.
	refreshToken chan struct{}
	// providersReady is closed once the first provider refresh completes.
	// Lookups that derive their answer from the live provider list (the
	// implicit default-model selection) wait on it so a conversation created
	// during the startup discovery window is seeded from the real provider set
	// rather than the still-empty cache. providersReadyOnce guards the close.
	providersReady     chan struct{}
	providersReadyOnce sync.Once

	publicMode atomic.Bool                  // true = accept connections from non-localhost IPs
	tunnel     atomic.Pointer[activeTunnel] // non-nil when a tunnel is active

	// Per-project state, swapped atomically on project change.
	projectState atomic.Pointer[projectState]
	switchToken  chan struct{} // size-1 token; serializes SwitchProject

	// hub owns the set of all connected WebSocket clients — used for full-fleet
	// broadcasts (project-changed, providers-update, shutdown notices).
	hub *clientHub
	// engineClient is the headless engine WS connection, or nil. Set on
	// engine-role upgrade and cleared on disconnect.
	engineClient atomic.Pointer[WSClient]

	// stats, when non-nil (JUGGLER_WS_STATS set), accounts WebSocket payload
	// bytes per direction / message type and periodically logs a table plus the
	// modeled permessage-deflate ratio. Diagnostic only; nil in normal runs.
	stats *wsStats

	// updateChecker polls the remote version manifest (juggler.studio) and holds
	// the latest "new version available" decision in memory. Created in New; its
	// poll loop is started by StartBackgroundServices (production only — skipped in test
	// mode so the suite never reaches the network). nil only before New finishes.
	updateChecker *updatecheck.Checker

	// settings owns the global settings document (~/.juggler/settings.json),
	// the single source of truth for the user's update mode. Created in New; the
	// update-checker's Enabled gate and the /api/settings handlers read/write
	// through it. nil only before New finishes (and in bare test Servers).
	settings *settingsStore

	// engineReadyGate, when set, is called at the start of every LLM turn (and
	// before a worker-driven strategy hook) to guarantee the hidden engine
	// WebView is connected before the turn can emit any tool request. Returns
	// false if the engine did not connect in time. Nil in test mode and the
	// test-pool, where the engine is an always-connected iframe.
	engineReadyGate atomic.Pointer[EngineReadyGate]
}

// EngineReadyGate blocks until the always-alive hidden engine WebView is
// connected and ready to execute tools, returning true on success. Wired from
// the production headless path via SetEngineReadyGate (see startEngine); it only
// ever blocks during the startup connect window or a watchdog re-exec restart.
type EngineReadyGate func() bool

// Config contains server configuration
type Config struct {
	SessionManager *core.SessionManager
	Host           string
	Port           int
	DevMode        bool               // If true, enable the web inspector / right-click menu (front-end dev mode); no source checkout required
	AssetsFromDisk bool               // If true, serve static files from the on-disk web/ tree with live reload; requires a source checkout
	ProjectPath    string             // Project root path (for resolving static files when AssetsFromDisk is set)
	BootLock       *core.InstanceLock // Optional boot-time instance lock; ownership transfers to server.
	// ExtraRoutes, if set, is called at the end of setupRoutes with the
	// server's router, so a wrapping distribution can register additional
	// HTTP routes without editing this package. Routes registered here pass
	// through the same router-wide middleware as built-ins: CORS, cache
	// control, the LAN gate, and — for paths under /api/ — the per-instance
	// session-token auth (see apiAuthMiddleware). Must not shadow existing
	// routes.
	ExtraRoutes func(r *mux.Router)
}

// New creates a new server
func New(cfg Config) (*Server, error) {
	if cfg.SessionManager == nil {
		return nil, fmt.Errorf("session manager is required")
	}

	router := mux.NewRouter()
	upgrader := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     sameOriginCheck,
		// permessage-deflate (RFC 7692) is negotiated per-connection in
		// handleWebSocket — enabled only for remote (tunnel / LAN) peers, where
		// the link is the bottleneck, and left off for loopback (engine + local
		// viewer), where deflate is pure CPU cost. See handleWebSocket.
	}

	wm := worker.NewManager()

	// When the OS resumes from sleep, cancel any in-flight LLM request whose
	// connection the sleep likely dropped, so the turn fails fast instead of
	// riding the LLMTimeout backstop. syswake.Fire() is called from the
	// platform sleep/wake observer (darwin: the NSWorkspace DidWake hook).
	syswake.OnWake(wm.SystemDidWake)

	// Server skeleton created up-front so handler providers can close over its accessors.
	s := &Server{}

	sessionAPI := handlers.NewSessionAPI(s.SessionManager, wm, serverBroadcaster{srv: s}, func(convID string) {
		// Closure captures the (yet-to-be-set) cache pointer on s so
		// SessionAPI can release conversation-scoped provider resources
		// on delete without depending on this package's types.
		if cc := s.conversationCache; cc != nil {
			cc.CloseConversation(convID)
		}
		// Clear any workspace binding for the deleted conversation (safety net;
		// the extension owns tearing down the underlying workspace itself).
		s.unbindWorkspace(convID)
	}, s.resolveDefaultModel)

	configAPI, err := handlers.NewConfigAPI(s.ProjectPath, s.RefreshProviders, func() {
		s.broadcastToAll(map[string]any{"type": "plugin-changed", "path": "config/plugins"})
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create config API: %w", err)
	}

	defaultModelStore, err := core.NewDefaultModelStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create default model store: %w", err)
	}

	systemPromptPresetStore, err := core.NewSystemPromptPresetStore()
	if err != nil {
		return nil, fmt.Errorf("failed to create system prompt preset store: %w", err)
	}

	extensionsAPI := createExtensionsAPI(cfg.AssetsFromDisk)

	staticVersion := generateStaticVersion()
	recents, _ := core.NewRecentsStore()
	recentModels, _ := core.NewRecentModelsStore()

	// Field-by-field initialization of the up-front skeleton — NEVER replace
	// this with a wholesale `*s = Server{...}` literal: the skeleton pointer
	// has already been captured by closures and constructors above, and a
	// struct-literal reassignment silently zeroes every field assigned to `s`
	// before it (this exact bug shipped once: sessionAPI was set on the
	// skeleton, wiped by the literal, and the test-mode ownership guard ran
	// unwired through a full green suite).
	s.router = router
	s.upgrader = upgrader
	s.addr = fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	s.devMode = cfg.DevMode
	s.assetsFromDisk = cfg.AssetsFromDisk
	s.bootProjectPath = cfg.ProjectPath
	s.extraRoutes = cfg.ExtraRoutes
	s.opsAPI = handlers.NewOpsAPI(s.ProjectPath, s.workspaceRemapper)
	s.completionsAPI = handlers.NewCompletionsAPI(s.ProjectPath, func() ops.PathSearcher {
		if fw := s.FileWatcher(); fw != nil {
			return fw.Index()
		}
		return nil
	})
	s.gitStatusAPI = handlers.NewGitStatusAPI(s.ProjectPath, s.workspaceRoot)
	s.extensionsAPI = extensionsAPI
	s.userCommandsAPI = handlers.NewUserCommandsAPI(s.ProjectPath)
	s.skillsAPI = handlers.NewSkillsAPI(s.ProjectPath)
	s.skillsRegistryAPI = handlers.NewSkillsRegistryAPI(s.ProjectPath, s.skillsAPI)
	s.configAPI = configAPI
	s.defaultModelStore = defaultModelStore
	s.systemPromptPresetStore = systemPromptPresetStore
	s.recentsStore = recents
	s.recentModelsStore = recentModels
	s.staticVersion = staticVersion
	s.apiToken = mintAPIToken()
	s.startTime = time.Now()
	s.shutdownChan = make(chan struct{})
	s.workerManager = wm
	s.sessionAPI = sessionAPI
	s.conversationCache = newConversationCache()
	s.refreshToken = make(chan struct{}, 1)
	s.providersReady = make(chan struct{})
	s.switchToken = make(chan struct{}, 1)
	s.switchToken <- struct{}{}

	s.stats = newWSStats()

	s.seedProjectState(cfg)

	s.hub = newClientHub()
	s.settings = newSettingsStore()
	s.updateChecker = s.newUpdateChecker()

	if err := s.loadIndexTemplate(); err != nil {
		return nil, fmt.Errorf("failed to load index template: %w", err)
	}

	s.router.Use(s.lanGateMiddleware)
	s.router.Use(s.apiAuthMiddleware)

	s.setupSessionRoutes(sessionAPI)
	s.setupConfigRoutes(configAPI)
	s.setupConnectivityRoutes()
	s.setupLogsRoutes()
	s.setupProjectRoutes()
	s.setupRoutes()

	s.wireWorkerManager()

	return s, nil
}
