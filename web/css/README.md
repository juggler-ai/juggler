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
owns every rule scoped by it. No name has two owners: a glob like `notice*` may
not cover a name another sheet claims, because a class two groups style is a
collision waiting for markup to find it.

## Tokens

Split by what they are, not by which theme was written first:

- **`tokens/scale.css`** — everything theme-independent: spacing, radii, font
  sizes, line heights, z-index, motion, shadows, scrollbar metrics, and the
  colours that are the same in both themes (black overlays, the modal scrim,
  the shadow and mask colours). One definition, applying to both themes.
- **`tokens/theme-dark.css`, `tokens/theme-light.css`** — colour, plus the
  font-weight roles, the one thing besides colour a theme decides (see
  [The scales](#the-scales)). **Every colour token must be defined in both.**
  The linter checks it.

The exception is a token deliberately defined for one theme only, consumed with
the other as its fallback:

```css
background: var(--ci-preset-badge-blue, var(--ci-preset-blue));
```

That is a light-theme override with a documented default, not a missing token.
Write it that way and the check will accept it.

### The scales

A sheet, or a style injected from JS, says each of these through its token,
never as a literal; `scale-literal` fails one written out.

- **Spacing** — `--space-2` … `--space-64`, named for the size in pixels at
  100% zoom: two-pixel steps up to 16, wider ones after. Every padding, margin
  and gap. A value between two steps is a choice between them, not a new step.
  `--spacing-xs` … `--spacing-2xl` are aliases kept for third-party extension
  stylesheets; nothing in this tree writes them.
- **Font size, radius** — `--font-size-*`, `--radius-*`.
- **Font weight** — the roles `--font-weight-normal`, `-medium`, `-semibold`,
  `-bold`. Each theme sets its own (dark a step lighter, because light text on
  a dark ground reads heavier), so a weight written as a number is the one
  weight in the app that doesn't follow the theme.
- **Line height** — `--leading-snug`, `-tight`, `-normal`, `-relaxed`: one-line
  labels, dense UI text, running text, long prose.
- **Motion** — a transition takes its duration from `--duration-fast`, `-base`,
  `-slow` or `-slower`, its curve from `--ease-out`, `-in` or `-spring`, or both
  at once from `--transition-fast`, `-base` or `-slow`. An animation's own
  period and the timing of its keyframe steps are its choreography, and stay as
  written.
- **Tracking** — `--tracking-caps` (0.04em) is the letter spacing of every
  run of capitals: the caps label, and any chip, badge or toggle set in them.
- **Disabled** — `--disabled-opacity` (0.5) is how faint a control that cannot
  be used is. A row marked "unavailable" that still answers a click is not
  disabled, and keeps its own dimming.
- **z-index** — the ramp, bottom to top: `--z-base`, `--z-raised`,
  `--z-controls`, `--z-scrim`, `--z-dropdown`, `--z-modal`, `--z-above-modal`,
  `--z-toast`, `--z-frame`. A single digit is allowed only for order within a
  stacking context the component makes for itself, which the ramp has no say in.

### Colour

- **Say the role, not the hue.** `--danger` (failed, invalid, or about to
  destroy something), `--success` (succeeded, allowed, installed, saved),
  `--warning` (waiting on you, unsaved, take care), `--info`. A rule that paints
  an error `--accent-red` is right only until the theme decides errors are
  another red. The raw accents are for colour that says nothing more than
  itself: syntax, diff counts, the `tint-*` presets, an activity indicator.
- **`--accent-blue-strong`, `-green-strong`, `-red-strong`** — each accent at
  more contrast with the page: lighter in dark, darker in light. The hover of a
  fill the accent paints, and text that must read as the accent on the page.
- **`--wash-1` … `--wash-5`** — the text colour laid thinly over a surface
  (white in dark, black in light), faintest to strongest: hover and pressed
  fills, hairlines on chrome. `--overlay-dark-*` is black in both themes, and
  `--modal-scrim` is the one dim behind a modal.

### Rules for using them


- **Never hardcode a colour.** A literal colour is written in `tokens/scale.css`,
  `tokens/theme-dark.css` or `tokens/theme-light.css` and nowhere else; every
  other sheet — extensions' and `web/machine/`'s included — says a colour as a
  `var()`, a `color-mix()` of tokens, a relative colour from one
  (`rgb(from var(--danger) r g b / 15%)`), `transparent` or `currentcolor`.
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
- **A custom property or `@keyframes` a sheet defines is named for a group
  that sheet owns.** It is read against `owns` as a class would be, and a
  glob-free entry also covers its own sub-names: `btn` owns `--btn-glyph` and
  `@btn-spin`. Where no class entry states the group's prefix, claim it with a
  `--` entry (`"--settings-*"`), which claims property and keyframes names
  only, never a class. A sheet may also set another group's hook
  (`--btn-ghost-bg` from the header) or override a token for a subtree.
  `tokens/` and `enumerates` sheets own nothing and are exempt.
- `__element` / `--modifier` within a component is fine and used in places
  (`.pinboard-tabbar__list`, `.update-btn--progress`). Consistency inside one file
  matters more than consistency across all of them.
- **State is one convention.** Where an ARIA attribute (or a native one —
  `[hidden]`, `:disabled`, `[open]`) expresses the state and the script sets
  it, style the attribute and set no class for it: `[aria-expanded="true"]`
  on a disclosure button, `[aria-selected="true"]` on a tab or option,
  `[aria-checked="true"]` on a checkbox, radio or menu row,
  `[aria-current="true"]` on the current item of a set. Otherwise the state
  class is `is-*` (`.is-open`, `.is-active`, `.is-selected`, `.is-cursor`) —
  never a bare `.open`, `.active`, `.selected`, `.show`, `.focused`,
  `.highlighted` or `.expanded`. A component's `--modifier` is a variant,
  not a transient state. Don't add ARIA a role doesn't call for just to have
  something to style.
- Utilities are `u-` prefixed, and only utilities are.
- **A class name assembled in JS must still be findable.** `color-${name}` is
  fine, but list it in `manifest.json` under `dynamicClasses` as
  `{ "pattern": "color-*", "builtBy": "<file>" }`, or the dead-selector check
  will offer to delete the CSS that serves it. The check re-proves each entry:
  `builtBy` must be production code that composes that prefix.

## Buttons

`patterns/buttons.css` is the app's one button; its header comment is the
reference.

- **A button is `.btn` + a size + a role**: `btn btn-sm btn-neutral`. No size
  class is the default dialog size; `.btn-sm` and `.btn-xs` are compact.
- **An icon button is `.btn .btn-icon`**, with `.btn-icon-lg` for a bigger
  square. Without a role it is quiet: no frame, a wash on hover.
- **Roles are the shared classes** — `.btn-primary`, `-neutral`, `-secondary`,
  `-danger`, `-ghost`, plus `.btn-danger-quiet` — never a bare `.primary` or
  `.danger`, and never a component's own `-primary` suffix.
- **Customise through the hooks** (`--btn-glyph`, `--btn-icon-size`,
  `--btn-ghost-*`), not by out-ranking a rule. The pattern's states hold one
  class of specificity so a component never has to.
- **A component class on a button carries only what is its own**: where it
  sits, a reveal on hover, a state the pattern has no name for. Never the box
  or the role again.

## Fields

`patterns/fields.css` is the app's one text field — an input, textarea or
select; its header comment is the reference.

- **A field is `.field-input` + an optional size**: `field-input field-input-sm`.
  No size class is the default settings-row size; `.field-input-sm` and
  `.field-input-xs` are compact. A select gets the chevron with no extra class.
- **Invalid is `aria-invalid="true"`**, never a class: it draws the danger
  border, and the danger halo when focused, and tells a screen reader too.
- **On a wrapper**, `.field-input` draws the box and the focus look around a
  bare control inside it (a field with a button or a prefix beside it). The
  control carries no field class and drops its own ring.
- **Customise through the hooks** (`--field-bg`, `--field-border`,
  `--field-radius`, `--field-pad-y`, `--field-pad-x`), not by out-ranking a
  rule. A component class on a field carries only what is its own — width,
  flex, a monospace face, alignment — never the box, the size or a state.

## Menus

`patterns/menus.css` is the app's one menu; its header comment is the
reference.

- **A menu is a `.dropdown-menu` of `.menu-item` rows**, with `.menu-divider`
  between groups and `.menu-group` for an indented run.
- **A row's state is a shared modifier** — `.menu-item-selected` (the chosen
  value, a filled accent row), `.menu-item-danger`, `.menu-item-unavailable` —
  never a bare `.active` or `.danger`. A checkbox or radio row that is on is
  `aria-checked="true"`, which is what is styled.
- **A section label is `.menu-header .caps-label`** (a filled bar), or with
  `.menu-header-plain` an unfilled label over a hairline, for a list of
  hoverable rows where a filled bar reads as a hovered row.
- **Customise through the hooks** (`--menu-item-pad-y`,
  `--menu-item-pad-start`, `--menu-item-pad-end`, `--menu-header-pad-start`),
  set on the list, not by out-ranking a row. A component class on a row
  carries only what is its own: its layout inside the row, a cursor state the
  pattern has no name for.

## Labels and text

- **A small uppercase label is `.caps-label`** — the eyebrow over a group of
  rows, a menu section or a panel; `.caps-label-lg` is the larger section
  heading. `patterns/labels.css` holds only the type; colour and spacing are
  the component's. A chip, badge or toggle in capitals is not a label: it keeps
  its own type and takes only `--tracking-caps`.
- **One line cut with an ellipsis is `.text-truncate`** (`patterns/text.css`).
  A pattern, not a utility, because a component may take the cut back (a row
  that wraps when expanded). In a flex row the item also needs `min-width: 0`;
  that stays with the row.
- **Hidden from sight but not from a screen reader is `.u-visually-hidden`**
  (`utilities/utilities.css`). `.hidden` and `[hidden]` remove it from both.

## Extensions

Extension CSS is a string passed to `injectStylesOnce(id, css)` from
`juggler/ui`; there is no `.css` loader. `tooling/lint-css-in-js.js` lints those
strings with the same stylelint config as the sheets, and `scale literal` holds
them to the tokens too.

Injected CSS is unlayered and appended after the host's `<link>`s, so it wins
ties against host CSS (until the host is layered, see the last bullet under
[Layers](#layers)). With that comes the obligation not to break the app:

- **Host classes are `public` or nothing.** A class any `web/css` sheet styles
  may be set or styled by an extension only when manifest.json's `public` list
  covers it (each entry says what it is for); `web/sdk` may also use the `sdk`
  list, the markup its own helpers build. A class no host sheet styles is the
  extension's own, styled by its own injected CSS. The `extension styling`
  check enforces this; `extensionDebt` lists the in-tree files still leaning
  on internals, and only shrinks.
- The main `public` families: buttons (`btn`, its sizes and roles), fields
  (`field-input*`), menus (`dropdown-menu`, `menu-*`), caps labels
  (`caps-label*`), `text-truncate`, utilities (`u-*`, `hidden`), the twenty
  `color-*` presets, `surface-*`/`tint-*`, `icon-*`, state classes (`is-*`),
  and the context-item containers (`context-item-expanded-content`,
  `ci-code-content`, `ci-code-block`, `ci-text-block`, `markdown`) to scope
  your own rules under.
- **Use the tokens.** Spacing is `--space-*` (`--spacing-*` are legacy
  aliases); colours, sizes, radii, weights and motion all have tokens.
- **Both themes must work, through tokens.** In-tree extensions are linted
  against `:root[data-theme]` like every sheet outside `tokens/`; third-party
  ones should hold to the same.
- **Stay off the host's stacking layers.** `var(--z-base)` and `var(--z-raised)`
  are yours; `--z-controls` and every rung above it belong to host chrome.
- No `!important`, no Shadow DOM, no inline styles for theming, no hardcoded
  colours, no `px`.

## What the linter checks

`make lint` runs stylelint over every sheet and over the CSS JavaScript
passes to `injectStylesOnce()`, with one config (`tooling/.stylelintrc.json`,
whose `$comment` says why each threshold is what it is):

- `rem` not `px`, and no literal colour outside `tokens/` (see [Tokens](#tokens)).
- No ID selectors: style a group-prefixed class; the id can stay for JS.
- At most 4 compound selectors deep, and specificity at most `0,4,2`. Put the
  part of a selector that is a condition rather than an identity in `:where()`.
- No `[data-theme]` outside `tokens/`: a theme-dependent value is a token
  defined in both theme files.
- No `!important`; the few that must win at any specificity carry a disable.
- Custom properties and `@keyframes` names are kebab-case.
- Every `stylelint-disable` gives its reason after ` -- `, and one that
  disables nothing is an error.

Then `scripts/lint-css-arch` checks:

| Check | What fails it |
|---|---|
| ownership | A selector in a file that owns neither its root nor its subject; a name two sheets' `owns` both cover; a custom property no sheet owns and no token defines, or a `@keyframes` not named for the sheet's own group (see [Naming](#naming)). |
| dead selectors | A class or id, in any production sheet — these, an extension's, `web/machine/`'s — that no production string puts on an element (tests, comments, `t()` text and extension CSS are not evidence), matching no `dynamicClasses` pattern. |
| token parity | A colour token defined for one theme only without the fallback idiom; a `var()` that resolves to nothing; a fallback on a token that is always defined; a fallback on a property nothing defines and JS does not set. |
| link parity | `index.html` and `headless-test.html` disagreeing on the sheet list. |
| layer order | A sheet whose layer in `manifest.json` is not its directory, or one listed out of layer order. |
| asset url | A relative `url()` that resolves to no file. |
| scale literal | A sheet or injected CSS writing out a font size, radius, weight, line height, z-index, transition timing or spacing that has a token. What may stand in for one (`em` sizes, a `0`/`50%` radius, a hairline nudge, a single-digit z-index) is listed at `SCALE_FAMILIES` in the script. |
| extension styling | Extension or SDK code setting or styling a class a host sheet styles that `public` (or, for `web/sdk`, `sdk`) does not cover and `extensionDebt` does not list; a stale or malformed entry in any of the three lists. |
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
