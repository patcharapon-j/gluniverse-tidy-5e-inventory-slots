import { MODULE_ID, FLAG_SCOPE, registerSettings } from './settings.js';
import { SlotCalculator } from './SlotCalculator.js';
import { TidyIntegration } from './TidyIntegration.js';
import { NotchCalculator } from './NotchCalculator.js';
import { AmmoDiceCalculator } from './AmmoDiceCalculator.js';
import { DicePoolCalculator } from './DicePoolCalculator.js';

Hooks.once('init', () => {
    console.log(`${MODULE_ID} | Initializing GLUniverse Inventory Slots`);
    registerSettings();
});

Hooks.on('ready', () => {
    console.log(`${MODULE_ID} | Ready`);

    // Verify dependencies
    if (!game.modules.get('tidy5e-sheet')?.active) {
        ui.notifications.error(
            game.i18n.localize('GLINVSLOTS.errors.tidyRequired')
        );
        return;
    }

    // Expose API
    const mod = game.modules.get(MODULE_ID);
    mod.api = {
        SlotCalculator,
        NotchCalculator,
        AmmoDiceCalculator,
        DicePoolCalculator,
        calculateInventory: (actor) => SlotCalculator.calculateInventory(actor),
        getItemBulk: (item, actor) => SlotCalculator.getItemBulk(item, actor),
        getMaxSlots: (actor) => SlotCalculator.getMaxSlots(actor),
        getNotches: (item) => NotchCalculator.getNotches(item),
        addNotch: (item) => NotchCalculator.addNotch(item),
        removeNotch: (item, count) => NotchCalculator.removeNotch(item, count),
        getNotchSummary: (item) => NotchCalculator.getNotchSummary(item),
        rollAmmoDie: (item) => AmmoDiceCalculator.rollAmmoDie(item),
        getAmmoSummary: (item) => AmmoDiceCalculator.getAmmoSummary(item),
        rollDicePool: (item) => DicePoolCalculator.rollPool(item),
        getPoolSummary: (item) => DicePoolCalculator.getPoolSummary(item),
    };

    globalThis.GLUniverseInventorySlots = mod.api;
});

// Hook into Tidy 5e Sheet API when it's ready
Hooks.once('tidy5e-sheet.ready', (api) => {
    console.log(`${MODULE_ID} | Tidy 5e Sheet API ready`);
    TidyIntegration.init(api);
    TidyIntegration.registerContextMenus();
});

// ─── Mechanical Effects — Wrap prepareDerivedData ───────────────────

/**
 * Wrap Actor.prepareDerivedData for AC penalty from notched armor.
 * Wrap Item.prepareDerivedData for weapon damage degradation from notches.
 * These run during data preparation, so rolls and displays use degraded values.
 */
Hooks.once('ready', () => {
    // --- Actor: AC penalty from notched armor ---
    const ActorClass = CONFIG.Actor?.documentClass;
    if (ActorClass) {
        const origActorPrep = ActorClass.prototype.prepareDerivedData;
        ActorClass.prototype.prepareDerivedData = function (...args) {
            origActorPrep.call(this, ...args);
            try {
                if (!getSetting('enableWearAndTear')) return;
                if (this.type !== 'character' && this.type !== 'npc') return;

                const acPenalty = NotchCalculator.getActorArmorNotchPenalty(this);
                if (acPenalty > 0 && this.system?.attributes?.ac) {
                    this.system.attributes.ac.value = Math.max(0, this.system.attributes.ac.value - acPenalty);
                }
            } catch { /* fail silently if data not yet available */ }
        };
    }

    // --- Item: weapon damage degradation from notches ---
    const ItemClass = CONFIG.Item?.documentClass;
    if (ItemClass) {
        const origItemPrep = ItemClass.prototype.prepareDerivedData;
        ItemClass.prototype.prepareDerivedData = function (...args) {
            origItemPrep.call(this, ...args);
            try {
                if (!getSetting('enableWearAndTear')) return;
                if (this.type !== 'weapon') return;

                const notches = NotchCalculator.getEffectiveNotches(this);
                if (notches <= 0) return;

                // dnd5e 5.2+: structured DamageData with number/denomination
                if (this.system.damage?.base?.denomination) {
                    NotchCalculator.degradeDamageData(this.system.damage.base, notches);
                }
                if (this.system.damage?.versatile?.denomination) {
                    NotchCalculator.degradeDamageData(this.system.damage.versatile, notches);
                }

                // Also degrade activity damage parts (attack activities)
                if (this.system.activities) {
                    for (const activity of Object.values(this.system.activities)) {
                        if (activity.damage?.parts) {
                            for (const part of activity.damage.parts) {
                                if (part?.denomination) {
                                    NotchCalculator.degradeDamageData(part, notches);
                                }
                            }
                        }
                    }
                }

                // Legacy fallback: damage.parts array [["1d8 + @mod", "slashing"]]
                if (this.system.damage?.parts?.length > 0 && Array.isArray(this.system.damage.parts[0])) {
                    const origFormula = this.system.damage.parts[0][0];
                    const diceMatch = origFormula?.match(/(\d+d\d+)/);
                    if (diceMatch) {
                        const degraded = NotchCalculator._degradeFormula(diceMatch[1], notches);
                        this.system.damage.parts[0] = [
                            origFormula.replace(diceMatch[1], degraded),
                            this.system.damage.parts[0][1]
                        ];
                    }
                }
            } catch { /* fail silently */ }
        };
    }
});

// ─── Mechanical Effects — Spell Attack / Save DC from Notched Focus ─

/**
 * Hook into spell attack rolls to apply focus notch penalty.
 */
Hooks.on('dnd5e.preRollAttack', (item, config) => {
    if (!getSetting('enableWearAndTear')) return;
    if (!item || item.type !== 'spell') return;

    const actor = item.parent;
    if (!actor) return;

    const penalty = NotchCalculator.getActorFocusPenalty(actor);
    if (penalty > 0) {
        config.parts = config.parts || [];
        config.parts.push(`-${penalty}`);
    }
});

/**
 * Modify spell save DC when a spell is used with a notched focus.
 */
Hooks.on('dnd5e.useItem', (item, config, options) => {
    if (!getSetting('enableWearAndTear')) return;
    if (!item || item.type !== 'spell') return;

    const actor = item.parent;
    if (!actor) return;

    const penalty = NotchCalculator.getActorFocusPenalty(actor);
    if (penalty > 0 && item.system?.save?.dc) {
        // Temporarily reduce save DC for this use
        const origDC = item.system.save.dc;
        const newDC = Math.max(1, origDC - penalty);
        if (origDC !== newDC) {
            item.system.save.dc = newDC;
            const focus = NotchCalculator.getActorEquippedFocus(actor);
            if (focus) {
                ui.notifications.info(
                    `${focus.name}: Spell DC reduced by ${penalty} (${origDC} → ${newDC}) due to notches`
                );
            }
        }
    }
});

// ─── Auto-Notch on Critical Hits / Fumbles ──────────────────────────

/**
 * Hook into dnd5e attack rolls to detect crits and fumbles.
 * dnd5e 5.2+ signature: (rolls, { subject, ammoUpdate })
 *   - rolls: D20Roll[] array
 *   - subject: AttackActivity (has .item property)
 *   - ammoUpdate: { id, quantity, destroy? } or null
 */
Hooks.on('dnd5e.rollAttack', async (rolls, data) => {
    if (!getSetting('enableWearAndTear')) return;
    if (!getSetting('autoNotchOnCrit')) return;
    if (game.user.id !== game.users.activeGM?.id) return; // Only GM processes

    const roll = Array.isArray(rolls) ? rolls[0] : rolls;
    const subject = data?.subject;
    const item = subject?.item;

    const isCrit = roll?.isCritical ?? (roll?.total !== undefined && roll?.dice?.[0]?.total === 20);
    const isFumble = roll?.isFumble ?? (roll?.total !== undefined && roll?.dice?.[0]?.total === 1);

    if (!isCrit && !isFumble) return;

    const actor = item?.parent;
    if (!actor) return;

    if (isFumble) {
        // Fumble → notch the weapon or focus used
        const toNotch = NotchCalculator.getWeaponToNotch(actor, item);
        if (toNotch) {
            const result = await NotchCalculator.addNotch(toNotch);
            const reason = toNotch.type === 'weapon'
                ? game.i18n.localize('GLINVSLOTS.notch.weaponNotched')
                : game.i18n.localize('GLINVSLOTS.notch.focusNotched');
            await NotchCalculator.announceNotch(toNotch, actor, reason);
        }
    }

    if (isCrit) {
        // Critical hit → notch the target's armor
        const targets = game.user.targets;
        for (const token of targets) {
            const targetActor = token.actor;
            if (!targetActor) continue;
            const armorItem = NotchCalculator.getArmorToNotch(targetActor);
            if (armorItem) {
                const result = await NotchCalculator.addNotch(armorItem);
                const reason = game.i18n.localize('GLINVSLOTS.notch.armorNotched');
                await NotchCalculator.announceNotch(armorItem, targetActor, reason);
            }
        }
    }
});

// ─── Ammunition Dice — Prevent Quantity Deduction ───────────────────

/**
 * Before a weapon is used, check if it has a paired ammo item using dice tracking.
 * If so, prevent dnd5e from consuming the ammo quantity — the dice system replaces counting.
 *
 * Also handles weapons that have dnd5e's built-in consume target pointing at ammo-dice items.
 */
Hooks.on('dnd5e.preUseItem', (item, config, options) => {
    if (!getSetting('enableAmmunitionDice')) return;
    if (item.type !== 'weapon') return;

    const actor = item.parent;
    if (!actor) return;

    // Check explicit pairing first
    const pairedAmmoId = item.getFlag(FLAG_SCOPE, 'pairedAmmoId');
    if (pairedAmmoId) {
        const ammoItem = actor.items.get(pairedAmmoId);
        if (ammoItem && AmmoDiceCalculator.usesAmmoDice(ammoItem)) {
            // Prevent dnd5e from deducting ammo quantity
            if (config.consume !== undefined) config.consume = false;
            if (config.consumeResource !== undefined) config.consumeResource = false;
            return;
        }
    }

    // Also check dnd5e's built-in consume target
    const consumeTarget = item.system?.consume?.target;
    if (consumeTarget) {
        const ammoItem = actor.items.get(consumeTarget);
        if (ammoItem && AmmoDiceCalculator.usesAmmoDice(ammoItem)) {
            if (config.consume !== undefined) config.consume = false;
            if (config.consumeResource !== undefined) config.consumeResource = false;
        }
    }
});

/**
 * Also intercept activity-based usage (dnd5e 5.2+ activities system).
 * Prevents consumption at the activity level.
 */
Hooks.on('dnd5e.preUseActivity', (activity, usageConfig, dialogConfig, messageConfig) => {
    if (!getSetting('enableAmmunitionDice')) return;

    const item = activity?.item;
    if (!item || item.type !== 'weapon') return;

    const actor = item.parent;
    if (!actor) return;

    const pairedAmmoId = item.getFlag(FLAG_SCOPE, 'pairedAmmoId');
    const consumeTarget = item.system?.consume?.target;
    const ammoId = pairedAmmoId || consumeTarget;
    if (!ammoId) return;

    const ammoItem = actor.items.get(ammoId);
    if (ammoItem && AmmoDiceCalculator.usesAmmoDice(ammoItem)) {
        if (usageConfig.consume !== undefined) usageConfig.consume = false;
        if (usageConfig.consumeResource !== undefined) usageConfig.consumeResource = false;
    }
});

// ─── Ammunition Dice — Auto-roll on Attack ─────────────────────────

/**
 * Hook into dnd5e attack rolls to automatically roll the ammo die.
 * dnd5e 5.2+ signature: (rolls, { subject, ammoUpdate })
 *   - rolls: D20Roll[] array
 *   - subject: AttackActivity (has .item property)
 *   - ammoUpdate: { id, quantity, destroy? } or null
 *
 * Checks weapon-ammo pairing first, then falls back to dnd5e consume/ammoUpdate.
 */
Hooks.on('dnd5e.rollAttack', async (rolls, data) => {
    if (!getSetting('enableAmmunitionDice')) return;
    if (!getSetting('autoRollAmmoDice')) return;

    const subject = data?.subject;
    const item = subject?.item;
    const actor = item?.parent;
    if (!actor) return;

    // 1. Check explicit weapon-ammo pairing
    const pairedAmmoId = item.getFlag?.(FLAG_SCOPE, 'pairedAmmoId');
    if (pairedAmmoId) {
        const ammoItem = actor.items.get(pairedAmmoId);
        if (ammoItem && AmmoDiceCalculator.usesAmmoDice(ammoItem)) {
            await AmmoDiceCalculator.rollAmmoDie(ammoItem, true);
            return;
        }
    }

    // 2. Fallback: check ammoUpdate from dnd5e
    let ammoId = data?.ammoUpdate?.id || null;

    // 3. Fallback: check dnd5e consume target on the item
    if (!ammoId) {
        ammoId = item.system?.consume?.target;
    }

    if (!ammoId) return;

    const ammoItem = actor.items.get(ammoId);
    if (!ammoItem) return;
    if (!AmmoDiceCalculator.usesAmmoDice(ammoItem)) return;

    await AmmoDiceCalculator.rollAmmoDie(ammoItem, true);
});

// Update when items change
Hooks.on('createItem', (item, options, userId) => {
    if (!getSetting('enableSlotSystem') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;
    _refreshActorSheet(item.parent);
});

Hooks.on('updateItem', (item, changes, options, userId) => {
    if (!getSetting('enableSlotSystem') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;
    _refreshActorSheet(item.parent);
});

Hooks.on('deleteItem', (item, options, userId) => {
    if (!getSetting('enableSlotSystem') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;
    _refreshActorSheet(item.parent);
});

Hooks.on('updateActor', (actor, changes, options, userId) => {
    if (!getSetting('enableSlotSystem')) return;
    if (actor.type !== 'character' && actor.type !== 'npc') return;
    _refreshActorSheet(actor);
});

/**
 * Re-inject our UI into the actor sheet after data changes.
 * Uses polling to survive Svelte re-render cycles that may wipe injected DOM.
 */
function _refreshActorSheet(actor) {
    if (!actor) return;
    if (actor._glInvInterval) clearInterval(actor._glInvInterval);

    let attempts = 0;
    actor._glInvInterval = setInterval(() => {
        attempts++;
        const app = actor.sheet;
        if (!app) { clearInterval(actor._glInvInterval); return; }
        const el = app.element instanceof jQuery ? app.element[0] : app.element;
        if (!el) { clearInterval(actor._glInvInterval); return; }

        TidyIntegration._processActorSheet(app, el);

        // Panel is external to DOM — just run a few attempts to catch Svelte re-renders
        if (attempts >= 5) {
            clearInterval(actor._glInvInterval);
        }
    }, 300);
}

function getSetting(key) {
    try {
        return game.settings.get(MODULE_ID, key);
    } catch {
        return false;
    }
}
