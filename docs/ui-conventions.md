# UI conventions

Stem is one app rendered across three windows — the main window, the Quick Chat overlay, and
the status HUD — all driven by a single global stylesheet, `src/renderer/styles.css`. There are
no CSS modules, no utility classes, and (deliberately) no React styling primitives: you build UI
by composing the class names below and the design tokens at the top of the stylesheet. New panels
must reuse this vocabulary so they don't drift the way the Recall tab once did (flat, card-less,
visually unlike Facts).

## Design tokens

The `:root` block in `src/renderer/styles.css` is the single source of truth for geometry, not
just color. **Never hard-code a font-size, radius, shadow, z-index, gap, or motion timing.** Reach
for a token; if none fits, add one to `:root` rather than dropping a literal into a rule. Colors
are tokenized too (`--ink`, `--muted`, `--surface`, `--line`, `--accent`, …) and every surface
must use them so light and dark mode both work — never hard-code a color.

| Family | Tokens | Use |
|--------|--------|-----|
| Type | `--fs-10` … `--fs-20` (`--fs-13` is body/default) | All `font-size`. The old 12.5/13.5 in-betweens fold into `--fs-13`. |
| Spacing | `--sp-1` (2px) … `--sp-12` (24px), 4px grid | `gap` everywhere; prefer it for new `padding`/`margin` too. |
| Radii | `--radius-sm` (4), `--radius` (6, default), `--radius-md` (8), `--radius-lg` (12), `--radius-pill` | Corners. `--radius` is the default control corner; cards/popovers use `--radius-md`; overlays/modals use `--radius-lg`. |
| Heights | `--ctl-h-sm` (24), `--ctl-h` (28), `--ctl-h-lg` (32) | Standard square/pill action buttons. |
| Shadows | `--shadow-focus`, `--shadow-pop`, `--shadow-btn` | Focus ring / drag-over, menus & popovers, raised primary buttons. Reach for these before inventing a recipe. |
| Z-index | `--z-sticky` (1), `--z-menu` (50), `--z-popover` (60), `--z-overlay` (1000), `--z-modal` (1200) | The stacking ladder. Layered things pick a rung, not a magic number. |
| Motion | `--motion-fast` (0.12s), `--motion-med` (0.15s) | Hover reveals/carets, and toggles/zone transitions respectively. |

Two deliberate exceptions live outside the scales: avatar/dot circles use `border-radius: 50%`,
and the drop-overlay glyphs keep their decorative app-icon curve (`18px`/`22px`). A handful of
floating panels (gate card, HUD pill, MCP confirm card) keep context-tuned one-off shadows because
each is tuned to its own backdrop. Anything else should use a token.

## Manage panel & settings building blocks

Stem's settings surfaces (the Brain / Memory tab, MCP & Skills, Settings) share one visual
vocabulary. Compose these — don't invent new layout.

| Class | Role | When to use |
|-------|------|-------------|
| `.grp-head` | Uppercase section label ("MEMORY", "MODEL") | Above a `.group` or `.formgroup` to name a section. |
| `.group` / `.group-row` | Inset-grouped list card (System-Settings style) | Rows of toggles/switches. |
| `.formgroup` | **Bordered rounded card** (surface bg, hairline border, padding) | **Every standalone control or cluster of controls.** This is the default container. A bare control with no card is a bug. |
| `.set-block` / `.set-sub` | Vertical stack with a small sub-label | A labelled control *inside* a `.formgroup` (e.g. a segmented control + its helper text). |
| `.set-block.fg-divider` | `.set-block` with a hairline top divider | A second control section stacked inside the same `.formgroup`. |
| `.seg-ctl` | Segmented button control | Mutually-exclusive presets (Frequent/Normal/…, 50 MB/100 MB/…). Mark the chosen one `.active`. |
| `.muted` | Secondary helper text (`--fs-12`, muted) | One short explanatory line under a control. |
| `.memory-view` | Section divided off by a top border | The "stored data" area of a memory tab (head + actions + body). |
| `.memory-view-head` + `.memory-view-actions` + `.link-btn` | Section header with right-aligned text actions | "Stored memory" / "Episodic recall" headers with Refresh / Tidy up. |
| `.memory-view-toggle` | Chevron disclosure header (`ChevronRight` + `svg.open` rotate) | Collapsible section headers; show a count in the label when collapsed. Renders **recessive — muted color, normal weight (400)**, subtler than body text, brightening to `--ink` on hover. A disclosure is a quiet affordance, not a heading; never bold. |
| `.memory-reset` / `.memory-reset-trigger` | Understated, bottom-tucked destructive action | Reset / erase, with an inline confirm step before acting. |

### Rules

1. **Every control lives in a card.** Wrap controls in `.formgroup`. Don't place a
   `.set-block` or `.seg-ctl` directly in the tab root — that's what made Recall look
   unlike Facts.
2. **Group related controls in one card**, separated by `.fg-divider`, rather than
   stacking many tiny cards (see the Facts tab: model picker + tidy cadence share a card).
3. **Sibling tabs mirror each other.** Facts and Recall are siblings — same card
   structure, same `.memory-view` header pattern, same helper-text voice. If you add a
   control to one, consider whether its sibling needs the parallel treatment.
4. **Long lists collapse by default**, showing a count in a `.memory-view-toggle`
   header (e.g. "Stored memory (12)"); reuse the `ChevronRight` + `svg.open` idiom.
5. **No raw paths / DB internals in the UI.** Memory is an opaque local store; don't
   surface filesystem paths to `recall.sqlite` etc.
6. **Helper text is one muted line.** Plain language, no jargon.

## Chat & composer

| Class | Role |
|-------|------|
| `.messages` | The scrolling conversation pane (auto-hiding scrollbars). |
| `.message` + `.msg-avatar` (`.you` / `.stem` / `.sys`) | A message row: avatar gutter + body. |
| `.message-who` / `.message-meta` | Author line; `.message-meta` (model/effort) is muted and revealed only on `:hover`. |
| `.message-actions` / `.message-action` | Per-message hover actions (retry/edit/fork) — muted icon buttons revealed on hover, mirroring `.message-meta`. |
| `.composer` / `.composer-field` | The composer. `.composer-field` is an inset rounded card that shows `--shadow-focus` on `:focus-within` and `.drag-over`. |
| `.composer-row` / `.composer-controls` | Input row (textarea + `.icon-btn` send) and the effort/speed `.seg-ctl.compact` row above it. |
| `.icon-btn` (`.stop`) | The accent send button; `.stop` turns it into the danger-colored stop button. |
| `.attachment-chip` | Attachment chips above the input row. |

Reveals are calm: actions and meta fade in on `:hover` over `--motion-fast`, never appear by
default. The composer auto-grows from one line (`min-height` 24px) to `max-height` 180px.

## Keyboard shortcuts

`src/renderer/shortcuts.tsx` is the single source of truth for Cmd shortcuts and their hints
(`BINDINGS`). It's a main-window concern — `<ShortcutsProvider>` wraps `<App>` only (Quick Chat
has no provider; the hook/components fall back to a no-op there).

- **Bind an action** with `useShortcut('id', handler)` where the action lives (e.g. `App` registers
  `new-conversation`/`toggle-inspector`; `ChatView` registers the composer ones). A bound combo
  fires immediately on press.
- **Show the hint** by dropping `<ShortcutHint id="…" placement="tr|br" />` *inside* the control it
  labels; the control must be a positioning context (`position: relative`). Hold ⌘ alone for ~1.2 s
  and every hint reveals a `.kbd` keycap — a real shortcut press, any other key, or ⌘-up cancels
  the reveal, so quick presses never flash.
- `.kbd` is the keycap (inverted `--ink`/`--paper` so it reads in light and dark); `.sc-hint` is the
  floating wrapper that anchors and fades it in. Add a new shortcut by extending `BINDINGS` and
  placing a `<ShortcutHint>` — never hard-code a keycap elsewhere.

## Quick Chat overlay (`.qc-*`) and status HUD (`.hud-*`)

These are **separate frameless windows** (`body.qc-body`, `body.hud-body`) that share the same
token layer. Both are transparent-bodied so native vibrancy/blur shows through.

- Quick Chat: `.qc-card` is the frosted card; `.qc-row` + `.qc-input` is the single-line entry;
  `.qc-foot`/`.qc-hint`/`kbd` is the footer; the expanded `.qc-panel`/`.qc-head` stacks a
  draggable header over the reused `ChatView`. The whole card is a drag region; interactive
  controls opt out with `-webkit-app-region: no-drag`.
- HUD: `.hud-pill` is a bottom-left pill reusing `.activity-dots`; `.finished` marks a completed
  turn. It is its own blurred surface (not on a window chrome).

## Overlays & menus

| Class | Role |
|-------|------|
| `.ctx-menu` (`--z-menu`) | Right-click context menu; `.danger` items, `.ctx-sep`, `.ctx-label`. |
| `.mp-pop` (`--z-popover`) | The filterable model picker popover (sits above context menus). |
| `.drop-overlay` / `.drop-zone` / `.drop-band` (`--z-overlay`) | Drag-to-place overlay; `.dz-glyph` are the decorative destination glyphs (keep their own radius). |
| `.mcp-approval-backdrop` / `.mcp-approval-card` (`--z-modal`) | Assistant-proposed MCP change confirm dialog. |

Pick the matching `--z-*` rung for anything that floats; don't invent a magic z-index.

## MDX widgets

Assistant replies render through MDX. `.mdx` is the content root; reuse `.inline-code`,
`.code-block` (+ `.code-copy`), `.callout` (`.callout-info|warn|success|danger`), `.steps`/`.step`,
`.collapsible`, `.tabs`/`.tab`, `.data-table`, `.chart`, the `.quiz`, and the `.mdx-form`
(`.mdx-field`) blocks rather than styling new markup. These widgets share the token radii, fields,
and accent treatment so a generated message reads like the rest of the app.

## Reference implementations

- `src/renderer/manage/ManagePanel.tsx` — `FactsTab` and `EpisodicTab` are the canonical examples
  of the card + `.memory-view` + collapse patterns.
- `src/renderer/chat/ChatView.tsx` / `MdxView.tsx`, `src/renderer/quickchat/`,
  `src/renderer/files/DropOverlay.tsx` — the chat, Quick Chat/HUD, and overlay surfaces.
- `src/renderer/styles.css` — the `:root` token block and every rule above.
