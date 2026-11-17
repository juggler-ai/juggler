//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

// The realtime socket's frame vocabulary: the `type` of every frame a client
// sends the server and every frame the server sends a client.
//
// The JS UI mirrors these by hand, so both lists are held to
// web/js-tests/fixtures/wire-protocol.json by TestWireParityServer
// (wire_parity_test.go), and the JS routing table to the same file by
// unit:wire-protocol-parity. Adding a frame here means adding it there.

// frameType is the `type` of a realtime frame.
type frameType string

// Frames a client sends: the cases of realtime_loop.go's switch on generic.Type.
const (
	frameEngineHeartbeat frameType = "engine-heartbeat"
	frameViewerHeartbeat frameType = "viewer-heartbeat"
	frameViewerFault     frameType = "viewer-fault"
	frameShellStart      frameType = "shell-start"
	frameShellCancel     frameType = "shell-cancel"
	frameEngineBridge    frameType = "engine-bridge"
	frameViewerRelay     frameType = "viewer-relay"
	frameOneShotResult   frameType = "one-shot-result"
	frameSessionChanged  frameType = "session-changed"
	frameWorkerMessage   frameType = "worker-message"
	frameGitWatch        frameType = "git-watch"
	// agent-run-start and agent-run-cancel come from whoever asks for a run;
	// agent-run-progress and agent-run-result come from the engine carrying it
	// out, and the server sends them on to the requester (agent_runs.go).
	frameAgentRunStart    frameType = "agent-run-start"
	frameAgentRunCancel   frameType = "agent-run-cancel"
	frameAgentRunProgress frameType = "agent-run-progress"
	frameAgentRunResult   frameType = "agent-run-result"
)

// Frames the server sends. engine-bridge, viewer-relay, session-changed and
// worker-message travel both ways and are declared above.
const (
	frameFileChange             frameType = "file-change"
	framePluginChanged          frameType = "plugin-changed"
	frameSettingsChanged        frameType = "settings-changed"
	framePinboardChanged        frameType = "pinboard-changed"
	framePinboardReveal         frameType = "pinboard-reveal"
	frameWorkspacesChanged      frameType = "workspaces-changed"
	frameProcessesChanged       frameType = "processes-changed"
	frameProvidersUpdate        frameType = "providers-update"
	frameUpdateStatus           frameType = "update-status"
	frameClientsChanged         frameType = "clients-changed"
	frameShellOutput            frameType = "shell-output"
	frameHeartbeat              frameType = "heartbeat"
	frameSession                frameType = "session"
	frameConversationsChanged   frameType = "conversations-changed"
	frameNotice                 frameType = "notice"
	frameSessionMetadataChanged frameType = "session-metadata-changed"
	frameRunOneShot             frameType = "run-one-shot"
	frameError                  frameType = "error"
	frameServerFull             frameType = "server-full"
	frameServerShutdown         frameType = "server-shutdown"
	frameGitChange              frameType = "git-change"
	frameGitJob                 frameType = "git-job"
	frameRunAgent               frameType = "run-agent"
	frameCancelAgentRun         frameType = "cancel-agent-run"
)

// allInboundFrames is every frame type a client sends.
var allInboundFrames = []frameType{
	frameEngineHeartbeat, frameViewerHeartbeat, frameViewerFault, frameShellStart, frameShellCancel,
	frameEngineBridge, frameViewerRelay, frameOneShotResult, frameSessionChanged, frameWorkerMessage,
	frameGitWatch, frameAgentRunStart, frameAgentRunCancel, frameAgentRunProgress, frameAgentRunResult,
}

// allOutboundFrames is every frame type the server sends.
var allOutboundFrames = []frameType{
	frameFileChange, framePluginChanged, frameSettingsChanged,
	framePinboardChanged, framePinboardReveal, frameWorkspacesChanged, frameProcessesChanged, frameViewerRelay,
	frameProvidersUpdate,
	frameUpdateStatus, frameClientsChanged, frameShellOutput, frameEngineBridge, frameHeartbeat, frameSession,
	frameWorkerMessage, frameConversationsChanged, frameNotice, frameSessionMetadataChanged,
	frameSessionChanged, frameRunOneShot, frameError, frameServerFull, frameServerShutdown,
	frameGitChange, frameGitJob, frameRunAgent, frameCancelAgentRun, frameAgentRunProgress, frameAgentRunResult,
}
