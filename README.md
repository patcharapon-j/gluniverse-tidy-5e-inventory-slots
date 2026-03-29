# GLUniverse - Tidy 5e Inventory Slots

Integrates [Giffyglyph's Darker Dungeons Active Inventory](https://www.giffyglyph.com/darkerdungeons/grimoire/4.0.0/en/active_inventory.html) system into the [Tidy 5e Sheet](https://github.com/kgar/foundry-vtt-tidy-5e-sheets) for FoundryVTT v13. Replaces weight-based encumbrance with a slot/bulk system.

## Features

- **Slot-Based Inventory** — Items occupy slots based on bulk category (Tiny through XX-Large), not raw weight. Slot capacity scales with creature size and STR modifier.
- **Auto Bulk Assignment** — Automatically calculates bulk from item weight, or set it manually per item via context menu.
- **Object Scaling** — Items sized for larger/smaller creatures shift bulk categories accordingly.
- **Quickdraw Slots** — Designate readily-accessible item slots (default 3) for fast access.
- **Pack Endurance** — CON modifier grants bonus inventory slots for hardy characters.
- **Container Support** — Bags and containers provide internal slot capacity; items inside use container slots instead of character slots.
- **Armor Slot Cost** — Worn armor consumes slots based on armor type and creature size.
- **Basic Supplies** — Configurable slot cost for adventuring basics (rations, torches, etc.).
- **Encumbrance Effects** — Three tiers (Encumbered, Heavily Encumbered, Over-Encumbered) with visual indicators on the encumbrance bar.
- **Wear & Tear** — Items gain notches on critical failures; accumulate enough and they break. Includes temper grades (Pure, Royal, Astral) to reduce degradation.
- **Ammunition Dice** — Replace individual ammo tracking with usage dice that deplete over time.
- **Dice Pool** — Consolidate multiple ammunition dice into a single pool roll.

## Installation

### Manifest URL (Recommended)

Paste into Foundry VTT's **Install Module** dialog:

```
https://github.com/patcharapon-j/gluniverse-tidy-5e-inventory-slots/releases/latest/download/module.json
```

### Manual Installation

1. Download `module.zip` from the [Releases](https://github.com/patcharapon-j/gluniverse-tidy-5e-inventory-slots/releases) page
2. Extract to your `Data/modules/` folder
3. Enable the module in your world

## Compatibility

- **Foundry VTT**: v13+
- **D&D 5e System**: v5.2.0+ (verified 5.2.5)
- **Tidy 5e Sheet**: v12.0.0+ (required)
- **Layout**: Quadrone (AppV2) and Classic (AppV1)

## Usage

1. Enable the module in your world
2. Configure features in **Module Settings** — each subsystem can be toggled independently
3. Right-click items in the inventory to set bulk category, quickdraw status, notches, and temper grade
4. The encumbrance bar automatically updates to show slots used / total slots

## Credits

Created by GLUniverse. Rules adapted from Giffyglyph's Darker Dungeons.

## License

MIT
