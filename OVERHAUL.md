# GLUniverse Active Inventory — Overhaul Plan & Codebase Sweep

> Status: in progress. This document records the comprehensive sweep, the
> agreed direction, and the staged plan for the v3.0 overhaul.

## Agreed Direction

| Decision | Choice |
|----------|--------|
| Integration | **Inline / native** via the Tidy 5e Sheet API (retire floating `document.body` panels + RAF loop) |
| Theme | **Always** the clocks-and-tracker dark glassy HUD, regardless of host sheet theme |
| Font | **Bundle Oxanium locally** (variable woff2, offline-safe) |
| Scope | **All four systems** — slots, wear & tear, ammo dice, dice pool |

Design language inherited from `gluniverse-clocks-and-tracker/styles/hud.css`:
Oxanium variable font · frosted glass (`blur(16px) saturate(1.15)`) · layered
depth shadows with inner highlights · periwinkle tint `#6b86d6`, danger `#e0584f`,
good `#67d39b`, gold quickdraw · springy `cubic-bezier(.34,1.56,.5,1)` motion.

---

## A. Critical Bugs (must fix)

| # | Severity | Location | Issue |
|---|----------|----------|-------|
| 1 | Critical | `TidyIntegration.js:384` | RAF position loop is **never cancelled** — runs forever, `getBoundingClientRect()` 60×/s indefinitely. |
| 2 | Critical | `TidyIntegration.js:~1341` (`_bindAllTabEvents`) | Event listeners re-bound on every `_refreshItemTab()` with **no cleanup** → handlers stack (a "+1 notch" click fires N times after N edits). |
| 3 | High | `TidyIntegration.js:87` | MutationObserver on entire `document.body` is **never disconnected**; fires on every unrelated DOM mutation. |
| 4 | High | `TidyIntegration.js` (many `innerHTML` sites) | Item names interpolated into `innerHTML` unescaped → **stored XSS** via crafted item names. |
| 5 | Medium | `TidyIntegration.js` handlers | `await item.setFlag(...)` with no try/catch → silent state divergence on failure. |
| 6 | Medium | `module.js:367` (`_refreshActorSheet`) | `setInterval` polling 5× per change per actor to re-inject; races the RAF loop and Svelte. |
| 7 | Low | `NotchCalculator.js:~308` | `degradeDamageData` assumes `denomination` exists after a shallow guard. |

## B. Performance

- Replace the **per-frame RAF reposition** with inline rendering (no positioning math needed once content lives inside the sheet).
- Cache `SlotCalculator.calculateInventory(actor)` (currently O(items) on every panel update) — memoize per actor, invalidate on `updateItem`/`deleteItem`/`createItem`.
- Stop calling `getComputedStyle(sheetEl)` on every update (reading 9 `--t5e-*` vars) — unnecessary once we own a self-contained dark theme.
- Scope the MutationObserver to the sheet content node, not `document.body`; debounce already present (200ms) but the target is far too broad.
- Replace full `panel.innerHTML =` rebuilds with targeted, section-level updates.

## C. Architecture Overhaul (v3.0)

1. **Rendering layer rewrite** — `TidyIntegration.js` becomes a thin controller that
   registers content/tabs through the Tidy 5e API and reconciles inline nodes on
   `tidy5e-sheet.renderActorSheet` / `renderItemSheet` (+ AppV2 hooks), keyed and
   idempotent so re-renders don't duplicate.
2. **Event delegation** — one delegated listener per injected root, dispatching on
   `data-glinv-action` attributes. No per-render re-binding; no leaks.
3. **Lifecycle** — track injected roots in a `WeakMap` keyed by sheet element; tear
   down observers and cancel any timers on sheet close.
4. **Keep the calculators** — `SlotCalculator`, `NotchCalculator`, `AmmoDiceCalculator`,
   `DicePoolCalculator` are sound domain logic; preserve them, fix the noted bugs, add
   a memoization cache.
5. **Self-contained dark theme** — `.glinv-scope` wrapper + design-system tokens;
   no dependence on host `--t5e-*` variables.

## D. New Features (proposed)

- **Encumbrance bar takeover** done natively: a slot-reel style fill that ticks up
  box-by-box with the springy pop, plus over-capacity "dread" glow.
- **Drag-to-reorder quickdraw belt**: a dedicated quickdraw tray rendered from the
  gold-flagged items.
- **Repair / replenish quick-actions** surfaced as tactile chips on item rows
  (notch repair, ammo replenish) with cost tooltips.
- **Header readout chip** in the sheet title bar: `used / max` slots with state color,
  mirroring the clocks-and-tracker compact dual-ring readout.
- **Animated state transitions**: floating `+1 / −1` indicators on slot and notch
  changes; die step-down tumble on ammo use; pool die roll/discard animation.
- **Per-actor settings** reachable from the panel (already partially present) restyled
  into a DialogV2 with the HUD look.

## E. Delivery Stages

1. ✅ Design-system foundation (`styles/glinv-design-system.css`) + bundled Oxanium (variable woff2).
2. ✅ Rendering-layer rewrite — `TidyIntegration` now registers inline content via the
   Tidy v13 API (`registerCharacterContent` / `registerNpcContent` / `registerItemContent`,
   `renderScheme: 'handlebars'`). **Removed:** floating `document.body` panels, the RAF
   position loop, the `setInterval` re-injection polling (module.js), and the body-wide
   MutationObserver. Event handlers now bind to fresh nodes each render (leak-free); the
   per-edit `_refreshItemTab` is a reactive no-op.
3. ✅ Slots/wear/ammo/pool reskinned via `styles/glinv-components.css` (dark HUD, springy
   motion). Item names escaped (`_esc`) — closes the stored-XSS hole.
4. ✅ All four systems share the redesigned component skin.
5. ⏳ Calculator memoization (deferred — not required for correctness; calculators verified sound).
6. ✅ New features:
   - **Header readout chip** — used/max slots badge in the title bar (injected at the
     documented `NAME_CONTAINER` anchor), state-colored, with `dread` glow when overburdened.
   - **Native item-row quick-actions** via `api.config.itemSummary.registerCommands`
     (roll ammo, replenish, roll/refill pool, add notch, repair, toggle quickdraw) —
     feature-detected; skipped gracefully on older Tidy builds.
   - **±N float indicator** animating on slot-count change between renders.
   - **Quickdraw belt** — gold chip tray of quickdraw items in the panel.
     (Drag-to-reorder still deferred: needs Foundry drag/drop verified in-app.)
7. ✅ Docs (CLAUDE.md API correction, file tree), `module.json` (styles + fonts + v3.0.0 + Tidy 13 dep).

## F. In-App Verification Checklist (must run inside FoundryVTT)

This overhaul was built against the documented Tidy v13.4.3 API; it could not be
executed inside Foundry from the build environment. Confirm:

- [ ] Slot panel appears under the encumbrance bar on the inventory tab (character + NPC).
      If not, adjust `TidyIntegration.ACTOR_ANCHOR` (single constant) to a selector that
      exists on the open inventory tab.
- [ ] Panel + row badges survive sheet re-renders, tab switches, and item add/remove
      (no duplicates, no disappearance).
- [ ] Item config is a dedicated **"Active Inventory" tab** on physical item sheets;
      +/− notch, ammo roll/replenish, pool roll/refill update reactively without stacking.
- [ ] Slot count rolls slot-machine style with a green ▼ / red ▲ trend on change; the
      panel does NOT visibly re-render when nothing changed.
- [ ] Oxanium loads offline (disable network, hard-reload) — text renders in Oxanium.
- [ ] GM settings dialog (cog button) opens, styled, and saves size/slot overrides.
- [ ] `prefers-reduced-motion` disables animations.
- [ ] Header chip shows used/max next to the actor name. If it lands in the wrong spot,
      `NAME_CONTAINER` resolved unexpectedly — adjust the header `injectParams.selector`.
- [ ] Expanding an inventory row shows quick-action buttons (roll ammo / pool / notch /
      repair / quickdraw) only when relevant; clicking them works and updates reactively.
- [ ] Quickdraw belt lists gold chips for quickdraw items; ±N float animates on slot change.
