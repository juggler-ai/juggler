# Styling Juggler

The contract for every stylesheet in the app, and for CSS shipped by an
extension. If you are adding a rule and wondering where it goes, the answer is
in [Where a rule goes](#where-a-rule-goes).

## The shape of it

- **Light DOM, one global cascade.** No Shadow DOM anywhere, deliberately:
  components are styled by element-name and class selectors from these
  stylesheets, and an extension can restyle what the host renders.
- **No build step.** These files are authored by hand, embedded into the binary
  by the `css/*` glob in `web/embed.go` (which recurses, so the subdirectories
  come too), and served verbatim under a per-process version prefix
  (`/v<id>/css/…`). Nothing bundles, minifies or transforms them. What you write
  is what ships.
- **One directory per layer**, and a sheet's directory is its layer:
  `tokens/ base/ layout/ patterns/ components/ utilities/`, plus `vendor/` for
  third-party themes. `manifest.json` is the list — every sheet, its layer, and
  the selector roots it owns.
- **Two `<link>` lists, and they must agree**: `web/index.html` and
  `web/js-tests/headless-test.html`. A sheet missing from the second is a sheet
  the browser suite never applies, so its rules are untested. `lint-css-arch`
  checks the two lists match.

## Layers

A sheet's layer is its directory, recorded against it in `manifest.json`, whose
`layers` list is the order. **They are not cascade layers yet.** No sheet
contains `@layer` and the HTML declares no layer order, so today a layer is a
filing convention: the `<link>` lists run in layer order, which makes a later
layer win a *tie* on specificity, but a more specific rule in a lower layer
still wins, exactly as unlayered CSS always has.

The plan is to wrap each sheet in its layer, with the order declared once:

```css
@layer tokens, base, layout, patterns, components, vendor, utilities;
```

That wrap waits on the [inversion check](#the-inversion-check): every rule
that wins today by out-ranking a rule in a higher layer is a rule the wrap would
switch off, and `.layer-inversion-ratchet` counts them per file pair. When it
is empty, the wrap changes nothing anyone can see.

| Layer | Holds |
|---|---|
| `tokens` | Custom properties only — the scales and the two themes. No selectors beyond `:root`. |
| `base` | Element defaults: reset, typography, forms, scrollbars, per-platform tweaks. Unclassed selectors live here and nowhere else. |
| `layout` | The app shell — header, columns, conversation area, the responsive rules that move them. |
| `patterns` | Idioms shared by several unrelated components: menus, modals, buttons, badges, icons. |
| `components` | One file per feature group. The bulk of the CSS. |
| `vendor` | Third-party themes — **the colours only**. Above `components` because a syntax theme has to beat the text colour a feature group applies to the block around it. The geometry PrismJS ships with (padding, `white-space`, `font-size`) is not here: it is in `patterns/code.css`, below the components that host a code block, because a panel knows how it wraps and a theme does not. |
| `utilities` | Single-purpose `u-*` helpers, for styling that every element carrying it wants unconditionally. Last, so they win — and so nothing can override them. Shared chrome a component refines is not a utility: that is what `patterns` is for. |

Wrapped, layers mean **source order between files no longer decides who wins**,
which is what makes it safe to have twenty component files instead of one
enormous one. Write every rule for that cascade now — the inversion check holds
new CSS to it already. The consequences worth knowing:

- **Specificity does not cross a layer boundary.** Within a layer it decides as
  it always did; between layers the higher layer wins at *any* specificity. A
  `layout` rule cannot be quietly beaten by a `components` rule — and equally, a
  `layout` rule cannot beat a `components` rule by qualifying its selector,
  however specific it gets.
- So **an override must live in the same layer as what it overrides**, or in a
  higher one. There is no third option short of `!important`. If a rule exists to
  override another and sits below it, that rule is in the wrong file, and no
  amount of selector qualification will rescue it.
- **A component cannot out-order a utility, or out-rank one either.** `utilities`
  is the last layer, so a component that means to override a `u-` class it
  carries cannot do it from `components` at all: either it stops carrying the
  utility, or the shared part moves to `patterns`, or the utility loses the
  declaration being fought over.
- **Unlayered CSS beats every layer.** Extension stylesheets are unlayered, so
  once the wrap lands an extension can override host styling without
  `!important`. Until then an extension rule wins where it out-ranks the host's,
  or ties it — `injectStylesOnce()` appends to `<head>`, after the host's links.
  Either way, do not use `!important` to win.

## Where a rule goes

**A selector belongs to the file that owns its root.** The root is the leading
element name or class of the selector — `composer-box .send-button` is owned by
`composer-box`, not by `.send-button`. Find the group that owns that root in
`manifest.json` and put the rule there, with the rest of its group.

When a selector names two groups' roots — one owning the scope, one owning the
subject — both files are defensible, and the check accepts either. File it with
whichever the rule is a decision *about*: `composer-box .model-selector-button`
belongs to the model picker, `[data-view="pinboard"] conversation-bar` to the
board.

Three corollaries, and they are the whole discipline:

- **A rule never goes "at the end of the file".** That habit is what produced a
  12,000-line `components.css` in which the composer was styled in seven places
  spread over four thousand lines.
- **`@media` and `@keyframes` live with what they modify**, not in a block of
  their own at the bottom. A component's responsive behaviour is part of that
  component.
- **`patterns/` is a decision, not a drift.** Move something there when a second
  unrelated component needs it, and say so in a comment. "Shared" should be a
  choice someone made, not the residue of a rule that was never re-filed.

`lint-css-arch` enforces ownership against `manifest.json`, with no
exceptions: a misfiled rule is moved, not excused. A sheet may also claim a
document mode as a scope — `"[data-view=\"pinboard\"]"` in its `owns` — and then
owns every rule scoped by it.

## Tokens

Split by what they are, not by which theme was written first:

- **`tokens/scale.css`** — everything theme-independent: spacing, radii, font
  sizes, z-index, shadows, transitions, scrollbar metrics, and the colours that
  are the same in both themes (black overlays, the modal scrim, the shadow and
  mask colours). One definition, applying to both themes.
- **`tokens/theme-dark.css`, `tokens/theme-light.css`** — colour, and nothing
  else. **Every colour token must be defined in both.** The linter checks it.

The exception is a token deliberately defined for one theme only, consumed with
the other as its fallback:

```css
background: var(--ci-preset-badge-blue, var(--ci-preset-blue));
```

That is a light-theme override with a documented default, not a missing token.
Write it that way and the check will accept it.

Rules for using them:

- **Never hardcode a colour.** A literal colour is written in `tokens/scale.css`,
  `tokens/theme-dark.css` or `tokens/theme-light.css` and nowhere else; every
  other sheet — extensions' and `web/machine/`'s included — says a colour as a
  `var()`, a `color-mix()` of tokens, a relative colour from one
  (`rgb(from var(--accent-red) r g b / 15%)`), `transparent` or `currentcolor`.
  stylelint enforces it: `color-no-hex`, `color-named`, and the repo's own
  `juggler/no-literal-colour-function` (`rgb()`, `hsl()`, `oklch()`, `color()`
  and the rest, in `tooling/stylelint-rules/`), switched off for `tokens/` by
  path and for nothing else. A `stylelint-disable` naming any of them is itself
  an error. If no token fits, add one with a name for what it is for, not for
  its value, and define it in both themes (or once in `scale.css`).
- **`rem`, not `px`**, except borders, outlines and shadows. stylelint enforces
  this; a genuine exception (geometry that must not scale with the user's zoom)
  takes a `stylelint-disable` with a comment saying why, and a matching
  `stylelint-enable`.
- **`var(--x)` with no fallback must resolve.** An undefined custom property
  silently invalidates the whole declaration — and inside `color-mix()` it takes
  the rest of the value with it. If JS sets the property, list it in
  `manifest.json` under `jsSetProperties` so the linter knows.
- **No fallback on a token that is always there.** A token in `scale.css`, or
  in both themes, is defined on every element (the app sets `data-theme` before
  first paint), so `var(--accent-red, #f85149)` writes a second copy of one
  theme's value that can only drift. Write `var(--accent-red)`. A fallback is
  for a property that can genuinely be absent: a one-theme token (above), a
  property a component sets on some elements, or one JS sets.
- **A tint of a token is `color-mix()`, not its value spelled out.**
  `color-mix(in srgb, var(--accent-blue) 15%, transparent)` follows the theme;
  `rgb(88 166 255 / 15%)` is the dark accent in both.

## Naming

- A class is prefixed with its group: `.composer-*`, `.settings-*`,
  `.pinboard-*`, `.spinner-*`. The prefix is what makes ownership checkable.
  There is no second scheme for classes JavaScript selects: script and
  stylesheet name an element by the same group-prefixed class, and a custom
  property a group sets carries the same prefix (`--spinner-angle`).
- `__element` / `--modifier` within a component is fine and used in places
  (`.pinboard-tabbar__list`, `.pp-status--invalid`). Consistency inside one file
  matters more than consistency across all of them.
- Utilities are `u-` prefixed, and only utilities are.
- **A class name assembled in JS must still be findable.** `color-${name}` is
  fine, but list it in `manifest.json` under `dynamicClasses` as
  `{ "pattern": "color-*", "builtBy": "<file>" }`, or the dead-selector check
  will offer to delete the CSS that serves it. The check re-proves each entry:
  `builtBy` must be production code that composes that prefix.

## Extensions

Extension CSS ships as a `.css` file beside the extension and is linted like
everything else. `injectStylesOnce()` remains for styles that genuinely can't be
static.

Extension sheets are unlayered, so once the host's sheets are wrapped in layers
they win against host CSS by default (until then, see the last bullet under
[Layers](#layers)). With that comes the obligation not to break the app:

- **Scope to something you own.** Context item content renders inside
  `.context-item-expanded-content` / `.context-item-collapsed-content` — the
  classes the host actually sets. Prefix your own classes `ci-{pluginId}-`.
- **Both themes must work.** Use tokens and you get this for free; reach for
  `:root[data-theme="light"] …` only when a token genuinely cannot express it.
- **Stay off the host's stacking layers.** `var(--z-base)` and `var(--z-raised)`
  are yours; `--z-controls`, `--z-dropdown`, `--z-modal`, `--z-above-modal` and
  `--z-toast` belong to host chrome.
- No `!important`, no Shadow DOM, no inline styles for theming, no hardcoded
  colours, no `px`.

Useful classes the host styles for you: `.ci-code-content` (monospace block)
and the twenty `color-*` presets (`slate blue indigo purple magenta pink red
orange amber yellow lime green emerald teal cyan sky brown stone zinc
crimson`).

There were once badge, empty and error classes here too. Nothing used them —
not the host, not an extension, not a test — so they went the way of every
other rule the dead-selector check finds. If you want one back, say which and
it comes back with a use.

## What the linter checks

`make lint` runs stylelint over every sheet — `rem` not `px`, and no literal
colour outside `tokens/` (see [Tokens](#tokens)) — and then
`scripts/lint-css-arch`, which checks:

| Check | What fails it |
|---|---|
| ownership | A selector in a file that owns neither its root nor its subject. |
| dead selectors | A class or id, in any production sheet — these, an extension's, `web/machine/`'s — that no production string puts on an element (tests, comments, `t()` text and extension CSS are not evidence), matching no `dynamicClasses` pattern. |
| token parity | A colour token defined for one theme only without the fallback idiom; a `var()` that resolves to nothing; a fallback on a token that is always defined; a fallback on a property nothing defines and JS does not set. |
| link parity | `index.html` and `headless-test.html` disagreeing on the sheet list. |
| layer order | A sheet whose layer in `manifest.json` is not its directory, or one listed out of layer order. |
| asset url | A relative `url()` that resolves to no file. |
| layer inversion | A rule filed below a rule it overrides. |

### The inversion check

`layer-inversion` is the one that enforces the rule above — an override must
live in the same layer as what it overrides, or higher. It pairs every rule
against every other and keeps the pairs where a rule in a **lower** layer beats
one in a **higher** layer on specificity: today the specific rule wins wherever
it is filed, under layers it loses, so every such pair is a rule that would
stop working. Equal specificity is not an inversion (source order settles it,
and the link list is in layer order), and neither is `!important` in either
direction.

Whether a pair matters depends on the markup, not the stylesheets: `.markdown p`
only fights `.catalog-title` if some element is a `<p>` carrying that class.
`scripts/css-markup-model` answers that from the code that builds the DOM —
which tag each class lands on, which classes share an element, which elements
cannot nest. It is deliberately generous: where it cannot see, the pair is
reported rather than assumed away.

The counts are held per file pair in `.layer-inversion-ratchet` and only ever go down. To see what is
behind one:

```
node scripts/lint-css-arch --inversions components/pinboard.css utilities/utilities.css
```

Run it on what you changed with `make lint-files FILES="web/css/…"`.

### Checking you changed nothing today

`layer-inversion` looks forward, at what the wrap will do. `scripts/css-cascade-diff`
looks the other way: it works out who wins each contested pair under **today's**
cascade and compares that verdict against another revision.

```
node scripts/css-cascade-diff                 # working tree vs HEAD
node scripts/css-cascade-diff --base develop
```

Use it whenever you move a rule to another file or lower a selector's
specificity with `:where()`. Neither of those crosses a layer boundary, so
neither shows up as an inversion — and both can hand a same-layer neighbour a
fight it used to lose. A rule is identified by what it says rather than where it
lives, so it keeps its identity across the move and can be held to the same
verdict.
