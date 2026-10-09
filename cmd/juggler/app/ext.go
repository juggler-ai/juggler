//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bufio"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"juggler/cmd/juggler/extmanifest"
	"juggler/internal/userpaths"
	"juggler/web"
)

// extManifestFile is the well-known manifest filename at an extension root,
// single-sourced from the extmanifest package shared with the server.
const extManifestFile = extmanifest.ManifestFileName

// runExtCommand dispatches the `juggler ext …` developer subcommands. It is
// reached from main() BEFORE flag parsing or the banner, so it behaves like a
// self-contained CLI: it never boots a server. args is os.Args[2:] (everything
// after `ext`). The returned int is the process exit code.
func runExtCommand(args []string) int {
	if len(args) == 0 {
		printExtUsage()
		return 2
	}
	sub, rest := args[0], args[1:]
	switch sub {
	case "init":
		return extInit(rest)
	case "link":
		return extLink(rest)
	case "add":
		return extAdd(rest)
	case "validate":
		return extValidate(rest)
	case "-h", "--help", "help":
		printExtUsage()
		return 0
	default:
		fmt.Fprintf(os.Stderr, "juggler ext: unknown subcommand %q\n\n", sub)
		printExtUsage()
		return 2
	}
}

func printExtUsage() {
	fmt.Fprint(os.Stderr, `Usage: juggler ext <command> [args]

Develop and install Juggler Extensions.

Commands:
  init <name>        Scaffold a new extension in ./<name> (manifest + a working
                     sample tool, strategy and command + README).
  validate [path]    Check the manifest at [path] (default .) the same way the
                     server does: required fields, engineApi compat, and that
                     every provides glob resolves to real files.
  link <path>        Symlink an extension dir into ~/.juggler/extensions for
                     dev-mode loading with hot reload.
  add [-y] <repo>    git clone a repo into ~/.juggler/extensions. Prints the
                     declared permissions and asks to confirm (-y skips).

Examples:
  juggler ext init code-review
  juggler ext validate ./code-review
  juggler ext link ./code-review
  juggler ext add github.com/owner/repo

Writing one: docs/extension_tutorial.md builds an extension end to end, and
examples/extensions/ holds small, copyable examples covering every capability type.
`)
}

// userExtensionDir resolves the per-user extension container (~/.juggler/extensions),
// the same directory the server scans for user extensions.
func userExtensionDir() string {
	return filepath.Join(userpaths.ConfigDir(), "extensions")
}

// extInit scaffolds a loadable extension directory with a manifest, a working
// sample context item, strategy and command, and a README. The result loads
// immediately once linked (juggler ext link ./<name>).
func extInit(args []string) int {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		fmt.Fprintln(os.Stderr, "Usage: juggler ext init <name>")
		return 2
	}
	name := strings.TrimSpace(args[0])
	dest, err := filepath.Abs(name)
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext init: %v\n", err)
		return 1
	}
	if _, err := os.Stat(dest); err == nil {
		fmt.Fprintf(os.Stderr, "juggler ext init: %s already exists\n", dest)
		return 1
	}

	base := filepath.Base(dest)
	files := scaffoldExtension(base)
	for rel, content := range files {
		full := filepath.Join(dest, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			fmt.Fprintf(os.Stderr, "juggler ext init: %v\n", err)
			return 1
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			fmt.Fprintf(os.Stderr, "juggler ext init: %v\n", err)
			return 1
		}
	}

	fmt.Printf("Scaffolded extension %q at %s\n", base, dest)
	fmt.Printf("\nNext steps:\n  juggler ext link %s\n  # then start juggler and save a file to hot-reload\n", name)
	return 0
}

// hostEngineAPIVersion is the SDK version this binary's frontend exposes, read
// from the embedded web/sdk/version.js so the CLI judges engineApi compatibility
// exactly as the running server would.
func hostEngineAPIVersion() string {
	return extmanifest.ReadEngineAPIVersion(web.Files)
}

// validateExtensionDir loads the manifest at dir and runs the full server-side
// admission check against the host engine API: parse (rejecting unknown keys),
// validate required fields + engineApi range, and expand every provides glob to
// confirm the declared capability files actually exist. It returns the parsed
// manifest, any non-fatal warnings, and a fatal error if the extension would not
// load. Glob expansion uses os.DirFS rooted at the extension dir, so a glob can
// never escape the root (same guard the server applies).
func validateExtensionDir(dir string) (extmanifest.Manifest, []string, error) {
	data, err := os.ReadFile(filepath.Join(dir, extManifestFile))
	if err != nil {
		return extmanifest.Manifest{}, nil, fmt.Errorf("no %s in %s", extManifestFile, dir)
	}
	m, err := extmanifest.Parse(data)
	if err != nil {
		return extmanifest.Manifest{}, nil, fmt.Errorf("invalid manifest: %w", err)
	}
	if err := extmanifest.Validate(m, hostEngineAPIVersion()); err != nil {
		return m, nil, err
	}
	fsys := os.DirFS(dir)
	for _, globs := range [][]string{m.Provides.ContextItems, m.Provides.Strategies, m.Provides.Commands, m.Provides.InfoCards, m.Provides.FileViewers, m.Provides.PinboardItems, m.Provides.PinboardItemMeta, m.Provides.WorkspaceProviders, m.Provides.Hooks} {
		expanded, err := extmanifest.ExpandGlobs(fsys, globs)
		if err != nil {
			return m, nil, err
		}
		if len(globs) > 0 && len(expanded) == 0 {
			return m, nil, fmt.Errorf("provides glob(s) %v matched no files under %s", globs, dir)
		}
	}
	// systemPrompt is a single module path (not a glob list). Resolve it through
	// the same traversal-guarded expander so the CLI catches a missing/escaping
	// module exactly as the server would at discovery.
	if sp := strings.TrimSpace(m.Provides.SystemPrompt); sp != "" {
		expanded, err := extmanifest.ExpandGlobs(fsys, []string{sp})
		if err != nil {
			return m, nil, err
		}
		if len(expanded) == 0 {
			return m, nil, fmt.Errorf("systemPrompt module %q matched no file under %s", sp, dir)
		}
	}
	return m, extmanifest.Warnings(m), nil
}

// extValidate checks an extension directory's manifest the same way the server
// does at discovery, so an author can catch packaging mistakes before linking.
// It exits 0 when the extension would load (printing any warnings) and 1 on any
// fatal error.
func extValidate(args []string) int {
	dir := "."
	if len(args) == 1 && strings.TrimSpace(args[0]) != "" {
		dir = strings.TrimSpace(args[0])
	} else if len(args) > 1 {
		fmt.Fprintln(os.Stderr, "Usage: juggler ext validate [path]")
		return 2
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext validate: %v\n", err)
		return 1
	}

	m, warnings, err := validateExtensionDir(abs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "✗ %s\n", err)
		return 1
	}

	caps := len(m.Provides.ContextItems) + len(m.Provides.Strategies) + len(m.Provides.Commands) +
		len(m.Provides.InfoCards) + len(m.Provides.FileViewers) + len(m.Provides.PinboardItems) +
		len(m.Provides.WorkspaceProviders) + len(m.Provides.Hooks)
	fmt.Printf("✓ %s (%s) — %s, %d capability glob(s), compatible with host engineApi %s\n",
		m.Name, m.Version, m.ID, caps, hostEngineAPIVersion())
	for _, w := range warnings {
		fmt.Printf("  ⚠ %s\n", w)
	}
	return 0
}

// extLink symlinks a development extension directory into ~/.juggler/extensions
// so the server discovers it. Combined with the plugin watcher (file_watcher.go),
// edits to files under the linked dir hot-reload without a restart.
func extLink(args []string) int {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		fmt.Fprintln(os.Stderr, "Usage: juggler ext link <path>")
		return 2
	}
	src, err := filepath.Abs(strings.TrimSpace(args[0]))
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext link: %v\n", err)
		return 1
	}
	info, err := os.Stat(src)
	if err != nil || !info.IsDir() {
		fmt.Fprintf(os.Stderr, "juggler ext link: %s is not a directory\n", src)
		return 1
	}
	// Validate before linking so a broken manifest fails here, not silently at
	// the next server scan. Warnings are printed but don't block the link.
	_, warnings, err := validateExtensionDir(src)
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext link: %s\n", err)
		return 1
	}
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "  ⚠ %s\n", w)
	}

	container := userExtensionDir()
	if container == "" {
		fmt.Fprintln(os.Stderr, "juggler ext link: cannot resolve home directory")
		return 1
	}
	if err := os.MkdirAll(container, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext link: %v\n", err)
		return 1
	}

	link := filepath.Join(container, filepath.Base(src))
	// Replace an existing symlink at the same name (re-link is idempotent); refuse
	// to clobber a real directory so we never delete someone's installed extension.
	if fi, err := os.Lstat(link); err == nil {
		if fi.Mode()&os.ModeSymlink == 0 {
			fmt.Fprintf(os.Stderr, "juggler ext link: %s already exists and is not a symlink\n", link)
			return 1
		}
		if err := os.Remove(link); err != nil {
			fmt.Fprintf(os.Stderr, "juggler ext link: %v\n", err)
			return 1
		}
	}
	if err := os.Symlink(src, link); err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext link: %v\n", err)
		return 1
	}

	fmt.Printf("Linked %s → %s\n", link, src)
	fmt.Println("A running juggler loads it automatically; otherwise just start juggler. Edits hot-reload.")
	return 0
}

// extAdd git-clones a repository into ~/.juggler/extensions, installing it as a
// user extension. The repo may be given as a bare host/path (github.com/foo/bar)
// or a full URL; bare forms are normalised to https.
func extAdd(args []string) int {
	assumeYes := false
	repo := ""
	for _, a := range args {
		switch a {
		case "-y", "--yes":
			assumeYes = true
		default:
			if repo != "" {
				fmt.Fprintln(os.Stderr, "Usage: juggler ext add [-y] <repo>")
				return 2
			}
			repo = strings.TrimSpace(a)
		}
	}
	if repo == "" {
		fmt.Fprintln(os.Stderr, "Usage: juggler ext add [-y] <repo>")
		return 2
	}
	url := normalizeRepoURL(repo)

	container := userExtensionDir()
	if container == "" {
		fmt.Fprintln(os.Stderr, "juggler ext add: cannot resolve home directory")
		return 1
	}
	if err := os.MkdirAll(container, 0o755); err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext add: %v\n", err)
		return 1
	}

	dest := filepath.Join(container, repoBaseName(repo))
	if _, err := os.Stat(dest); err == nil {
		fmt.Fprintf(os.Stderr, "juggler ext add: %s already exists (use git pull to update)\n", dest)
		return 1
	}

	cmd := exec.Command("git", "clone", "--depth", "1", url, dest)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext add: git clone failed: %v\n", err)
		return 1
	}

	// Validate the cloned tree so a non-loadable extension is flagged at install
	// time. A bad manifest is a warning, not a failure: the clone succeeded and
	// the user may want to fix it in place.
	m, warnings, err := validateExtensionDir(dest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler ext add: warning — %s; it may not load\n", err)
	} else {
		for _, w := range warnings {
			fmt.Fprintf(os.Stderr, "  ⚠ %s\n", w)
		}
		// Disclose the host access this extension declares and confirm before
		// keeping it: an extension runs with full app privileges once loaded, so
		// installing one is running its code. -y skips the prompt for scripting.
		if !assumeYes {
			printDeclaredPermissions(m)
			if !confirmKeep() {
				_ = os.RemoveAll(dest)
				fmt.Println("Aborted; removed the clone.")
				return 0
			}
		}
	}
	fmt.Printf("Installed %s → %s\n", url, dest)
	return 0
}

// permissionDescriptions gives the CLI a plain-language gloss for each known
// permission, mirroring the catalog's PERMISSION_INFO.
var permissionDescriptions = map[string]string{
	"filesystem.read":  "read files and directories on your computer",
	"filesystem.write": "create, modify, and delete files on your computer",
	"shell.exec":       "run shell commands on your computer",
	"web.fetch":        "fetch content from the web over the network",
}

// printDeclaredPermissions writes the extension's declared host access to stdout
// as disclosure before the install is confirmed. It is a declaration, not a
// sandbox — extensions run with full privileges — so the wording says so.
func printDeclaredPermissions(m extmanifest.Manifest) {
	fmt.Printf("\n%s (%s) declares this host access:\n", m.Name, m.ID)
	if len(m.Permissions) == 0 {
		fmt.Println("  (none declared)")
	} else {
		for _, p := range m.Permissions {
			if desc := permissionDescriptions[p]; desc != "" {
				fmt.Printf("  • %s — %s\n", p, desc)
			} else {
				fmt.Printf("  • %s\n", p)
			}
		}
	}
	fmt.Println("Extensions run with full app privileges; this list is disclosure, not a sandbox.")
}

// confirmKeep prompts on stdin and returns true only for an explicit yes. A
// non-interactive stdin (EOF) defaults to No, so an unattended run never keeps
// an unreviewed extension.
func confirmKeep() bool {
	fmt.Print("Keep this extension? [y/N] ")
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		return true
	default:
		return false
	}
}

// normalizeRepoURL turns a bare host/path repo reference into an https URL,
// leaving an explicit scheme (https://, git@, ssh://) untouched.
func normalizeRepoURL(repo string) string {
	if strings.Contains(repo, "://") || strings.HasPrefix(repo, "git@") {
		return repo
	}
	return "https://" + repo
}

// repoBaseName derives the install directory name from a repo reference: the
// final path segment with any .git suffix stripped.
func repoBaseName(repo string) string {
	trimmed := strings.TrimSuffix(strings.TrimRight(repo, "/"), ".git")
	if i := strings.LastIndexAny(trimmed, "/:"); i >= 0 {
		trimmed = trimmed[i+1:]
	}
	return strings.TrimSuffix(trimmed, ".git")
}

// scaffoldExtension returns the relative-path → content map for a new extension
// named base. Every sample imports only from the public juggler/* SDK and passes
// its base class's MANIFEST validation, so the scaffold loads with no edits.
func scaffoldExtension(base string) map[string]string {
	id := "@local/" + base

	manifest := fmt.Sprintf(`{
  "id": %q,
  "name": %q,
  "version": "0.1.0",
  "author": "you",
  "engineApi": "^1.0.0",
  "permissions": [],
  "provides": {
    "contextItems": ["context-items/*-context-item.js"],
    "strategies": ["strategies/*-strategy-type.js"],
    "commands": ["commands/*-command-type.js"]
  }
}
`, id, base)

	contextItem := `import ContextItem from 'juggler/context-item';

/**
 * Sample context item: an "echo" tool the model can call. Replace its tool
 * definition and execute() with whatever your extension actually does.
 * @augments ContextItem
 */
class EchoContextItem extends ContextItem {
  static MANIFEST = {
    id: 'echo',
    name: 'Echo',
    version: '0.1.0',
    description: 'Echo back the provided text (sample tool)',
    requiresApproval: false
  };

  /** @returns {Array<{name: string, category: string, description: string, input_schema: object}>} */
  static getToolDefinitions() {
    return [{
      name: 'echo',
      category: 'read',
      description: 'Echo back the provided text.',
      input_schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Text to echo' } },
        required: ['text']
      }
    }];
  }

  /**
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<import('juggler/context-item').ValidationResult>}
   */
  async validate(toolInput) {
    if (typeof toolInput.text !== 'string') {
      return { valid: false, error: 'Parameter "text" must be a string' };
    }
    return { valid: true, params: toolInput };
  }

  /**
   * @param {Record<string, unknown>} params
   * @returns {Promise<{text: string}>}
   */
  async execute(params) {
    return { text: String(params.text ?? '') };
  }

  /**
   * @param {import('juggler/context-item').Outcome} outcome
   * @returns {import('juggler/context-item').ItemSummary}
   */
  getSummary(outcome) {
    const result = /** @type {{text?: string}} */ (outcome.result || {});
    return {
      summary: outcome.success ? (result.text || '') : (outcome.error || 'echo failed'),
      details: '',
      success: !!outcome.success,
      icon: outcome.success ? '✓' : '✗'
    };
  }
}

export default EchoContextItem;
`

	strategy := `import StrategyType, { APPROVAL_POLICY } from 'juggler/strategy-type';

/**
 * Sample strategy: a read-only exploration mode. The Go worker owns the agentic
 * loop — a strategy shapes it through its MANIFEST and hooks. This one exposes
 * only read/meta tools and auto-approves them. See docs/extension_guide.md.
 * @augments StrategyType
 */
export default class SampleStrategyType extends StrategyType {
  static MANIFEST = {
    id: 'sample',
    name: 'Sample Strategy',
    version: '0.1.0',
    description: 'A read-only sample strategy scaffolded by juggler ext init',
    author: 'you',
    showsApprovalControls: false
  };

  /**
   * What this strategy tells the model when it becomes active. The base
   * onActivate injects it as a durable system-reminder, and Settings →
   * Extensions shows it to the user verbatim.
   * @type {string}
   */
  static GUIDANCE = 'SAMPLE MODE: read-only exploration — do not modify files or run commands.';

  /**
   * Restrict the tools the model may call to read-only + meta.
   * @param {import('juggler/strategy-type').ToolDefinition[]} tools
   * @returns {import('juggler/strategy-type').ToolDefinition[]}
   */
  filterTools(tools) {
    return tools.filter(t => t.category === 'read' || t.category === 'meta');
  }

  /**
   * Auto-approve the read/meta tools so exploration never stops for a prompt.
   * @param {{category: string|undefined}} info
   * @returns {'approve'|'require-approval'|'default'}
   */
  getApprovalPolicy({ category }) {
    return (category === 'read' || category === 'meta')
      ? APPROVAL_POLICY.APPROVE
      : APPROVAL_POLICY.DEFAULT;
  }
}
`

	command := `import CommandType from 'juggler/command-type';

/**
 * Sample slash command: /hello. Replace execute() with your command's behaviour.
 * @augments CommandType
 */
class HelloCommandType extends CommandType {
  static MANIFEST = {
    id: 'hello',
    name: 'Hello',
    version: '0.1.0',
    description: 'Say hello (sample command)'
  };

  /**
   * @param {string[]} args
   * @returns {Promise<import('juggler/command-type').CommandResult>}
   */
  async execute(args) {
    const who = args.join(' ').trim() || 'world';
    return { handled: true, message: 'Hello, ' + who + '!' };
  }
}

export default HelloCommandType;
`

	readme := fmt.Sprintf("# %s\n\nA Juggler Extension.\n\n## Develop\n\n"+
		"```bash\njuggler ext link ./%s\n```\n\n"+
		"Then start Juggler. Editing any `.js` file or `%s` hot-reloads the\n"+
		"extension in connected viewers — no restart needed.\n\n"+
		"`juggler ext validate .` runs the same admission check the server does,\n"+
		"so a packaging mistake fails fast instead of becoming a missing extension.\n\n"+
		"## Layout\n\n"+
		"- `%s` — the manifest (id, version, permissions, settings, provides globs).\n"+
		"- `context-items/` — context-item capabilities (tools the model can call).\n"+
		"- `strategies/` — strategy capabilities (how the model loop runs).\n"+
		"- `commands/` — slash-command capabilities.\n\n"+
		"This scaffold samples three capability types. An extension can also\n"+
		"provide `infoCards` (sidebar tiles, `cards/*-card.js`), `fileViewers`\n"+
		"(how a file type is shown and extracted, `viewers/*-file-viewer.js`),\n"+
		"`pinboardItems` (panels the user can pin to the board, `pins/*-pin.js`,\n"+
		"each with a `pinboardItemMeta` descriptor if the agent is to pin one),\n"+
		"`workspaceProviders` (places a conversation can work in — a worktree, a\n"+
		"scratch copy, a remote directory — `workspaces/*-workspace-provider.js`),\n"+
		"`hooks` (policy and notes around every tool call, `hooks/*-hook.js`), a\n"+
		"`systemPrompt` module, and `tests`. Delete whatever you don't need — a\n"+
		"`provides` glob that matches nothing is a load error, so remove its\n"+
		"manifest entry too.\n\n"+
		"Each capability imports only the public `juggler/*` SDK.\n\n"+
		"## Reference\n\n"+
		"- `docs/extension_tutorial.md` — builds an extension end to end.\n"+
		"- `docs/extension_guide.md` — the reference: manifest, capabilities, trust model.\n"+
		"- `examples/extensions/` — small, copyable examples of every capability type.\n"+
		"- `web/sdk/*.js` — the base classes; each opens with a full method reference.\n",
		base, base, extManifestFile, extManifestFile)

	return map[string]string{
		extManifestFile:                      manifest,
		"context-items/echo-context-item.js": contextItem,
		"strategies/sample-strategy-type.js": strategy,
		"commands/hello-command-type.js":     command,
		"README.md":                          readme,
	}
}
