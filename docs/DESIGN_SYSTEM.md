# PayFlow Design System

> A blank financial canvas where intelligent financial behaviour is drawn in cyan.

All tokens live in [`src/app/globals.css`](../src/app/globals.css). Components live in [`src/components/ui`](../src/components/ui). No component may introduce its own hex value.

## 1. Brand concept

| Colour | Meaning |
|---|---|
| White / warm off-white | Clarity, trust. The page is a blank canvas. |
| Near-black | Precision. All primary text, rules, primary icons. |
| Fluorescent cyan (the **marker**) | Money and information actively flowing: live execution path, AI-produced elements, focus, the one primary action on a screen, the wordmark. |

The marker is a highlighter, not a theme colour. Target ≈85–90% neutral, ≤10–15% marker + status colours on any screen. A card is never filled cyan; a background is never washed cyan except `--pf-marker-wash` for selection/focus halos.

**Wordmark.** Typographic only: "Pay" in ink, "Flow" in ink over an imperfect marker stroke (`.pf-mark`) that covers the lower body of the letters, slightly skewed and rotated so it reads as hand-drawn rather than a box. On the login page the stroke draws in once (`.pf-mark-draw`). No symbol, no swoosh, no sparkle.

## 2. Typography

| Role | Family | Licence / source | Why |
|---|---|---|---|
| UI | **Instrument Sans** (variable wght 400–700, wdth 75–100) | SIL Open Font License 1.1 · Google Fonts, loaded with `next/font` (self-hosted at build, no runtime Google request) | Precise, slightly technical grotesk with more character than Inter/Geist; verified to ship `tnum` (tabular figures) so amounts align; width axis available for dense labels |
| Data | **IBM Plex Mono** (400, 500) | SIL Open Font License 1.1 · Google Fonts via `next/font` | PayPal ids, hashes, debug ids, timestamps, JSON. Clear 0/O and 1/l distinction, technical without being a "hacker" font |

Rejected: Inter, Roboto, Arial, Poppins, Montserrat, Open Sans (per brief); Geist (default of every new Next.js app, so it reads generic); Hanken Grotesk and Host Grotesk (no `tnum` feature, verified with fontTools); Manrope (rounder, friendlier than a financial tool should be).

`font-feature-settings: "tnum"` is on for the whole body: every number is tabular.

### Scale

| Token | px / line | Use |
|---|---|---|
| `text-label` | 11 / 14, uppercase, 0.08em, 600 (`.pf-label`) | Section heads, field names, node kinds |
| `text-meta` | 12 / 16 | Timestamps, ids, secondary metadata |
| `text-body-sm` | 13 / 18 | Dense rows, status labels |
| `text-body` | 14 / 20 | Default |
| `text-lead` | 16 / 24 | Intro lines, input values |
| `text-title` | 20 / 26 | Figures in summary rows |
| `text-headline` | 28 / 34 | Page title / status sentence |
| `text-figure` | 44 / 48 | The amount on an approval screen |

Headings are modest; hierarchy comes from weight, case and spacing, not size.

## 3. Colour tokens

| Token | Value | Notes |
|---|---|---|
| `--pf-canvas` | `#fbfaf7` | Page |
| `--pf-surface` | `#ffffff` | Sidebar, login, popovers |
| `--pf-sunken` | `#f4f3ef` | Code blocks, row hover |
| `--pf-line` | `#e6e4de` | Hairline rules (decorative) |
| `--pf-line-strong` | `#cfccc4` | Secondary button border |
| `--pf-field` | `#8a8d94` | Input boundaries — 3.32:1 on white (WCAG 1.4.11) |
| `--pf-ink` | `#0c0d0f` | Primary text |
| `--pf-ink-2` | `#2c2e33` | Body text in lists |
| `--pf-muted` | `#5f6269` | Secondary text (6.1:1) |
| `--pf-faint` | `#8d9097` | Tertiary/disabled only, never essential info |
| `--pf-marker` | `#0fd0f5` | **The brand.** Fills, strokes, active paths. Never text on white (≈1.7:1) |
| `--pf-marker-ink` | `#006d99` | Accent for text/icons on white (5.76:1) |
| `--pf-on-marker` | `#0c0d0f` | Text on the marker (10.5:1) |

Tune the brand by changing `--pf-marker` and `--pf-marker-ink` only.

### Status

| State | Colour | Icon | Always with label |
|---|---|---|---|
| Success | `--pf-ok #1d7a4c` | circle-check | yes |
| Waiting / warning | `--pf-warn #985d00` | circle-alert | yes |
| Blocked / failure | `--pf-danger #b0281f` | circle-x | yes |
| Inactive | `--pf-muted` | dashed circle | yes |
| Live | ink text + pulsing marker dot | dot | yes |
| AI | `--pf-marker-ink` | sparkles | yes |
| Simulated provenance | `--pf-sim #6b4bb8` | flask | yes — "Simulated" |

Colour is never the only carrier of state: `<Status>` always renders icon + label + colour.

### Provenance tags

`<ProvenanceTag>` renders one of **Real PayPal Sandbox** (ink outline, radio icon), **Simulated** (violet), **AI-generated** (marker-ink, sparkles), **User-provided** (neutral). Every money-shaped record shows one.

## 4. Spacing, radii, depth

- Spacing follows Tailwind's 4px grid. Sections are separated by 48px (`gap-y-12`); rows by 10–12px with a hairline.
- Radii: `--pf-radius-sm 3px` (tags, focus), `--pf-radius 5px` (buttons, nodes), `--pf-radius-lg 8px` (popovers only). No pill-shaped cards.
- Depth: one shadow token, `--pf-shadow-pop`, for floating layers (menus, dialogs). Pages, sections, rows and nodes are flat; structure comes from hairlines and whitespace, not cards.

## 5. Components

| Component | Rule |
|---|---|
| `Button` | `primary` = marker fill + ink text (one per view); `secondary` = hairline outline; `quiet` = text; `danger` = outline in red. Press = 1px translate. |
| `Field` | Underline input; on focus a 3px marker stroke draws left→right under it. Labels are `.pf-label`. |
| `Section` | Uppercase label + hairline. Replaces cards. |
| `Status`, `ProvenanceTag`, `SetupRequired` | See §3. |
| `CopyId` | Mono id with copy affordance; confirms with a check for 1.2s. |
| Sidebar | Flat white column, right hairline. Active item: ink text + 3px marker bar on the left edge. Sections not yet built show their phase (`P3`) and are not links. |
| Tables | No zebra, no boxed cells; hairline rows, `.pf-label` headers, ids in mono. |
| Audit timeline | Time (mono) · dot on a vertical hairline · plain-language heading + summary; `<details>` reveals record #, actor, hash, previous hash, PayPal ref, payload. Dot: ink = PayPal, marker = AI, hollow ink = human, grey = system. |

## 6. Workflow nodes (Phase 3+ contract)

- White, 1px `--pf-line-strong` border, 5px radius, ink text; first line `.pf-label` with a small 16px icon, second line 13px detail, optional 12px mono metadata.
- Selected: 2px ink border + marker-wash halo.
- Edges: 1.5px `--pf-line-strong`. During execution the travelled path is re-stroked in `--pf-marker` at 3px, animating `stroke-dashoffset` along the edge (the marker moving through the flow). Untaken branches stay grey.
- Node state badge: success/waiting/blocked per §3, AI nodes show the sparkles icon in marker-ink.
- Canvas: `--pf-canvas` with a 1px dot grid at 20px in `--pf-line`.

## 7. Motion

| Token | Value | Use |
|---|---|---|
| `--pf-dur-fast` | 150ms | Hover, press, colour changes |
| `--pf-dur` | 220ms | Reveal, expand, focus stroke |
| `--pf-dur-slow` | 350ms | Marker draw, approval transitions |
| `--pf-ease` | `cubic-bezier(.2,.7,.2,1)` | Everything |

Motion communicates state: an event arriving, a node executing, a path being travelled, a capability expiring. No bounce, no idle floating, no looping decoration except the live dot. Workflow generation may sequence longer (understand → compile → validate → render, nodes appearing in order). `prefers-reduced-motion: reduce` collapses all animation and transition to ~1ms.

## 8. Accessibility

- Text contrast ≥4.5:1 (body) — ink, ink-2 and muted all pass on canvas and surface; faint is never used for essential information.
- Non-text contrast ≥3:1 for input boundaries and focus indicators (`--pf-field`, 2px ink focus ring).
- One focus style everywhere: 2px ink outline, 2px offset, marker-wash halo.
- State is icon + label + colour, never colour alone; the marker never carries meaning by itself.
- Keyboard: all interactive elements are native buttons/links/inputs/`<details>`; disabled nav items carry `aria-disabled` and a title.
- Light theme only by design (`color-scheme: light`): the identity is a white canvas. A dark theme is out of scope for the hackathon.

## 9. Responsiveness

Primary target 1920×1080 and 1440×900. Sidebar collapses to a horizontal, scrollable nav under 768px; content stacks to one column under 1024px. Verified: no horizontal page scroll at 375px. The node editor (Phase 3) must remain usable on tablet and degrade to a read-only vertical list on phones.
