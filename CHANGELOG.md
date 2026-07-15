# Changelog

All notable changes to Juggler are recorded here. Each release is a tight list
of changes; this project follows semantic versioning.

## [Unreleased]

- Fix for deepseek thinking, and Ollama
- Headless Linux servers now auto-relaunch under xvfb-run when no display exists
- Linux no-display errors now give exact, distro-specific install commands

## [0.3.7] - 2026-07-14

- Recovered locked project sessions safely and explained unrecoverable lock conflicts.
- Added Pause (shift+Escape / footer button): stop the LLM loop as soon as possible without cancelling in-flight operation.

## [0.3.6] - 2026-07-13

- Assistant replies now support Markdown, HTML, and mixed Markdown/HTML content, including declarative inline SVG
- Added a /handoff command which summarises the current conversation into a new tab
- Added auto-update for Windows

## [0.3.5] - 2026-07-12

- Added ability for extension items to spawn a subthread, and used this to make the webfetch tool run sub-prompts to filter its results
- Injecting queued user messages now pushes them into the thread sooner
- Added alt+up/down shortcuts to skip between user messages in the thread

## [0.3.4] - 2026-07-11

- Added user-defined slash commands with a UI editor and sub-thread execution
- Made juggler able to explain how to use itself
- Clear per-OS error with fix-it steps when no display or webview runtime is available, instead of a silent exit.
- Fixed some UTF16 handling issues
- Reviewed and updated some command-line args

## [0.3.3] - 2026-07-11

- Fixed a MIME type error that could mess things up on Windows under some circumstances

## [0.3.2] - 2026-07-11

- Improved model shortlist sorting and filtering
- Improved the notification chime settings

## [0.3.1] - 2026-07-10

- Added GPT5.6 support
- Used the saved theme hint earlier to avoid startup background flashes.

## [0.3.0] - 2026-07-10

- Made the model chooser list able to hide some providers
- Added ⌘F find-in-conversation with a floating search bar and match navigation

## [0.2.3] - 2026-07-10

- Linux desktop window now uses the app's own title bar with custom caption buttons, matching macOS/Windows.
- Fixed Finder/Dock-launched app inheriting a stripped PATH, so the bash tool now sees the user's full shell PATH.
- Improved Codex sign-in diagnostics with checked auth-file paths.
- Fixed file context-item titles showing the full path on Windows instead of just the filename.

## [0.2.2] - 2026-07-07

- Added MCP server support: stdio tools surface as context items with live status and approval.
- Added a Git status info card summarising changed/staged files per repo.
- Show other connected clients (count in header; origin and connect time in connectivity settings).
- @-mention completion now finds deeply nested files instantly via a whole-tree path index.

## [0.2.1] - 2026-07-06

- Misc UI improvements, and some auto-update UX fixes

## [0.2.0] - 2026-07-06

It took over 6 months of chaotic churn to get to this point, so I will spare
everyone the 2000 commits and changes that got here, and arbitrarily start the
changelist from this point...
