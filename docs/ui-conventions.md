# UI conventions — manage panel & settings

Stem's settings surfaces (the Brain / Memory tab, MCP & Skills, Settings) share one
visual vocabulary. New panels must reuse it so they don't drift the way the Recall
tab once did (flat, card-less, visually unlike Facts). All styling is plain global
CSS in `src/renderer/styles.css` — there are no CSS modules or utility classes.
Build UI by composing the class names below, not by inventing new layout.

## The building blocks

| Class | Role | When to use |
|-------|------|-------------|
| `.grp-head` | Uppercase section label ("MEMORY", "MODEL") | Above a `.group` or `.formgroup` to name a section. |
| `.group` / `.group-row` | Inset-grouped list card (System-Settings style) | Rows of toggles/switches. |
| `.formgroup` | **Bordered rounded card** (surface bg, hairline border, padding) | **Every standalone control or cluster of controls.** This is the default container. A bare control with no card is a bug. |
| `.set-block` / `.set-sub` | Vertical stack with a small sub-label | A labelled control *inside* a `.formgroup` (e.g. a segmented control + its helper text). |
| `.set-block.fg-divider` | `.set-block` with a hairline top divider | A second control section stacked inside the same `.formgroup`. |
| `.seg-ctl` | Segmented button control | Mutually-exclusive presets (Frequent/Normal/…, 50 MB/100 MB/…). Mark the chosen one `.active`. |
| `.muted` | Secondary helper text (12px, muted) | One short explanatory line under a control. |
| `.memory-view` | Section divided off by a top border | The "stored data" area of a memory tab (head + actions + body). |
| `.memory-view-head` + `.memory-view-actions` + `.link-btn` | Section header with right-aligned text actions | "Stored memory" / "Episodic recall" headers with Refresh / Tidy up. |
| `.memory-view-toggle` | Chevron disclosure header (`ChevronRight` + `svg.open` rotate) | Collapsible section headers; show a count in the label when collapsed. Renders **recessive — muted color, normal weight (400)**, subtler than body text, brightening to `--ink` on hover. A disclosure is a quiet affordance, not a heading; never bold. |
| `.memory-reset` / `.memory-reset-trigger` | Understated, bottom-tucked destructive action | Reset / erase, with an inline confirm step before acting. |

## Rules

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
6. **Helper text is one muted line.** Plain language, no jargon. Colors and dividers
   come from CSS variables (`--surface`, `--line`, `--ink`, `--muted`, `--accent`) so
   everything works in light and dark — never hard-code colors.

## Reference implementations

- `src/renderer/manage/ManagePanel.tsx` — `FactsTab` and `EpisodicTab` are the
  canonical examples of the card + `.memory-view` + collapse patterns.
- `src/renderer/styles.css` — the `.formgroup`, `.seg-ctl`, `.memory-view*`,
  `.set-block`, and `.memory-view-toggle` rules.
