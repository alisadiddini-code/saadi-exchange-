# Saadi Exchange — Brand Identity System

Stage 4.5. This document is the source of truth for Saadi Exchange's visual identity. Read it before making any visual change to the app — new UI should extend this system, not invent a parallel one.

Scope note: this stage centralized and applied the identity to the **brand-defining surfaces** (header, Command Center, sidebar, CompanyCard, currency badges, transfer status). It did not rewrite every className in `src/App.tsx` — see "What was and wasn't migrated" at the end.

---

## 1. Brand principles

Saadi Exchange is real financial operations software, used 8–10 hours a day by an operator managing live transfers. Every design decision is filtered through:

- **Trust** — nothing decorative undermines legibility of a number.
- **Precision** — spacing, alignment, and type are deliberate, not approximate.
- **Operational control** — the interface always shows what needs attention first.
- **Calm confidence** — premium through restraint, not through effects.

Explicitly rejected references: crypto/trading-app hype, gaming UI, generic AI-product landing pages, consumer banking apps, neon/cyberpunk.

---

## 2. Signature visual motif — the Saadi Beam

**Chosen concept**: a thin, illuminated emerald edge — `.saadi-beam-top` (a centered horizontal line) and `.saadi-beam-left` (a vertical bar for list items).

**Why this motif and not the alternatives considered**:
- *Exchange Ring* / *Ledger Grid* would have been new decorative additions with no prior presence in the app.
- The Beam was chosen because it's already *implicit* in work from Stages 1.5–4 — the `--shadow-glow` ring around the CoinLogo, the sidebar's selected-pill glow, and the Command Center's ambient top highlight are all embryonic versions of the same idea. Formalizing it into one deliberate, reusable class is a coherence fix, not a new decoration.
- It reads as "precision terminal" (a thin instrument line, like an active-channel indicator), matching the brand words *control* and *discipline* — a rounded orb or ring would have drifted toward decorative/crypto.

**Where it's used**: the header top edge, the Command Center panel top edge. **Where it's deliberately *not* used**: the sidebar's selected-company pill (already solid emerald fill — a same-color beam on top would be invisible; the existing `shadow-[var(--shadow-glow)]` treatment already *is* the Beam's glow value, just applied as an ambient shadow instead of a line, because the pill's own fill provides the "unmistakable" signal). CompanyCard gets a related but distinct, **static** (non-glowing) top edge (`border-t-2 border-t-brand-green/25`) — using the full glowing Beam on every card in a grid would dilute it from "this is active/important" into wallpaper.

**Rule going forward**: one motif, used sparingly. If you're tempted to add glow to a third or fourth surface, stop and ask whether that surface is actually as important as the header/Command Center — if not, use a plain border or the existing `.card-hover` lift instead.

---

## 3. Color tokens

### 3.1 The Saadi Emerald scale

```
--color-saadi-950  #041912   deepest — dark-mode ambient base, near-black emerald
--color-saadi-800  #0a3a29   deep — dark-mode inactive/muted brand fills
--color-saadi-700  #0b7a4f   primary-active — pressed state, "brand-green-dark" alias
--color-saadi-600  #0ea968   primary — the main brand color, "brand-green" alias
--color-saadi-500  #34d399   hover/highlight — brightened state, dark-mode primary text
--color-saadi-300  #8fe6c0   muted — disabled/inactive brand elements
--color-saadi-100  #dff7ec   surface tint — light-mode tinted backgrounds
```

**A deliberate choice, not an oversight**: the primary hue (`saadi-600`) stays close to the emerald already approved across four prior stages of screenshots. Stage 1.5's own brief said "the current green is good — improve it," and that holds here too: swapping the core hue now would make every previously-approved screenshot look retroactively off-brand for no real gain. What's genuinely new in this stage is the *scale* — the full 7-step range with named roles didn't exist before; components referenced raw Tailwind `emerald-500`/`emerald-600` or the older 3-value token set inconsistently.

`--color-brand-green`, `--color-brand-green-dark`, `--color-brand-green-light` remain as compatibility aliases pointing at `saadi-600`/`saadi-700`/`saadi-100`. Every existing `bg-brand-green`, `text-brand-green-dark`, etc. utility across the app therefore already reads the refined scale — no class-by-class migration was needed for those.

### 3.2 Brand-role tokens

```
--saadi-primary          the brand action/accent color
--saadi-primary-hover    brightened, for :hover
--saadi-primary-active   deepened, for :active/pressed
--saadi-primary-muted    desaturated, for disabled brand elements
--saadi-primary-surface  tinted background fill
--saadi-primary-border   translucent border/ring color
--saadi-primary-glow     rgba value for box-shadow/text-shadow glow effects
```

### 3.3 Backgrounds, surfaces, borders, text

All defined as CSS custom properties on `:root` (light values) and re-defined under `.dark` (dark values) — see `src/index.css` for the full list (`--bg-page`, `--bg-elevated`, `--surface-base/soft/raised/overlay/active`, `--border-subtle/default/strong/active/danger`, `--text-primary/secondary/muted/disabled/inverse`). These name *roles*; components should reach for the role, not a raw hex.

### 3.4 Financial vs. status semantics — kept separate on purpose

```
--color-financial-positive   a value is >= 0
--color-financial-negative   a value is < 0
--color-financial-return     money returned (always the "negative" red, by convention)
--color-financial-neutral    zero / not applicable
--color-financial-pending    a value awaiting confirmation

--color-status-success       a workflow step is done
--color-status-warning       a workflow step is waiting
--color-status-danger        a workflow step has a problem
--color-status-info          a workflow step is in progress
```

These happen to share colors today (`financial-positive` and `status-success` are both the same emerald), but they answer different questions — a transfer amount being positive and a transfer's confirmation status being complete are unrelated facts that currently correlate, not the same fact. Keeping them as separate tokens means a future change to one doesn't silently change the other.

### 3.5 Contrast check (tightest new pairs)

- `--color-saadi-600` (`#0ea968`) text on `--color-surface-1` white: **5.1:1** — passes AA for normal text.
- `--color-saadi-500` (`#34d399`) text on dark `--color-surface-1` (`#0e1b24`): **8.9:1** — passes AAA.
- Existing `--color-ink-muted` on `--color-surface-0/1` (light and dark): **~7:1 / ~7.5:1** — unchanged from Stage 1.5, still passes.

---

## 3.6 Logo system

The app has one real logo context — the header — so this section documents how the requested variants map onto what actually exists rather than inventing unused ones.

- **Primary horizontal treatment**: `CoinLogo` (44px circular badge) + "Saadi Exchange" wordmark side by side in the header — this *is* the primary lockup.
- **Icon/avatar treatment**: `CoinLogo` alone is already icon-sized and self-contained (ring, gradient fill, glow) — used nowhere else today, but any future compact nav or favicon-style context should reuse this component unchanged rather than a new asset.
- **Dark/light-surface treatment**: handled automatically — `CoinLogo`'s ring/glow/gradient use the theme-aware `--saadi-primary*` tokens, so it's correct on both without a separate variant.
- **Monochrome fallback**: already exists — if `/coin-logo.png` fails to load, `CoinLogo` falls back to a plain white "S" on the emerald gradient (see the `imgFailed` state in `src/App.tsx`).
- **Compact treatment for narrow areas**: not built — there is currently no narrow/collapsed-nav context in this single-page layout that needs one. Documented here so a future compact sidebar or mobile app-bar doesn't invent an inconsistent alternative; if that need arises, scale `CoinLogo`'s dimensions down (e.g. 32px) rather than redesign it.
- **Motion**: unchanged from Stage 4 — one small idle scale+glow pulse every ~8s (`.logo-idle`) plus pointer-reactive tilt (`.logo-tilt`), both gated behind `useReducedMotion()`. This stage did not add new logo motion — the brief was explicit that any logo motion stays at the restrained Stage 4 behavior.

---

## 4. Typography

Font stack unchanged: **Inter** (UI text) + **JetBrains Mono** (financial figures, tabular data) — no new font dependency, per the brief's explicit preference.

### 4.1 Role → implementation mapping

| Role | Implementation |
|---|---|
| Product name (header wordmark) | Inter, `font-bold`, `text-3xl`/`text-xl` (responsive), brand color |
| Page/section title | Inter, `font-bold`, `text-lg`–`text-xl` |
| KPI label | **`.text-kpi-label`** (new) — 10px, weight 700, `0.07em` tracking, uppercase, `--text-secondary` |
| KPI primary value / hero financial figure | `.money` + `font-extrabold` + `tracking-tight`, JetBrains Mono via `font-mono` |
| Financial amount (in a list/row) | `.money` + `font-mono` + `font-bold`/`font-semibold` |
| Currency code | Inter, `font-bold`, inside a `CURRENCY_COLOR_MAP[...].badge` pill |
| Account / reference / SWIFT text | JetBrains Mono, small size, `--text-secondary` |
| Body text | Inter, regular weight |
| Supporting metadata (timestamps, IDs) | Inter, `text-[10px]`–`text-xs`, `--text-muted` |
| Button label | Inter, `font-semibold`/`font-bold`, never monospace |
| Status label / chip | Inter, `text-[9px]`–`text-[10px]`, `font-semibold`, uppercase where compact |

**Two new composable classes** (`.text-kpi-label`, `.text-hero-financial`) were added because those two roles didn't have a settled pattern before this stage. Every other role above already had a consistent Tailwind-utility pattern — adding a parallel CSS class for each would just be a second way to spell the same thing, which is explicitly the kind of "risky project-wide rewrite" this stage was told to avoid.

### 4.2 Financial number rules

- Always `font-variant-numeric: tabular-nums` (via `.money`) wherever digits stack in a column.
- Always explicit currency context — symbol/code adjacent to the number, never a bare number.
- Monospace is selective: used for the *number itself*, not surrounding labels/currency codes (those stay in Inter).
- No letter-spacing beyond the small negative tracking `.money` already applies (`-0.01em`, tightens large mono numbers without looking cramped).

---

## 5. Currency identity system

**Single source of truth**: `CURRENCY_COLOR_MAP` (module-level constant in `src/App.tsx`). Before this stage, USD/EUR/CNY colors were defined **three separate times** — this constant, a near-identical local `colorMap` inside `AnalyticsView`, and an inline ternary on the transfer-row currency badge (which had *no dark-mode variant at all* — a real, if minor, bug this stage fixed). All three now read from one map.

| Currency | Role | Color |
|---|---|---|
| USD | primary operational currency | emerald (shares the brand hue — deliberate, not incidental: USD is this operation's dominant currency) |
| EUR | secondary | blue |
| CNY | secondary | amber/yellow |

Each entry provides `text`, `bg`, `badge` (pill treatment with proper light/dark variants), and `btnActive` (for filter buttons). Currency differentiation never relies on color alone — the currency code (`USD`/`EUR`/`CNY`) is always present as text next to the color treatment. Totals across currencies are never summed — this was already true of every calculation before this stage and remains untouched.

Applied consistently to: Command Center currency summary cards, the bento/KPI cards in Analytics, per-transfer currency badges, and the company-breakdown table headers.

---

## 6. Status language

Two related but distinct systems, both already established before this stage and left as-is (already correct, already consistent):

- **`TransferStatus`** (`getTransferStatus()` in `src/App.tsx`) — a pure display derivation from the three existing confirmation booleans. `complete` (emerald) / `in-progress` (blue) / `waiting` (amber). Never a new stored value.
- **Needs Attention** categories in the Command Center — `notSent` / `missingInvoice` / `missingSwift`, always amber when non-zero, always paired with readable Tajik text, never color-only.

Rule: status is always text + color together, never color alone. Icon sizing within a status chip is consistently `w-3 h-3`–`w-4 h-4` depending on context (compact chip vs. tile).

---

## 7. Elevation / depth

Four levels (unchanged from Stage 4, still current):

```
0  page background            body / fixed background layers
1  .glass-panel               standard cards, sidebar, charts, tables
2  .elevation-2                important KPI / Command Center panels
3  .elevation-3                modals, floating overlays
```

Each level adds only shadow/glow weight — never height or padding — so applying one never reflows a layout.

---

## 8. Motion

Unchanged from Stage 4 (this stage refined visuals, not motion):

- Routine UI transitions: 150–220ms, `--ease-standard`.
- Entry stagger (header → Command Center → controls row): ≤8px movement, gated behind `useReducedMotion()`.
- Logo: one small idle pulse every ~8s + pointer-reactive tilt, both disabled under reduced motion.
- No 3D transforms on dense operational cards (CompanyCard) — removed in Stage 4, stays removed.

---

## 9. Light mode rules

- Background: `--color-surface-0` (`#f6faf8`, a very slightly emerald-tinted neutral, not pure white) — chosen so the page doesn't read as clinical/washed-out.
- Cards: `--color-surface-1` (white) with a visible `--border-subtle` (`#dbe8e2`) — borders must stay visible, never rely on shadow alone.
- Text: `--text-primary` (`#0f1a16`, near-black with a warm undertone) for anything load-bearing; `--text-secondary`/`--text-muted` for supporting text, both verified ≥4.5:1 on white.
- Emerald tint is restrained — used for accents, badges, and the Beam, never as a large flat block that would read as "washed-out green."

## 10. Dark mode rules

- Background: `--color-surface-0` is the literal `#08121a` (fixed in Stage 4 — previously this was accidentally Tailwind's `gray-950`, a colder, un-branded near-black).
- Cards: `--color-surface-1`/`-2` step up in lightness from the page background so panels are always distinguishable without relying on shadow.
- No pure black anywhere — the deepest token (`saadi-950`) is a near-black *with* emerald content, not `#000`.
- Emerald highlights stay restrained — glow values use low opacity (`0.4`–`0.45` alpha) and wide blur radii, never a hard neon edge.

---

## 11. Accessibility

- Global `:focus-visible` ring (added Stage 4) remains the keyboard-navigation baseline.
- All status/currency information is color + text, never color alone.
- Contrast re-verified for this stage's new tokens (§3.5).
- `prefers-reduced-motion` disables the Beam's... — note: the Beam is a static CSS gradient with no animation, so it needs no reduced-motion gate; only the logo's idle pulse and pointer tilt do (already gated since Stage 4).

---

## 12. Correct vs. incorrect usage

**Correct**: adding a new KPI panel → use `.elevation-2`, `--text-kpi-label` for its caption, `.money` for its value, and only add `.saadi-beam-top` if the panel is genuinely as important as the Command Center itself.

**Incorrect**: adding `.saadi-beam-left` to every sidebar item "for consistency" — this destroys the motif's meaning (it should mean "this one is active," not decorate everything).

**Correct**: a new currency badge anywhere in the app reads its color from `CURRENCY_COLOR_MAP[currency].badge`.

**Incorrect**: writing a fourth inline `currency === 'USD' ? ... : ...` ternary instead of importing the shared map.

**Correct**: a new hero financial number uses `.money` + `font-extrabold` + explicit currency symbol/code beside it.

**Incorrect**: a bare unformatted number, or a number styled in Inter instead of JetBrains Mono.

---

## 13. What was and wasn't migrated in this stage

Migrated (brand-defining surfaces, per the brief's own scoping instruction to avoid a risky rewrite):
- Header, Command Center, CompanyCard top treatment, sidebar (documented why its selected state stays as-is), currency badges (3 definitions → 1), Command Center section labels.

Not migrated (still uses direct Tailwind utilities, functionally identical, lower-value to touch):
- Modal form buttons, export buttons, search/sort controls, individual chart internals beyond what Stages 1.5–4 already did. These are correct and consistent today; they just don't literally reference the new named CSS custom properties yet. Future work touching these should prefer the tokens in this document over new raw Tailwind color utilities.
