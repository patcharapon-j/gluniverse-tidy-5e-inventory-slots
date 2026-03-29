export const MODULE_ID = 'gluniverse-tidy-5e-inventory-slots';
export const FLAG_SCOPE = 'gluniverse-tidy-5e-inventory-slots';

// Bulk size categories
export const BULK_CATEGORIES = {
    TINY: { value: 0.2, label: 'GLINVSLOTS.bulk.tiny', maxWeight: 0, maxSize: 'Palm-sized or smaller' },
    SMALL: { value: 1, label: 'GLINVSLOTS.bulk.small', maxWeight: 2, maxSize: 'Up to 9 inches' },
    MEDIUM: { value: 2, label: 'GLINVSLOTS.bulk.medium', maxWeight: 5, maxSize: 'Up to 2 feet' },
    LARGE: { value: 3, label: 'GLINVSLOTS.bulk.large', maxWeight: 10, maxSize: 'Longer than arm' },
    XLARGE: { value: 6, label: 'GLINVSLOTS.bulk.xlarge', maxWeight: 35, maxSize: 'Longer than person' },
    XXLARGE: { value: 9, label: 'GLINVSLOTS.bulk.xxlarge', maxWeight: 70, maxSize: '2+ person heights' }
};

// Ordered array for scaling operations
export const BULK_ORDER = ['TINY', 'SMALL', 'MEDIUM', 'LARGE', 'XLARGE', 'XXLARGE'];

// Creature size -> inventory slot formula
export const CREATURE_SLOT_TABLE = {
    tiny:        { base: 6,  strMult: 1, minBulk: 5 },
    sm:          { base: 14, strMult: 1, minBulk: 10 },
    med:         { base: 18, strMult: 1, minBulk: 20 },
    lg:          { base: 22, strMult: 2, minBulk: 40 },
    huge:        { base: 30, strMult: 4, minBulk: 80 },
    grg:         { base: 46, strMult: 8, minBulk: 160 }
};

// Object scaling modifiers (category shifts)
export const OBJECT_SCALE_SHIFTS = {
    tiny: -2,
    sm: -1,
    med: 0,
    lg: 1,
    huge: 2,
    grg: 3
};

// Armor bulk by creature size
export const ARMOR_BULK_TABLE = {
    tiny: { light: 1, medium: 2, heavy: 3, shield: 1 },
    sm:   { light: 2, medium: 5, heavy: 7, shield: 1 },
    med:  { light: 3, medium: 6, heavy: 9, shield: 2 },
    lg:   { light: 4, medium: 7, heavy: 11, shield: 3 },
    huge: { light: 5, medium: 10, heavy: 15, shield: 4 },
    grg:  { light: 8, medium: 15, heavy: 23, shield: 5 }
};

// Vehicle spacing scale
export const VEHICLE_SLOTS = {
    cramped: 20,
    snug: 60,
    compact: 180,
    spacious: 540,
    capacious: 1620,
    vast: 4860
};

// ─── Wear & Tear Constants ──────────────────────────────────────────

// Temper grades — reduce notches gained from critical failures
export const TEMPER_GRADES = {
    none:   { notchMult: 1,     costMult: 1, timeDays: 0,  valueMult: 1,  rarity: 'Common' },
    pure:   { notchMult: 0.5,   costMult: 2, timeDays: 3,  valueMult: 3,  rarity: 'Uncommon' },
    royal:  { notchMult: 0.25,  costMult: 4, timeDays: 7,  valueMult: 6,  rarity: 'Rare' },
    astral: { notchMult: 0.125, costMult: 8, timeDays: 14, valueMult: 12, rarity: 'Mythic' }
};

// Fragility — max notches before item shatters
export const FRAGILITY = {
    delicate:       { maxNotches: 1,   label: 'GLINVSLOTS.notch.fragility.delicate' },
    sturdy:         { maxNotches: 10,  label: 'GLINVSLOTS.notch.fragility.sturdy' },
    indestructible: { maxNotches: 100, label: 'GLINVSLOTS.notch.fragility.indestructible' }
};

// Weapon die degradation chain (largest → smallest → flat 1)
export const DIE_CHAIN = ['d12', 'd10', 'd8', 'd6', 'd4'];

// Armor sacrifice dice (when choosing to sacrifice armor to reduce damage)
export const ARMOR_SACRIFICE_DICE = {
    light:  '3d4',
    medium: '3d8',
    heavy:  '3d12'
};

// Quality grades — derived from peak notch count ever reached
export const QUALITY_GRADES = [
    { key: 'pristine', minPeak: 0, resalePercent: 75 },
    { key: 'worn',     minPeak: 1, resalePercent: 50 },
    { key: 'wellWorn', minPeak: 2, resalePercent: 25 },
    { key: 'scarred',  minPeak: 4, resalePercent: 10 }
];

// Quality restoration costs (percentage of item value)
export const QUALITY_RESTORATION = {
    scarredToWellWorn: 0.10,
    wellWornToWorn:    0.30,
    wornToPristine:    0.50
};

// ─── Ammunition Dice Constants ─────────────────────────────────────────

// Ammo die degradation chain (denomination values, largest → smallest)
// d12 → d10 → d8 → d6 → d4 → 1 (last shot) → 0 (empty)
export const AMMO_DIE_CHAIN = [12, 10, 8, 6, 4];

// Replenishment cost per die step (percentage of ammo base cost)
export const AMMO_REPLENISH_COST = {
    20: 0.16,
    12: 0.20,
    10: 0.25,
    8:  0.33,
    6:  0.50,
    4:  1.00
};

// ─── Dice Pool Constants ──────────────────────────────────────────────

export const DICE_POOL_DEFAULTS = {
    defaultDieType: 6,          // d6
    defaultDiscardThreshold: 2, // discard on 1 or 2
    defaultPoolSize: 6          // 6 dice
};

// Available die types for dice pools
export const DICE_POOL_DIE_TYPES = [4, 6, 8, 10, 12, 20];

export function registerSettings() {
    // --- Core Settings (visible in config) ---

    game.settings.register(MODULE_ID, 'enableSlotSystem', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableSlotSystem.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableSlotSystem.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    });

    game.settings.register(MODULE_ID, 'enableForNPCs', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableForNPCs.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableForNPCs.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true,
        requiresReload: true
    });

    game.settings.register(MODULE_ID, 'enableQuickdraw', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableQuickdraw.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableQuickdraw.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'quickdrawSlots', {
        name: game.i18n.localize('GLINVSLOTS.settings.quickdrawSlots.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.quickdrawSlots.hint'),
        scope: 'world',
        config: true,
        type: Number,
        default: 3,
        range: { min: 1, max: 10, step: 1 }
    });

    game.settings.register(MODULE_ID, 'enablePackEndurance', {
        name: game.i18n.localize('GLINVSLOTS.settings.enablePackEndurance.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enablePackEndurance.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'enableObjectScaling', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableObjectScaling.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableObjectScaling.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'enableEncumbranceEffects', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableEncumbranceEffects.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableEncumbranceEffects.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'enableContainerRules', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableContainerRules.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableContainerRules.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'enableBasicSupplies', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableBasicSupplies.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableBasicSupplies.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'enableArmorSlotCost', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableArmorSlotCost.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableArmorSlotCost.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'autoBulkFromWeight', {
        name: game.i18n.localize('GLINVSLOTS.settings.autoBulkFromWeight.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.autoBulkFromWeight.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'showBulkColumn', {
        name: game.i18n.localize('GLINVSLOTS.settings.showBulkColumn.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.showBulkColumn.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    game.settings.register(MODULE_ID, 'replaceEncumbranceBar', {
        name: game.i18n.localize('GLINVSLOTS.settings.replaceEncumbranceBar.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.replaceEncumbranceBar.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    // --- Wear & Tear Settings ---

    game.settings.register(MODULE_ID, 'enableWearAndTear', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableWearAndTear.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableWearAndTear.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'enableTempering', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableTempering.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableTempering.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'autoNotchOnCrit', {
        name: game.i18n.localize('GLINVSLOTS.settings.autoNotchOnCrit.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.autoNotchOnCrit.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    // --- Ammunition Dice Settings ---

    game.settings.register(MODULE_ID, 'enableAmmunitionDice', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableAmmunitionDice.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableAmmunitionDice.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });

    game.settings.register(MODULE_ID, 'autoRollAmmoDice', {
        name: game.i18n.localize('GLINVSLOTS.settings.autoRollAmmoDice.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.autoRollAmmoDice.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: true
    });

    // --- Dice Pool Settings ---

    game.settings.register(MODULE_ID, 'enableDicePool', {
        name: game.i18n.localize('GLINVSLOTS.settings.enableDicePool.name'),
        hint: game.i18n.localize('GLINVSLOTS.settings.enableDicePool.hint'),
        scope: 'world',
        config: true,
        type: Boolean,
        default: false
    });
}

export function getSetting(key) {
    return game.settings.get(MODULE_ID, key);
}

export function setSetting(key, value) {
    return game.settings.set(MODULE_ID, key, value);
}
