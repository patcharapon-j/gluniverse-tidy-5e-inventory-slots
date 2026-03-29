import {
    MODULE_ID, FLAG_SCOPE, TEMPER_GRADES, FRAGILITY,
    DIE_CHAIN, ARMOR_SACRIFICE_DICE, QUALITY_GRADES, getSetting
} from './settings.js';

/**
 * Calculation engine for the Wear & Tear (Notch/Temper) system.
 * Implements Giffyglyph's Darker Dungeons Wear & Tear rules.
 */
export class NotchCalculator {

    // ─── Notch Tracking ─────────────────────────────────────────────

    /**
     * Get current notch count for an item (can be fractional from tempering).
     */
    static getNotches(item) {
        return item.getFlag(FLAG_SCOPE, 'notches') ?? 0;
    }

    /**
     * Get the effective (whole) notch count — rounds down fractional notches.
     * This is the number of notches that actually affect the item mechanically.
     */
    static getEffectiveNotches(item) {
        return Math.floor(this.getNotches(item));
    }

    /**
     * Get max notches before the item shatters.
     */
    static getMaxNotches(item) {
        const override = item.getFlag(FLAG_SCOPE, 'maxNotchesOverride');
        if (override != null && override > 0) return override;

        const fragility = this.getFragility(item);
        return FRAGILITY[fragility].maxNotches;
    }

    /**
     * Get the fragility category of an item.
     */
    static getFragility(item) {
        const override = item.getFlag(FLAG_SCOPE, 'fragility');
        if (override && FRAGILITY[override]) return override;
        return 'sturdy'; // default
    }

    /**
     * Check if an item is shattered (notches >= max, weapon degraded past modifiers-only,
     * or armor AC penalty meets/exceeds its base AC bonus).
     */
    static isShattered(item) {
        if (this.getEffectiveNotches(item) >= this.getMaxNotches(item)) return true;

        // Armor shatters when notches reduce AC bonus to zero or below
        if (item.type === 'equipment') {
            const acBonus = this.getArmorACBonus(item);
            if (acBonus > 0 && this.getEffectiveNotches(item) >= acBonus) return true;
        }

        // Weapons shatter one notch after losing all dice
        if (item.type === 'weapon') {
            const notches = this.getEffectiveNotches(item);
            if (notches === 0) return false;

            // Read ORIGINAL denomination from source data (not the already-degraded derived data)
            const origDenom = item._source?.system?.damage?.base?.denomination
                || item.system.damage?.base?.denomination;
            if (!origDenom) return false;

            // Count steps from original denomination to 0 dice
            let denom = origDenom;
            let steps = 0;
            while (denom > 0) {
                const idx = DIE_CHAIN.indexOf(`d${denom}`);
                denom = (idx >= 0 && idx < DIE_CHAIN.length - 1)
                    ? parseInt(DIE_CHAIN[idx + 1].slice(1)) : 0;
                steps++;
            }
            // steps = notches to reach "modifiers only", steps+1 = shattered
            if (notches > steps) return true;
        }
        return false;
    }

    // ─── Temper ─────────────────────────────────────────────────────

    /**
     * Get temper grade for an item.
     */
    static getTemper(item) {
        if (!getSetting('enableTempering')) return 'none';
        const temper = item.getFlag(FLAG_SCOPE, 'temper');
        return (temper && TEMPER_GRADES[temper]) ? temper : 'none';
    }

    /**
     * Get the notch increment when this item suffers a critical hit/fumble.
     * Tempered items gain fractional notches.
     */
    static getNotchIncrement(item) {
        const temper = this.getTemper(item);
        return TEMPER_GRADES[temper].notchMult;
    }

    // ─── Adding / Removing Notches ──────────────────────────────────

    /**
     * Add a notch to an item (respecting temper grade).
     * Updates the peak notch count for quality tracking.
     * @returns {Object} { newNotches, shattered, increment }
     */
    static async addNotch(item) {
        const increment = this.getNotchIncrement(item);
        const current = this.getNotches(item);
        const newNotches = current + increment;
        const maxNotches = this.getMaxNotches(item);

        await item.setFlag(FLAG_SCOPE, 'notches', newNotches);

        // Track peak notch count for quality grade
        const effectiveNew = Math.floor(newNotches);
        const currentPeak = item.getFlag(FLAG_SCOPE, 'peakNotches') ?? 0;
        if (effectiveNew > currentPeak) {
            await item.setFlag(FLAG_SCOPE, 'peakNotches', effectiveNew);
        }

        const shattered = effectiveNew >= maxNotches;
        return { newNotches, shattered, increment };
    }

    /**
     * Remove notches from an item (repair).
     * @param {number} count - Number of whole notches to remove
     */
    static async removeNotch(item, count = 1) {
        const current = this.getNotches(item);
        const newNotches = Math.max(0, current - count);
        await item.setFlag(FLAG_SCOPE, 'notches', newNotches);
        return newNotches;
    }

    /**
     * Set notches to a specific value (GM override).
     */
    static async setNotches(item, value) {
        await item.setFlag(FLAG_SCOPE, 'notches', Math.max(0, value));
        const peak = item.getFlag(FLAG_SCOPE, 'peakNotches') ?? 0;
        if (Math.floor(value) > peak) {
            await item.setFlag(FLAG_SCOPE, 'peakNotches', Math.floor(value));
        }
    }

    // ─── Quality Grade ──────────────────────────────────────────────

    /**
     * Get the quality grade of an item based on peak notch count.
     * @returns {{ key: string, resalePercent: number }}
     */
    static getQualityGrade(item) {
        const peak = item.getFlag(FLAG_SCOPE, 'peakNotches') ?? 0;
        // Walk backwards through grades (highest threshold first)
        for (let i = QUALITY_GRADES.length - 1; i >= 0; i--) {
            if (peak >= QUALITY_GRADES[i].minPeak) return QUALITY_GRADES[i];
        }
        return QUALITY_GRADES[0]; // pristine
    }

    // ─── Weapon Die Degradation ─────────────────────────────────────

    /**
     * Get the degraded damage for a weapon with notches.
     * Supports dnd5e 5.2+ DamageData format (number/denomination) and legacy parts format.
     * @param {Item} item
     * @returns {{ original: string, degraded: string, notches: number } | null}
     */
    static getDegradedWeaponDamage(item) {
        const notches = this.getEffectiveNotches(item);
        if (notches === 0) return null;
        if (item.type !== 'weapon') return null;

        // dnd5e 5.2+: structured DamageData in damage.base
        // Read from _source to get the un-degraded original values
        const sourceBase = item._source?.system?.damage?.base;
        const base = sourceBase || item.system.damage?.base;
        if (base && base.denomination) {
            const origNum = base.number || 1;
            const origDenom = base.denomination;
            const original = `${origNum}d${origDenom}`;

            // Simulate degradation
            let denom = origDenom;
            let remaining = notches;
            while (remaining > 0 && denom > 0) {
                const idx = DIE_CHAIN.indexOf(`d${denom}`);
                if (idx >= 0 && idx < DIE_CHAIN.length - 1) {
                    denom = parseInt(DIE_CHAIN[idx + 1].slice(1));
                } else {
                    denom = 0;
                }
                remaining--;
            }

            let degraded;
            if (denom === 0) {
                degraded = `1 + ${game.i18n ? game.i18n.localize('GLINVSLOTS.notch.modifiersOnly') : 'mod'}`;
            } else {
                degraded = `${origNum}d${denom}`;
            }
            return { original, degraded, notches };
        }

        // Legacy: damage.parts array [["1d8 + @mod", "slashing"]]
        const parts = item.system.damage?.parts;
        if (parts?.length > 0) {
            const formula = Array.isArray(parts[0]) ? parts[0][0] : (parts[0].formula || String(parts[0]));
            if (formula) {
                const degraded = this._degradeFormula(formula, notches);
                return { original: formula, degraded, notches };
            }
        }

        return null;
    }

    /**
     * Degrade a structured DamageData object's number/denomination in-place.
     * Used by Item.prepareDerivedData to modify weapon damage at data-prep time.
     *
     * Degradation chain per notch:
     *   d12 → d10 → d8 → d6 → d4 → 0 (modifiers only) → shattered
     *
     * For multi-die weapons (e.g. 2d6):
     *   2d6 → 2d4 (step each down) → 0 dice → shattered
     *
     * @param {Object} damageData - { number, denomination, ... }
     * @param {number} notches - effective notch count
     */
    static degradeDamageData(damageData, notches) {
        if (!damageData || notches <= 0) return;
        // Already at 0 dice — nothing to degrade further
        if (!damageData.denomination) return;

        let denom = damageData.denomination;
        let remaining = notches;

        while (remaining > 0 && denom > 0) {
            const dieStr = `d${denom}`;
            const chainIdx = DIE_CHAIN.indexOf(dieStr);

            if (chainIdx >= 0 && chainIdx < DIE_CHAIN.length - 1) {
                // Step down: d12→d10→d8→d6→d4
                denom = parseInt(DIE_CHAIN[chainIdx + 1].slice(1));
            } else {
                // At d4 (end of chain) → next notch removes all dice (modifiers only)
                denom = 0;
            }
            remaining--;
        }

        if (denom === 0) {
            // No dice left — modifiers only, minimum 1 damage.
            // Set to 1d1 so the die portion always contributes exactly 1,
            // and dnd5e still appends ability modifier + bonus.
            damageData.number = 1;
            damageData.denomination = 1;
        } else {
            damageData.denomination = denom;
        }
    }

    /**
     * Check if a weapon's dice are fully degraded (past d4, modifiers only).
     * The next notch after this state should shatter the weapon.
     */
    static isWeaponFullyDegraded(item) {
        if (item.type !== 'weapon') return false;
        const notches = this.getEffectiveNotches(item);
        if (notches === 0) return false;

        // Read ORIGINAL denomination from source data
        const origDenom = item._source?.system?.damage?.base?.denomination
            || item.system.damage?.base?.denomination;
        if (!origDenom) return true; // already no dice

        // Count how many notches it takes to reach 0
        let denom = origDenom;
        let steps = 0;
        while (denom > 0) {
            const chainIdx = DIE_CHAIN.indexOf(`d${denom}`);
            if (chainIdx >= 0 && chainIdx < DIE_CHAIN.length - 1) {
                denom = parseInt(DIE_CHAIN[chainIdx + 1].slice(1));
            } else {
                denom = 0;
            }
            steps++;
        }
        // If effective notches >= steps, dice are gone
        // If effective notches > steps, weapon should be shattered
        return notches >= steps;
    }

    /**
     * Degrade a damage formula by N notch steps.
     * Handles: "1d8", "2d6", "1d10+3", "2d6+4", etc.
     */
    static _degradeFormula(formula, notches) {
        // Parse the formula to find dice expressions
        const diceRegex = /(\d+)d(\d+)/g;
        const matches = [...formula.matchAll(diceRegex)];

        if (!matches.length) return formula; // no dice to degrade

        let result = formula;
        let remainingNotches = notches;

        while (remainingNotches > 0) {
            // Find all current dice in the result
            const currentMatches = [...result.matchAll(/(\d+)d(\d+)/g)];
            if (!currentMatches.length) break; // no more dice

            // Find the largest die
            let largestIdx = 0;
            let largestSize = 0;
            for (let i = 0; i < currentMatches.length; i++) {
                const size = parseInt(currentMatches[i][2]);
                if (size > largestSize) {
                    largestSize = size;
                    largestIdx = i;
                }
            }

            const match = currentMatches[largestIdx];
            const count = parseInt(match[1]);
            const dieSize = parseInt(match[2]);
            const dieStr = `d${dieSize}`;
            const chainIdx = DIE_CHAIN.indexOf(dieStr);

            if (chainIdx === -1 || chainIdx >= DIE_CHAIN.length - 1) {
                // Already at d4 or unknown die — degrade to flat 1
                if (count > 1) {
                    // e.g. 2d4 → 1d4 + 1
                    result = result.replace(match[0], `${count - 1}d${dieSize}+1`);
                } else {
                    // 1d4 → 1
                    result = result.replace(match[0], '1');
                }
            } else {
                // Step down the die: e.g. 1d8 → 1d6
                const newDie = DIE_CHAIN[chainIdx + 1];
                if (count > 1) {
                    // Multi-die: reduce only the largest one
                    // e.g. 2d6 → 1d6+1d4
                    result = result.replace(match[0], `${count - 1}d${dieSize}+1${newDie}`);
                } else {
                    result = result.replace(match[0], `1${newDie}`);
                }
            }

            remainingNotches--;
        }

        // Clean up: collapse "0d..." to nothing, simplify "+1+1" to "+2", etc.
        result = result.replace(/0d\d+\+?/g, '');
        result = result.replace(/^\+/, '');
        if (!result) result = '1';

        return result;
    }

    // ─── Armor Penalty ──────────────────────────────────────────────

    /**
     * Get the base AC bonus of armor, excluding Dex.
     * Body armor: armor.value - 10 (e.g. chain mail 16 → 6).
     * Shields: armor.value directly (typically 2).
     * Returns 0 if not armor.
     */
    static getArmorACBonus(item) {
        if (item.type !== 'equipment') return 0;
        const armorType = item.system.type?.value || item.system.armor?.type;
        if (!['light', 'medium', 'heavy', 'shield'].includes(armorType)) return 0;
        const baseAC = item.system.armor?.value ?? 0;
        return armorType === 'shield' ? baseAC : Math.max(0, baseAC - 10);
    }

    /**
     * Get the AC penalty for armor with notches.
     * Each effective notch = -1 AC, capped at the armor's base AC bonus.
     * If penalty meets or exceeds the AC bonus, the armor is shattered.
     */
    static getArmorACPenalty(item) {
        if (item.type !== 'equipment') return 0;
        const armorType = item.system.type?.value || item.system.armor?.type;
        if (!['light', 'medium', 'heavy', 'shield'].includes(armorType)) return 0;
        const notches = this.getEffectiveNotches(item);
        const acBonus = this.getArmorACBonus(item);
        return Math.min(notches, acBonus);
    }

    /**
     * Get the sacrifice damage reduction dice for armor.
     */
    static getArmorSacrificeDice(item) {
        const armorType = item.system.type?.value || item.system.armor?.type;
        return ARMOR_SACRIFICE_DICE[armorType] || null;
    }

    // ─── Focus / Arcane Focus ──────────────────────────────────────

    /**
     * Check if an item is marked as an arcane focus for this system.
     */
    static isArcaneFocus(item) {
        return item.getFlag(FLAG_SCOPE, 'isArcaneFocus') === true;
    }

    /**
     * Spellcasting focus: each notch = -1 to spell attack and save DC.
     */
    static getFocusPenalty(item) {
        return this.getEffectiveNotches(item);
    }

    /**
     * Get the total AC penalty from all equipped notched armor on an actor.
     */
    static getActorArmorNotchPenalty(actor) {
        const items = actor.items?.contents ?? [];
        let penalty = 0;
        for (const item of items) {
            if (item.type !== 'equipment') continue;
            if (!item.system.equipped) continue;
            const armorType = item.system.type?.value || item.system.armor?.type;
            if (!['light', 'medium', 'heavy', 'shield'].includes(armorType)) continue;
            penalty += this.getArmorACPenalty(item);
        }
        return penalty;
    }

    /**
     * Get the spell penalty from an actor's equipped arcane focus.
     * Returns the notch count of the equipped focus marked as arcane focus.
     */
    static getActorFocusPenalty(actor) {
        const items = actor.items?.contents ?? [];
        const focus = items.find(i =>
            i.system.equipped && this.isArcaneFocus(i)
        );
        if (!focus) return 0;
        return this.getEffectiveNotches(focus);
    }

    /**
     * Find the actor's equipped arcane focus item.
     */
    static getActorEquippedFocus(actor) {
        const items = actor.items?.contents ?? [];
        return items.find(i =>
            i.system.equipped && this.isArcaneFocus(i)
        ) || null;
    }

    // ─── Misc Item Penalty ──────────────────────────────────────────

    /**
     * Miscellaneous items: each notch = -1 penalty to rolls using that item.
     */
    static getMiscPenalty(item) {
        return this.getEffectiveNotches(item);
    }

    // ─── Repair Cost ────────────────────────────────────────────────

    /**
     * Calculate repair cost per notch (10% of item value, adjusted for temper).
     */
    static getRepairCostPerNotch(item) {
        const basePrice = item.system.price?.value ?? 0;
        const temper = this.getTemper(item);
        const temperedValue = basePrice * TEMPER_GRADES[temper].valueMult;
        return Math.max(1, Math.round(temperedValue * 0.1));
    }

    /**
     * Calculate total repair cost to remove all notches.
     */
    static getTotalRepairCost(item) {
        const effectiveNotches = this.getEffectiveNotches(item);
        if (effectiveNotches <= 0) return 0;
        return effectiveNotches * this.getRepairCostPerNotch(item);
    }

    // ─── Tempering Cost ─────────────────────────────────────────────

    /**
     * Calculate the cost to temper an item to a given grade.
     */
    static getTemperingCost(item, grade) {
        const basePrice = item.system.price?.value ?? 0;
        const gradeData = TEMPER_GRADES[grade];
        if (!gradeData) return 0;
        return basePrice * gradeData.costMult;
    }

    // ─── Notch Summary for Display ──────────────────────────────────

    /**
     * Get a complete notch summary for an item.
     */
    static getNotchSummary(item) {
        const notches = this.getNotches(item);
        const effective = this.getEffectiveNotches(item);
        const max = this.getMaxNotches(item);
        const fragility = this.getFragility(item);
        const temper = this.getTemper(item);
        const quality = this.getQualityGrade(item);
        const shattered = this.isShattered(item);

        let effect = null;
        if (item.type === 'weapon' && effective > 0) {
            effect = this.getDegradedWeaponDamage(item);
        } else if (item.type === 'equipment') {
            const acPenalty = this.getArmorACPenalty(item);
            if (acPenalty > 0) effect = { type: 'ac', penalty: acPenalty };
        }

        return {
            notches,
            effective,
            max,
            fragility,
            temper,
            quality,
            shattered,
            effect,
            repairCostPerNotch: this.getRepairCostPerNotch(item),
            totalRepairCost: this.getTotalRepairCost(item)
        };
    }

    // ─── Auto-Notch Helpers ─────────────────────────────────────────

    /**
     * Determine which item to notch when an actor rolls a critical failure on attack.
     * Notches the weapon used in the attack.
     */
    static getWeaponToNotch(actor, itemUsed) {
        if (!itemUsed) return null;
        if (itemUsed.type === 'weapon') return itemUsed;
        // If using a spell with a focus, find the focus
        if (itemUsed.type === 'spell') {
            return this._findSpellcastingFocus(actor);
        }
        return null;
    }

    /**
     * Determine which item to notch when an actor is critically hit.
     * Notches the worn armor, or a random inventory item if unarmored.
     */
    static getArmorToNotch(actor) {
        const items = actor.items?.contents ?? [];
        // Find equipped armor
        const armor = items.find(i =>
            i.type === 'equipment' &&
            i.system.equipped &&
            ['light', 'medium', 'heavy'].includes(i.system.type?.value || i.system.armor?.type)
        );
        if (armor) return armor;

        // Find equipped shield
        const shield = items.find(i =>
            i.type === 'equipment' &&
            i.system.equipped &&
            (i.system.type?.value === 'shield' || i.system.armor?.type === 'shield')
        );
        if (shield) return shield;

        // Unarmored — random physical item
        const physicalItems = items.filter(i =>
            ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container'].includes(i.type)
        );
        if (physicalItems.length === 0) return null;
        return physicalItems[Math.floor(Math.random() * physicalItems.length)];
    }

    /**
     * Find the actor's spellcasting focus.
     * Prefers items explicitly marked as arcane focus, falls back to name heuristics.
     */
    static _findSpellcastingFocus(actor) {
        const items = actor.items?.contents ?? [];

        // First: check for explicitly marked arcane focus
        const marked = items.find(i => i.system.equipped && this.isArcaneFocus(i));
        if (marked) return marked;

        // Fallback: heuristic based on item name/type
        const focus = items.find(i =>
            i.system.equipped &&
            (i.system.type?.value === 'trinket' ||
             i.system.type?.value === 'wondrous' ||
             i.name?.toLowerCase().includes('focus') ||
             i.name?.toLowerCase().includes('staff') ||
             i.name?.toLowerCase().includes('wand') ||
             i.name?.toLowerCase().includes('rod') ||
             i.name?.toLowerCase().includes('orb'))
        );
        return focus || null;
    }

    // ─── Chat Message ───────────────────────────────────────────────

    /**
     * Create a chat message announcing a notch was gained.
     */
    static async announceNotch(item, actor, reason) {
        const notches = this.getNotches(item);
        const max = this.getMaxNotches(item);
        const shattered = this.isShattered(item);
        const increment = this.getNotchIncrement(item);
        const temper = this.getTemper(item);

        let content = `<div class="glinv-notch-chat">`;
        content += `<strong>${item.name}</strong> gains `;

        if (increment < 1) {
            const temperLabel = game.i18n.localize(`GLINVSLOTS.notch.temper.${temper}`);
            content += `<span class="glinv-notch-fraction">${this._fractionLabel(increment)}</span> notch `;
            content += `<em>(${temperLabel})</em>`;
        } else {
            content += `<strong>1</strong> notch`;
        }

        content += ` — <em>${reason}</em>`;
        content += `<br><small>${game.i18n.localize('GLINVSLOTS.notch.notches')}: ${Math.floor(notches)}/${max}</small>`;

        if (shattered) {
            content += `<br><strong class="glinv-shattered-text">${game.i18n.localize('GLINVSLOTS.notch.shattered')}!</strong>`;
        } else {
            // Show effect
            if (item.type === 'weapon') {
                const deg = this.getDegradedWeaponDamage(item);
                if (deg) content += `<br><small>${game.i18n.localize('GLINVSLOTS.notch.damage')}: ${deg.original} → ${deg.degraded}</small>`;
            } else if (item.type === 'equipment') {
                const penalty = this.getArmorACPenalty(item);
                if (penalty > 0) content += `<br><small>AC −${penalty}</small>`;
            }
        }

        content += `</div>`;

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content,
            flavor: `<i class="fas fa-hammer"></i> ${game.i18n.localize('GLINVSLOTS.notch.wearAndTear')}`,
        });
    }

    static _fractionLabel(value) {
        if (value === 0.5) return '&frac12;';
        if (value === 0.25) return '&frac14;';
        if (value === 0.125) return '&#x215B;'; // ⅛
        return String(value);
    }
}
