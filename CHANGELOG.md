# Changelog

All notable changes to Juggler are recorded here. Each release is a tight list
of changes; this project follows semantic versioning.

## [Unreleased]

## [0.5.1] - 2026-07-29

- Reading files with very long lines (e.g. one-paragraph-per-line Markdown) no longer truncates mid-character or too eagerly
- Editing a long prose paragraph no longer gets bounced to the write tool
- Added proxy support — uses your system/env proxy by default, with a manual override in Settings → Network
- Fixed the Claude Code CLI re-opening its login page in the background when it wasn't the active provider
- Fixed YOLO auto-approving AskUserQuestion — questions now still wait for your answer
- Fixed various UI niggles, including some mobile layout problems
- Fixed some more multi-line bash parsing edge-cases

## [0.5.0] - 2026-07-26

- Added an 'auto-approve' strategy that uses a cheap model to approve any obviously safe commands that would otherwise have needed user approval
- New conversations now name their own tab from your first message
- Added a "cheap model" setting — a small, fast model for background micro-tasks like tab naming
- Plugins can now request short out-of-band model completions via a generateText op
- Added Mistral AI provider, with vision models and Magistral reasoning levels
- Added OpenCode Zen provider — a multi-model gateway (Claude, GPT, Gemini, DeepSeek, and more)
- Some minor fixes for thinking mode names, a few UI issues, light/dark mode on linux
- Handling for bash commands with newlines inside string literals
- "Don't ask again" approval patterns can now be edited in place before saving
- New Thread no longer interrupts an active agent turn
- Font size and theme are now remembered per project; a new empty window inherits the size and theme of the window you opened it from
- Recent models are promoted only after sending a message with them
- Added an option to default new conversations to have file editing allowed

## [0.4.5] - 2026-07-24

- Added Cmd+/ and Ctrl+/ shortcut to show keyboard shortcuts
- Fixed ⌥⌘M / ⌥⌘T being lost when focus was outside the composer
- Fixed the model cycler doing nothing on the first use after a page load
- Had a rehash of the buttons in the user message box, to make their layout more balanced and stable at different sizes
- Added a sidebar card showing active provider quota usage
- Added a flag for providers which can't handle the forced tool option, which was breaking auto-compaction
- Made the theme selector tri-state: light/dark/system

## [0.4.4] - 2026-07-23

- Sub-threads can no longer spawn their own subthreads (threads you create with /thread still can)
- GitHub Copilot now works with GitHub Enterprise Cloud (*.ghe.com): reuses your editor login and can sign in to your tenant
- New shortcuts: ⌥⌘M / Ctrl+Alt+M cycles recent models, ⌥⌘T / Ctrl+Alt+T cycles thinking level (hold opens the menu)
- Model and thinking menus now stay stable and readable while selecting levels
- Fix for some token count estimation errors that would make the auto-compact kick in much too soon
- Added GLM5.2 1m token option

## [0.4.3] - 2026-07-21

- User messages now render Markdown you typed or pasted (links, formatting, code) instead of raw source
- Connectivity settings now let you start LAN access or a WAN tunnel automatically on launch
- Local and keyless OpenAI-compatible providers now work without an API key
- Subthreads now show how they were set up (system prompt, memory, skills)
- Long conversations no longer crash when they outgrow the model's limit — Juggler trims old history and retries automatically
- Juggler now respects each model's real context and output limits (including Ollama's actual window), so it won't fire off requests that are doomed to fail
- /compact and /handoff now cope with even very large conversations
- Fixed Claude Code sessions getting stuck in plan mode when other Claude CLI sessions were open in the same folder
- Added an F2 key shortcut for renaming the current tab (also pressing return when the tab panel has keyboard focus will rename the tab)
- Fixed double-insertion of agent.md files if there are synlinks involved
- Fallback for some image-pasting pasting in desktop app when the clipboard is async

## [0.4.2] - 2026-07-18

- Added moonshot/KIMI, Copilot and llama.cpp providers, refactored and fixed other providers like ollama, codex
- Made it possible to disable auto-update
- Fixes for some MCP and extension loading bugs
- Fixed a bug where changing the project folder would leave a stale folder in the javascript that the explore_code uses

## [0.4.1] - 2026-07-17

- Added a Skills marketplace to discover and install Agent Skills from GitHub registries
- Made lots of fixes/improvements to skill handling and the skill-related items in a conversation
- Bin now shows its on-disk size on the Bin button and Empty-Bin action
- Write approvals now enforce project-path containment on all platforms
- Writes outside the project folder always prompt, with a clear warning
- Pre-approval write validation no longer creates directories or files
- Windows absolute paths now display correctly in approval dialogs

## [0.4.0] - 2026-07-16

- Added per-model thinking-level control to the model chooser
- Added Agent Skills: discovery across native roots, plus a skill tool to load them on demand
- Added ACP client support
- Added workarounds for some Firefox bugs when using the WAN client
- Fixed failure to save settings in the generic openAI provider
- Made sure .md files are previewed as markdown, not syntax-highlighted text
- Followed XDG Base Directory spec for config/cache on Linux

## [0.3.8] - 2026-07-15

- Added a generic openAI provider which can use any URL
- Made the provider connection timeout customisable
- Attached images now render again instead of showing as broken links
- Fix for deepseek thinking, and Ollama
- Headless Linux servers now auto-relaunch under xvfb-run when no display exists
- Linux no-display errors now give exact, distro-specific install commands
- On headless linux servers without GTK, it will now fall back to using node/bun as its javascript engine

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
