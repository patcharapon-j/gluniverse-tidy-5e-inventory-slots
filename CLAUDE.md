# GLUniverse Tidy 5e Inventory Slots — Developer Guide

## Overview

This module integrates Giffyglyph's Darker Dungeons Active Inventory system into the Tidy 5e Sheet for FoundryVTT v13. It replaces weight-based encumbrance with a slot/bulk system.

Source rules: https://www.giffyglyph.com/darkerdungeons/grimoire/4.0.0/en/active_inventory.html

## Critical Architecture Notes

### FoundryVTT v13 — Application V2

Foundry v13 uses **ApplicationV2** (`foundry.applications.sheets.ActorSheetV2`), NOT the legacy AppV1. This has major implications:

- **`ui.windows` is empty** — V2 apps are NOT stored in `ui.windows`. Use `foundry.applications.instances` (a Map) instead.
- **Render hooks are different** — The traditional `renderActorSheet` Hooks do NOT fire for V2 sheets. V2 uses event emitters (`app.addEventListener('render', ...)`) and the `renderApplication` Hook.
- **`sheet.element` is the raw DOM element** — not wrapped in jQuery. It's a `<form>` tag.

### Tidy 5e Sheet — Quadrone Layout (v12.5.5)

Tidy 5e has TWO layouts:
- **Classic** (AppV1) — uses `tidy5e-sheet.renderActorSheet` hook, jQuery-wrapped elements
- **Quadrone** (AppV2 + Svelte 5) — the NEW default sheet. Uses `SvelteApplicationMixin(ActorSheetV2)`.

**Quadrone does NOT fire `tidy5e-sheet.renderActorSheet`.** The hook definition exists but is never called from Quadrone code. The Quadrone sheet renders entirely via Svelte components.

### How to Detect and Inject into Quadrone Sheets

1. **MutationObserver on `document.body`** — watch for DOM changes inside `.tidy5e-sheet` elements. This catches Svelte re-renders.
2. **`renderApplication` Hook** — fires for AppV2 apps. Filter by `app.constructor.name.includes('Tidy5e')`.
3. **Delayed scan** — on module load, scan `foundry.applications.instances` for already-open sheets.

### Quadrone DOM Structure (Character Sheet)

The sheet element is:
```
<form class="application sheet tidy5e-sheet actor character quadrone themed theme-dark sheet-mode-play">
  <header class="window-header theme-dark">...</header>
  <div class="controls-dropdown">...</div>
  <div class="window-content">
    <!-- Svelte-rendered content -->
    <!-- Tabs, sidebar, inventory, etc. -->
  </div>
  <div class="window-resize-handle">...</div>
</form>
```

#### Key Selectors (Quadrone)

| What | Selector |
|------|----------|
| Sheet root | `.tidy5e-sheet.quadrone` |
| Tab content areas | `.tab-content` (8 of them for different tabs) |
| Encumbrance bar | `.encumbrance` (class: `meter progress encumbrance theme-dark`) |
| Item table | `[data-tidy-sheet-part="item-table"]` |
| Item table header | `[data-tidy-sheet-part="table-header-row"]` |
| Item table row | `[data-tidy-sheet-part="item-table-row"]` |
| Item ID | `[data-item-id]` on the **parent** `div.item-table-row-container` |
| Item name cell | `[data-tidy-sheet-part="item-name"]` |
| Table cell | `[data-tidy-sheet-part="table-cell"]` |

**Important**: `data-item-id` is on the row **container**, NOT on `[data-tidy-sheet-part="item-table-row"]` itself. Use `row.closest('[data-item-id]')`.

#### Quadrone Inventory Tab Structure

```
InventoryActionBar (search/filters)
<div class="tab-content">
  SheetPins (conditional)
  CharacterEncumbranceRow (.encumbrance)
  InventoryTables (item sections with CSS Grid)
</div>
ActorInventoryFooter
```

The inventory table uses **CSS Grid** with columns defined via `--grid-template-columns` custom property. **Do NOT try to inject additional grid columns** — it will break the layout. Instead, annotate existing cells (e.g., append badges to item name cells).

#### Encumbrance Bar (Quadrone)

The Quadrone encumbrance bar uses these CSS custom properties:
- `--bar-percentage` — controls the fill width
- `--encumbrance-low` — breakpoint percentage for light load
- `--encumbrance-high` — breakpoint percentage for heavy load

Override these properties to change the bar visually.

The bar contains:
- `.label .value` — current weight/slot value
- `.label .max` — max weight/slot value
- `.label i` — icon (default: `fa-weight-hanging`)

### Tidy 5e API

Available via `game.modules.get('tidy5e-sheet').api` after `Hooks.once('tidy5e-sheet.ready', (api) => { ... })`.

**Content registration** (`registerCharacterContent`, `registerNpcContent`, `registerItemContent`) requires wrapping in `api.models.HtmlContent` — plain objects will silently fail. However, for Quadrone sheets, this system requires static HTML strings and is less reliable than DOM injection via render hooks.

**Recommended approach**: Use MutationObserver + render hooks for DOM injection rather than the Tidy5e content registration API.

### Flag Scope

The flag scope for `actor.getFlag()` / `item.setFlag()` **must match the module ID exactly**: `gluniverse-tidy-5e-inventory-slots`. Using any other scope will throw "Flag scope is not valid or not currently active".

### Context Menu Hook

The item context menu hook is `dnd5e.getItemContextOptions` — NOT `tidy5e-sheet.getItemContextOptions`. Both Classic and Quadrone layouts fire the dnd5e hook. Signature: `(item, menuItems) => {}`.

### D&D 5e System (v5.2.5)

- Item weight: `item.system.weight.value` (may also be just `item.system.weight` as a number)
- Item quantity: `item.system.quantity`
- Container items: `item.type === 'container'` or `item.type === 'backpack'`
- Items inside containers: `item.system.container` contains the parent container's ID
- Actor size: `actor.system.traits.size` — values: `tiny`, `sm`, `med`, `lg`, `huge`, `grg`
- STR modifier: `actor.system.abilities.str.mod`
- CON modifier: `actor.system.abilities.con.mod`
- Armor type: `item.system.type.value` — values: `light`, `medium`, `heavy`, `shield`

### Gluniverse Module Conventions

- Module ID: kebab-case (`gluniverse-*`)
- Entry point: `scripts/module.js`
- Settings: `scripts/settings.js` with exported `MODULE_ID`, `registerSettings()`, `getSetting()`, `setSetting()`
- Hooks: `Hooks.once('init', ...)` for settings, `Hooks.on('ready', ...)` for runtime
- Logging: `console.log(\`${MODULE_ID} | message\`)`
- API exposure: `globalThis.GLUniverse*` and `game.modules.get(MODULE_ID).api`

## File Structure

```
gluniverse-tidy-5e-inventory-slots/
├── module.json              # Manifest (dnd5e + tidy5e-sheet deps)
├── CLAUDE.md                # This file
├── scripts/
│   ├── module.js            # Entry point, hooks, API
│   ├── settings.js          # 13 module settings, constants, tables
│   ├── SlotCalculator.js    # Core math engine (slots, bulk, encumbrance)
│   └── TidyIntegration.js   # DOM injection, render hooks, MutationObserver
├── styles/
│   └── inventory-slots.css  # All styles (dark/quadrone/classic support)
└── languages/
    └── en.json              # English localization
```
