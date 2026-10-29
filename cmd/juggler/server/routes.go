//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"fmt"
	"io/fs"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server/handlers"
	"juggler/cmd/juggler/webui"
	"juggler/internal/apipaths"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
	"juggler/web"
)

// createExtensionsAPI constructs the unified manifest-driven ExtensionsAPI, the
// single owner of extension discovery and the on-disk locations they live in.
func createExtensionsAPI(assetsFromDisk bool) *handlers.ExtensionsAPI {
	var builtinFS fs.FS
	builtinDir := "" // disk path of web/ when serving assets from disk, so builtin extensions expose revealable files
	if assetsFromDisk {
		if webDir := findWebDir(); webDir != "" {
			builtinFS = os.DirFS(webDir)
			builtinDir = webDir
			jlog.Info("📂 Assets-from-disk: Loading builtin assets from disk: %s", webDir)
		} else {
			jlog.Error("Assets-from-disk: Could not find web/ directory, using embedded files")
			builtinFS, _ = fs.Sub(web.Files, ".")
		}
	} else {
		builtinFS, _ = fs.Sub(web.Files, ".")
	}

	userExtensionDir := filepath.Join(userpaths.ConfigDir(), "extensions")
	return handlers.NewExtensionsAPI(builtinFS, builtinDir, userExtensionDir)
}

// generateStaticVersion produces a random 4-char base36 string for cache-busting asset URLs.
func generateStaticVersion() string {
	versionBytes := make([]byte, 3)
	_, _ = rand.Read(versionBytes)
	n := new(big.Int).SetBytes(versionBytes)
	n.Mod(n, big.NewInt(36*36*36*36))
	v := n.Text(36)
	for len(v) < 4 {
		v = "0" + v
	}
	return v
}

// seedProjectState initialises the atomic projectState from the boot configuration.
func (s *Server) seedProjectState(cfg Config) {
	initialProjectPath := cfg.ProjectPath
	if smPath := cfg.SessionManager.GetProjectPath(); smPath != "" {
		initialProjectPath = smPath
	}
	s.projectState.Store(&projectState{
		projectPath:    initialProjectPath,
		sessionManager: cfg.SessionManager,
		lock:           cfg.BootLock,
		viewers:        newViewerGroup(),
	})
}

// wireWorkerManager connects the worker manager to the server's LLM caller, cancel hook,
// and path/persistence callbacks.
func (s *Server) wireWorkerManager() {
	s.workerManager.SetLLMCaller(s.createLLMCaller())
	s.workerManager.SetWindowResolver(s.createWindowResolver())
	s.workerManager.SetAutoCompactGate(s.createAutoCompactGate())
	s.workerManager.SetSpendLimit(s.createSpendLimitResolver())
	s.workerManager.SetRunBudget(s.createRunBudgetResolver())

	// A background process is controlled by the process-local shell registry, but
	// its bounded output and terminal result belong to the durable tool action.
	// Route snapshots through the worker actor so normal Yjs sync/save semantics
	// apply and registry reaping cannot erase the user's history.
	ops.SetBackgroundTaskObserver(func(snapshot ops.BackgroundTaskSnapshot) {
		s.workerManager.RecordBackgroundTaskSnapshot(snapshot.ConvID, snapshot)
	})

	// Out-of-band tab auto-naming: the worker fires this on a conversation's
	// first user message; the server resolves a cheap model and renames the tab.
	s.workerManager.SetAutoNamer(s.autoNamer())

	// Engine-readiness gate for worker-driven strategy hooks: the worker waits
	// for the hidden engine to be connected before dispatching onActivate at
	// turn-start. Same gate the LLM caller uses; nil in tests / the test-pool,
	// where the engine is always-on.
	s.workerManager.SetEngineReadyFunc(s.ensureEngineReady)

	// Outbound-sync coalescing window: the default (SyncThrottleMs) unless a
	// test build was asked to widen it (testSyncThrottle). Read here at wiring
	// time (not in the worker constructor) and injected via the manager.
	if d, ok := testSyncThrottle(); ok {
		s.workerManager.SetSyncThrottle(d)
	}

	// Provider-side cancel: routes through the Conversation cache, which holds
	// the open handle and calls handle.Cancel() directly. Cancel is always
	// warm-preserving — it releases live subprocess state but keeps the
	// resume token / prompt-cache anchor — so the next turn resumes warm.
	s.workerManager.SetCancelLLMSession(s.conversationCache.CancelConversation)

	// Autonomous-turn routing: a turn the provider emits with no Submit in
	// flight (a scheduled wake / monitor firing through a persistent CLI)
	// surfaces via the handle's TurnSink. Route each such turn to the owning
	// worker as a `provider-turn` inbound message, where it lands in Yjs
	// ordered against user sends by the worker's inbound FIFO. The cache
	// Subscribe()s every newly-opened handle to this factory's sink.
	s.conversationCache.SetTurnSinkFactory(func(convID string) provider.TurnSink {
		return &workerTurnSink{convID: convID, manager: s.workerManager}
	})

	// Path resolution and binary persistence routed through the actor to keep
	// rename ↔ save serialisation correct.
	s.workerManager.SetPathProvider(s.convDir)
	s.workerManager.SetNameProvider(s.convName)
	s.workerManager.SetSaveBinary(func(convID string, data []byte) error {
		sm := s.SessionManager()
		if sm == nil {
			return fmt.Errorf("no session manager available")
		}
		// Owned-only save: a save for an id this project's session does not
		// own would otherwise fabricate an "Untitled--<id>" ghost folder for
		// it. Refuse ids this project doesn't own.
		saved, err := sm.SaveConversationBinaryIfOwned(convID, data)
		if err != nil {
			return err
		}
		if !saved {
			jlog.Debug("[worker.save] skipped unowned conv=%s (not in loaded project)", convID)
		}
		return nil
	})
}

// Names of the routes that create or tear down a conversation. The test
// server's ownership guard (test_conv_ownership.go) finds them by name, so the
// session handlers carry nothing of it.
const (
	routeConversationCreate = "conversation-create"
	routeConversationDelete = "conversation-delete"
	routeConversationBin    = "conversation-bin"
)

// setupSessionRoutes configures session-related routes
func (s *Server) setupSessionRoutes(sessionAPI *handlers.SessionAPI) {
	api := s.router.PathPrefix("/api").Subrouter()

	// Session management (single session per folder)
	api.HandleFunc("/session", sessionAPI.HandleGetSession).Methods("GET")
	api.HandleFunc("/session", sessionAPI.HandleUpdateSession).Methods("PUT")
	api.HandleFunc("/session/metadata", sessionAPI.HandlePatchSessionMetadata).Methods("PATCH")
	// Native-window geometry lives with the session (per project), set/read by
	// the desktop app so each project's window reopens where it was left. The
	// desktop app is a second process, so the path is named once in
	// internal/apipaths rather than here (as is the board delete below).
	api.HandleFunc(apiRoute(apipaths.SessionWindowState), sessionAPI.HandleGetWindowState).Methods("GET")
	api.HandleFunc(apiRoute(apipaths.SessionWindowState), sessionAPI.HandleSetWindowState).Methods("PUT")
	// The pinboard is shared project state, not a per-device preference, so
	// unlike the UI preference routes below it is not gated to the local viewer.
	// Which board a request is about is a `?board=` query parameter, defaulting
	// to the docked panel — so a project's boards are one resource with several
	// names rather than several routes.
	api.HandleFunc("/session/pinboard", sessionAPI.HandleGetPinboard).Methods("GET")
	api.HandleFunc("/session/pinboard/operations", sessionAPI.HandlePinboardOperations).Methods("POST")
	// `seed` is a viewer asking whether the board's starting tabs are its to lay
	// out — answered yes once per board, since the tabs would otherwise be laid
	// out again by every window that opened.
	api.HandleFunc("/session/pinboard/seed", sessionAPI.HandleClaimBoardSeed).Methods("POST")
	// A board of its own is what a detached window has. Creating one is a window
	// opening, deleting one is a window being closed for good, and `restore` is a
	// window asking which boards outlived the last run — answered once, since the
	// answer is an instruction to open them.
	api.HandleFunc(apiRoute(apipaths.SessionPinboardBoards), sessionAPI.HandleCreateBoard).Methods("POST")
	api.HandleFunc(apiRoute(apipaths.SessionPinboardBoards), sessionAPI.HandleDeleteBoard).Methods("DELETE")
	api.HandleFunc("/session/pinboard/boards/restore", sessionAPI.HandleRestoreBoards).Methods("POST")
	// The workspace table: where this project's conversations run, other than
	// the project itself. Shared project state like the pinboard, so likewise
	// not gated to the local viewer. Registering comes before building, so a
	// provision interrupted half way through leaves a row to clean up; `close`
	// tombstones rather than deletes, because the id outlives the workspace and
	// a bound conversation must be told it was closed, not that it is unknown.
	// `reconcile` is a viewer asking whether checking the table against disk is
	// its job — answered yes once per run, since the check is destructive.
	// `reorder` writes the order the table is held in, which is the order two
	// boxes drawn in the same place appear in — a part of the sidebar's
	// arrangement that no single row can record.
	api.HandleFunc("/session/workspaces", sessionAPI.HandleListWorkspaces).Methods("GET")
	api.HandleFunc("/session/workspaces", sessionAPI.HandleRegisterWorkspace).Methods("POST")
	api.HandleFunc("/session/workspaces/reconcile", sessionAPI.HandleClaimWorkspaceReconcile).Methods("POST")
	api.HandleFunc("/session/workspaces/reorder", sessionAPI.HandleReorderWorkspaces).Methods("POST")
	api.HandleFunc("/session/workspaces/{workspaceId}", sessionAPI.HandleUpdateWorkspace).Methods("PATCH")
	api.HandleFunc("/session/workspaces/{workspaceId}", sessionAPI.HandleUnregisterWorkspace).Methods("DELETE")
	api.HandleFunc("/session/workspaces/{workspaceId}/close", sessionAPI.HandleCloseWorkspace).Methods("POST")
	// The viewer's UI preferences — hidden info cards, dragged column widths —
	// live with the session too, so a reopened project window keeps them however
	// its port (and so its localStorage) changed: one opaque map per realm (this
	// window's, or the whole project's with ?scope=project) rather than a route
	// per preference. The write is local-only: a remote viewer starts from these
	// values but keeps its own in localStorage, so one device can't rearrange
	// another's window (see localViewerOnly). Nothing in Go reads
	// them; the client owns the keys and the shapes. PUT merges: an omitted key
	// is unchanged, a null one is deleted.
	api.HandleFunc("/session/ui-prefs", sessionAPI.HandleGetUIPrefs).Methods("GET")
	api.Handle("/session/ui-prefs", localViewerOnly(sessionAPI.HandleSetUIPrefs)).Methods("PUT")
	// Atomic conversation creation: server picks id, creates folder with
	// the collision-resolved canonical name, returns {id, name, created}.
	api.HandleFunc("/conversations", sessionAPI.HandleCreateConversation).Methods("POST").Name(routeConversationCreate)
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleGetConversation).Methods("GET")
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleUpdateConversation).Methods("PUT")
	api.HandleFunc("/session/conversations/{convId}", sessionAPI.HandleDeleteConversation).Methods("DELETE").Name(routeConversationDelete)
	api.HandleFunc("/session/conversations/{convId}/name", sessionAPI.HandleRenameConversation).Methods("PATCH")
	// Content-addressed binary assets (attached images, etc.) streamed from
	// <convDir>/assets/<sha>.<ext>. {sha} is validated as 64-char lowercase hex.
	api.HandleFunc("/session/conversations/{convId}/assets/{sha}", sessionAPI.HandleGetAsset).Methods("GET")
	// Upload raw image bytes (mime in Content-Type) → content-addressed store;
	// returns the AssetRef.
	api.HandleFunc("/session/conversations/{convId}/assets", sessionAPI.HandleUploadAsset).Methods("POST")
	// A program tool's snapshot while one of its calls waits on the user, kept
	// in <convDir>/programs/<toolUseId>.json (worker.ProgramStore).
	api.HandleFunc("/session/conversations/{convId}/programs/{toolUseId}", sessionAPI.HandlePutProgram).Methods("PUT")
	api.HandleFunc("/session/conversations/{convId}/programs/{toolUseId}", sessionAPI.HandleGetProgram).Methods("GET")
	api.HandleFunc("/session/conversations/{convId}/programs/{toolUseId}", sessionAPI.HandleDeleteProgram).Methods("DELETE")
	api.HandleFunc("/session/conversations/{convId}/bin", sessionAPI.HandleBinConversation).Methods("POST").Name(routeConversationBin)
	api.HandleFunc("/session/binned-conversations", sessionAPI.HandleListBinnedConversations).Methods("GET")
	api.HandleFunc("/session/binned-conversations", sessionAPI.HandleEmptyBin).Methods("DELETE")
	api.HandleFunc("/session/binned-conversations/{convId}/restore", sessionAPI.HandleRestoreConversation).Methods("POST")
	api.HandleFunc("/session/binned-conversations/{convId}", sessionAPI.HandleDeleteBinnedConversation).Methods("DELETE")
	api.HandleFunc("/session/reorder", sessionAPI.HandleReorderConversations).Methods("PUT")
	// Raw file bytes for the file viewers. Unlike the immutable asset store
	// above, these serve a live file that can change on disk. The GET route is
	// the streaming one (its token may ride in the query string, so it is
	// contained to the project root); the POST route is header-authenticated and
	// carries the read op's escape hatches in its body, which is what lets a
	// viewer render a user-initiated file outside the project. See
	// handlers.FilesAPI for the full rationale.
	filesAPI := handlers.NewFilesAPI(s.ProjectPath)
	api.HandleFunc("/session/files/content", filesAPI.HandleGetFileContent).Methods("GET")
	// The same files addressed by path, so a framed HTML page's relative links
	// resolve beside it (see handlers.FilesAPI.HandleGetFileTree).
	api.PathPrefix("/session/files/tree/").HandlerFunc(filesAPI.HandleGetFileTree).Methods("GET")
	api.HandleFunc("/session/files/bytes", filesAPI.HandlePostFileBytes).Methods("POST")
}

// setupLogsRoutes registers the read-only /api/logs endpoints that back the
// Logs settings page.
func (s *Server) setupLogsRoutes() {
	api := s.router.PathPrefix("/api").Subrouter()
	logsAPI := handlers.NewLogsAPI(s.ProjectPath)
	api.HandleFunc("/logs", logsAPI.HandleList).Methods("GET")
	api.HandleFunc("/logs/content", logsAPI.HandleContent).Methods("GET")
}

// setupConfigRoutes configures configuration-related routes
func (s *Server) setupConfigRoutes(configAPI *handlers.ConfigAPI) {
	api := s.router.PathPrefix("/api").Subrouter()

	// Configuration management
	api.HandleFunc("/config", configAPI.HandleGetConfig).Methods("GET")
	api.HandleFunc("/config", configAPI.HandleUpdateConfig).Methods("PUT")
	api.HandleFunc("/config/provider-enabled", configAPI.HandleSetProviderEnabled).Methods("POST")
	api.HandleFunc("/config/plugins", configAPI.HandleGetPluginConfig).Methods("GET")
	api.HandleFunc("/config/plugins", configAPI.HandleUpdatePluginConfig).Methods("PUT")

	// Default model new conversations are seeded with. GET returns the stored
	// value (or the computed preferred model when unset); PUT persists the
	// user's choice. Captured onto each conversation at creation time so a
	// later change never retargets an existing conversation.
	api.HandleFunc("/default-model", s.modelPrefsAPI.HandleGetDefaultModel).Methods("GET")
	api.HandleFunc("/default-model", s.modelPrefsAPI.HandleSetDefaultModel).Methods("PUT")

	// Cheap model used for out-of-band micro-tasks (auto-naming a tab, plugin
	// generateText). GET returns the pinned value or, when unset, the
	// auto-derived cheap sibling of the current default; PUT persists the user's
	// choice (empty clears back to Auto).
	api.HandleFunc("/cheap-model", s.handleCheapModel).Methods("GET")
	api.HandleFunc("/cheap-model", s.modelPrefsAPI.HandleSetCheapModel).Methods("PUT")

	// Decision model used where a decision model is wanted in place of the cheap
	// LLM (Auto-approve's review of a parked tool call). GET reports the chosen
	// model and whether it can serve now; PUT persists the choice (empty clears
	// it, and the cheap model is used again).
	api.HandleFunc("/decision-model", s.handleDecisionModel).Methods("GET")
	api.HandleFunc("/decision-model", s.decisionModelAPI.HandleSet).Methods("PUT")

	// Out-of-band single-turn completion (no tools, no persistence, bounded
	// output + timeout + concurrency). Backs the plugin generateText op and the
	// auto-namer. See server/quick_complete.go.
	api.HandleFunc("/llm/complete", s.handleLLMComplete).Methods("POST")

	// Out-of-band decision: questions asked of a decision model about some text,
	// answered with probabilities. Same pool and guardrails as /llm/complete.
	// Backs the plugin decide op. See server/quick_decide.go.
	api.HandleFunc("/llm/decide", s.handleLLMDecide).Methods("POST")
	// User-saved system-prompt presets + the chosen session-default preset id.
	// GET lists the user's presets (built-ins live in the frontend); POST saves
	// the current prompt as a new preset; DELETE removes one; PUT .../default
	// records which preset (built-in or user) new conversations seed from.
	// The /default route is registered before /{id} so it isn't shadowed.
	presets := s.systemPromptPresetsAPI
	api.HandleFunc("/system-prompt-presets", presets.HandleGetPresets).Methods("GET")
	api.HandleFunc("/system-prompt-presets", presets.HandleCreatePreset).Methods("POST")
	api.HandleFunc("/system-prompt-presets/default", presets.HandleSetDefaultPreset).Methods("PUT")
	api.HandleFunc("/system-prompt-presets/{id}", presets.HandleDeletePreset).Methods("DELETE")
	api.HandleFunc("/system-prompt-presets/{id}", presets.HandleUpdatePreset).Methods("PUT")

	// Recently-selected concrete models, persisted server-side so the list
	// survives an app relaunch / a port change (browser localStorage is
	// origin-scoped). GET reads the MRU list; POST records a pick.
	api.HandleFunc("/recent-models", s.modelPrefsAPI.HandleRecentModels).Methods("GET", "POST")
}

// apiRoute is a cross-process path constant as the "/api" subrouter takes it:
// the same path with the prefix the subrouter already supplies removed. Only
// the routes named in internal/apipaths are registered this way — the rest are
// spelled in one place already, so a literal is the clearer thing to read.
func apiRoute(path string) string {
	return strings.TrimPrefix(path, apipaths.Prefix)
}

// setupBootstrapRoutes registers the viewer WebSocket, whose upgrade carries
// the API token in its query rather than the header apiAuthMiddleware reads
// (see exemptRoutes), and the health routes, which take the token like any
// other: the supervising machine server and `juggler run` both hold it.
func (s *Server) setupBootstrapRoutes() {
	api := s.router.PathPrefix(apipaths.Prefix).Subrouter()
	api.HandleFunc(apiRoute(apipaths.WebSocket), s.handleWebSocket).Methods("GET")
	api.HandleFunc(apiRoute(apipaths.Health), handlers.HandleHealth).Methods("GET")
	api.HandleFunc(apiRoute(apipaths.HealthActive), s.handleHealthActive).Methods("GET")
	api.HandleFunc(apiRoute(apipaths.HealthRetire), s.handleHealthRetire).Methods("POST")
	api.HandleFunc(apiRoute(apipaths.HealthInstance), s.handleHealthInstance).Methods("GET")
}

// setupRoutes configures all HTTP routes
func (s *Server) setupRoutes() {
	s.setupBootstrapRoutes()

	// API routes
	api := s.router.PathPrefix("/api").Subrouter()
	api.HandleFunc("/ops/call", s.opsAPI.HandleOperationCall).Methods("POST")
	api.HandleFunc(apiRoute(apipaths.OneShot), s.handleOneShot).Methods("POST")
	api.HandleFunc("/completions/files", s.completionsAPI.HandleFileCompletions).Methods("GET")
	api.HandleFunc("/completions/path", s.completionsAPI.HandlePathCompletions).Methods("GET")
	api.HandleFunc("/completions/exists", s.completionsAPI.HandlePathExists).Methods("GET")
	api.HandleFunc("/git/diff", s.gitStatusAPI.HandleGitDiff).Methods("GET")
	api.HandleFunc("/git/review", s.gitStatusAPI.HandleGitReview).Methods("GET")
	api.HandleFunc("/git/status", s.gitStatusAPI.HandleGitStatus).Methods("GET")
	api.HandleFunc("/providers", s.handleProviders).Methods("GET")
	api.HandleFunc("/providers/refresh", s.handleRefreshProviders).Methods("POST")
	api.HandleFunc("/providers/usage", s.handleProviderUsageStats).Methods("GET")
	// Move from a provider to the one it says suits its server better (see provider_successor.go).
	api.HandleFunc("/providers/switch", s.handleProviderSwitch).Methods("POST")
	// What first-run setup found on this machine (see onboarding_api.go).
	api.HandleFunc("/onboarding/detect", s.handleOnboardingDetect).Methods("GET")
	// GitHub Copilot device-flow sign-in (see handlers/copilot.go).
	api.HandleFunc("/providers/copilot/device/start", s.configAPI.HandleCopilotDeviceStart).Methods("POST")
	api.HandleFunc("/providers/copilot/device/poll", s.configAPI.HandleCopilotDevicePoll).Methods("POST")
	api.HandleFunc("/providers/copilot/signout", s.configAPI.HandleCopilotSignOut).Methods("POST")
	api.HandleFunc("/providers/copilot/host", s.configAPI.HandleCopilotGetHost).Methods("GET")
	api.HandleFunc("/providers/copilot/host", s.configAPI.HandleCopilotSetHost).Methods("POST")

	api.HandleFunc("/extensions", s.extensionsAPI.HandleListExtensions).Methods("GET")
	api.HandleFunc("/extensions/locations", s.extensionsAPI.HandleListLocations).Methods("GET")
	// The epoch is the API's and is bumped by HandleReload; the clients to tell
	// are the server's.
	s.extensionsAPI.SetReloadBroadcast(func() { s.broadcastPluginChanged("api/extensions/reload", false) })
	api.HandleFunc("/extensions/reload", s.extensionsAPI.HandleReload).Methods("POST")

	api.HandleFunc("/user-commands", s.userCommandsAPI.HandleList).Methods("GET")
	api.HandleFunc("/user-commands/{scope}/{name}", s.userCommandsAPI.HandlePut).Methods("PUT")
	api.HandleFunc("/user-commands/{scope}/{name}", s.userCommandsAPI.HandleDelete).Methods("DELETE")

	api.HandleFunc("/user-hooks", handlers.HandleListUserHooks).Methods("GET")

	api.HandleFunc("/skills", s.skillsAPI.HandleList).Methods("GET")
	// Marketplace routes are registered before the {scope}/{source}/{name}
	// discovery routes so their literal prefixes (registries, catalog, install)
	// win in gorilla/mux's registration-order match, and the discovery vars are
	// constrained to real scopes so a marketplace path can never satisfy them.
	api.HandleFunc("/skills/registries", s.skillsRegistryAPI.HandleListRegistries).Methods("GET")
	api.HandleFunc("/skills/registries", s.skillsRegistryAPI.HandleAddRegistry).Methods("POST")
	// Register the literal /defaults routes before the {id} capture so a removed
	// default can be listed and restored by its seed id.
	api.HandleFunc("/skills/registries/defaults", s.skillsRegistryAPI.HandleListDefaultRegistries).Methods("GET")
	api.HandleFunc("/skills/registries/defaults/{id}", s.skillsRegistryAPI.HandleRestoreDefaultRegistry).Methods("POST")
	api.HandleFunc("/skills/registries/{id}", s.skillsRegistryAPI.HandleDeleteRegistry).Methods("DELETE")
	api.HandleFunc("/skills/catalog", s.skillsRegistryAPI.HandleCatalog).Methods("GET")
	api.HandleFunc("/skills/catalog/entry", s.skillsRegistryAPI.HandleCatalogEntry).Methods("GET")
	api.HandleFunc("/skills/install", s.skillsRegistryAPI.HandleInstall).Methods("POST")
	api.HandleFunc("/skills/{scope:project|user}/{source}/{name}", s.skillsAPI.HandleGet).Methods("GET")
	api.HandleFunc("/skills/{scope:project|user}/{source}/{name}", s.skillsRegistryAPI.HandleUninstall).Methods("DELETE")

	api.HandleFunc("/version", handlers.HandleVersion).Methods("GET")
	api.HandleFunc("/update-status", s.handleUpdateStatus).Methods("GET")
	api.HandleFunc("/update-status/check", s.handleManualUpdateCheck).Methods("POST")

	api.HandleFunc("/settings", s.handleGetSettings).Methods("GET")
	api.HandleFunc("/settings", s.handlePutSettings).Methods("PUT")
	api.HandleFunc("/i18n/catalog", s.handleUICatalog).Methods("GET")
	api.HandleFunc("/i18n/locales", s.handleUILocales).Methods("GET")

	// Serve extension containers straight off disk. ExtensionsAPI owns these
	// paths; a "" path simply registers no route.
	if userDir := s.extensionsAPI.UserExtensionDir(); userDir != "" {
		s.router.PathPrefix(handlers.UserExtensionURLBase).Handler(
			http.StripPrefix(handlers.UserExtensionURLBase,
				stripUserExtEpoch(http.FileServer(http.Dir(userDir)))),
		)
	}

	// Static file serving under version-prefixed paths for cache busting.
	// Production assets come from web.Files; the test-only js-tests/ tree comes
	// from web.TestFiles, which is empty under -tags production (see embed_testassets.go).
	vPrefix := "/v" + s.staticVersion
	// machine/ is the machine server's sessions page (served there, not here);
	// it is served here too so its modules run in the browser test harness.
	prodPrefixes := []string{"/css/", "/js/", "/extensions/", "/sdk/", "/resources/", "/machine/"}
	// Captured so the absolute-project-path route below can reuse it. Serves the
	// web root, so a request path of "/js/foo.js" maps to web/js/foo.js.
	var staticFileServer http.Handler
	// registerStatic mounts each prefix under the cache-busting version path,
	// stripping the version back off before staticFileServer sees the request.
	// staticFileServer is captured by reference, so each caller assigns it first.
	registerStatic := func(prefixes ...string) {
		for _, prefix := range prefixes {
			s.router.PathPrefix(vPrefix + prefix).Handler(http.StripPrefix(vPrefix, staticFileServer))
		}
	}
	if s.assetsFromDisk {
		// Assets-from-disk: serve files directly from disk for live reload
		staticDir, err := s.findStaticDir()
		if err != nil {
			jlog.Error("Failed to find static directory: %v", err)
			jlog.Error("Falling back to embedded files")
			staticFS, _ := fs.Sub(web.Files, ".")
			staticFileServer = webui.AssetHandler(http.FileServer(http.FS(staticFS)))
			registerStatic(prodPrefixes...)
			s.serveEmbeddedTestAssets(vPrefix)
		} else {
			jlog.Info("🔧 Dev mode: serving static files from %s", staticDir)
			staticFileServer = webui.AssetHandler(http.FileServer(http.Dir(staticDir)))
			// Disk has js-tests/ alongside everything else, so serve it from disk too.
			registerStatic(append(prodPrefixes, "/js-tests/")...)
		}
	} else {
		// Production mode: serve embedded files
		staticFS, err := fs.Sub(web.Files, ".")
		if err != nil {
			jlog.Error("Could not load static files: %v", err)
		}
		staticFileServer = webui.AssetHandler(http.FileServer(http.FS(staticFS)))
		registerStatic(prodPrefixes...)
		s.serveEmbeddedTestAssets(vPrefix)
	}

	s.registerSandboxImportRoutes(staticFileServer)

	// Worker-compatible module loader. Module workers don't inherit the page
	// import map, so the worker-backed engine (and every plugin module it pulls
	// in) resolves its public `juggler/*` SDK specifiers through this transform.
	s.router.HandleFunc("/worker-module", s.serveWorkerModule).Methods("GET")

	// Engine page route (headless browser for tool execution)
	s.router.HandleFunc("/engine", s.serveEngine).Methods("GET")
	s.router.HandleFunc("/sandbox", s.serveSandbox).Methods("GET")

	// Frontend → application-log bridge. Both the worker-backed engine runtime (as
	// it boots) and the viewer's chime path (rare untoward audio events) POST here;
	// their WebView consoles are invisible in a shipped build, so this is the only
	// window into either. See handlers.HandleClientReport.
	s.router.HandleFunc("/api/client/report", handlers.HandleClientReport).Methods("POST")

	// Wails v3 runtime — served to every client (see webui/wails_runtime.go).
	s.router.HandleFunc("/wails/runtime.js", webui.ServeWailsRuntime).Methods("GET")
	s.router.HandleFunc("/wails/custom.js", webui.ServeWailsCustomJS).Methods("GET", "HEAD")

	// Favicon redirect to logo
	s.router.HandleFunc("/favicon.ico", s.serveFavicon).Methods("GET")

	// Serve index.
	s.router.HandleFunc("/", s.serveIndex).Methods("GET")

	// Distribution seam: let a wrapping binary register additional routes
	// (see Config.ExtraRoutes). Runs last so built-in routes take precedence.
	if s.extraRoutes != nil {
		s.extraRoutes(s.router)
	}

	// Unmatched requests: mirror corsMiddleware's non-/api headers so a module
	// the opaque-origin sandbox asks for and cannot have returns a clean 404 it
	// can read, instead of a bare 404 the browser surfaces as the misleading
	// "Cross-Origin script load denied". mux does not run Use() middleware for
	// the NotFoundHandler, so the headers are set here directly.
	s.router.NotFoundHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/api/") {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Cross-Origin-Resource-Policy", "cross-origin")
		}
		http.NotFound(w, r)
	})

	// Add middleware
	s.router.Use(corsMiddleware)
	s.router.Use(s.cacheControlMiddleware)
}

// serveEmbeddedTestAssets registers the version-prefixed /js-tests/ route from
// the embedded web.TestFiles. Under -tags production TestFiles is empty, so the
// route resolves to 404s — harmless, since RegisterTestRoutes is also gated off
// there and nothing references /js-tests/.
func (s *Server) serveEmbeddedTestAssets(vPrefix string) {
	testFS, err := fs.Sub(web.TestFiles, ".")
	if err != nil {
		jlog.Error("Could not load test assets: %v", err)
		return
	}
	fileServer := webui.AssetHandler(http.FileServer(http.FS(testFS)))
	s.router.PathPrefix(vPrefix + "/js-tests/").Handler(http.StripPrefix(vPrefix, fileServer))
}
