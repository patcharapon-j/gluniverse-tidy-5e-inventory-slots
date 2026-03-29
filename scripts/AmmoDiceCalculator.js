import { MODULE_ID, FLAG_SCOPE, AMMO_DIE_CHAIN, AMMO_REPLENISH_COST, getSetting } from './settings.js';

/**
 * Calculation engine for the Ammunition Dice system.
 * Implements Giffyglyph's Darker Dungeons Ammunition Dice rules.
 *
 * Instead of tracking individual arrows/bolts, ammunition uses a die
 * (d12 → d10 → d8 → d6 → d4 → 1 → empty). After each use, roll the
 * die — on a 1 or 2, the die degrades one step.
 */
export class AmmoDiceCalculator {

    // ─── Ammo Detection ─────────────────────────────────────────────

    /**
     * Check if an item is ammunition that should use the dice system.
     * Excludes magic/special ammo flagged for individual tracking.
     */
    static isAmmunition(item) {
        if (!item) return false;
        // dnd5e: consumable with type 'ammo'
        if (item.type === 'consumable' && item.system.type?.value === 'ammo') return true;
        // Also check the ammunition flag override
        if (item.getFlag(FLAG_SCOPE, 'isAmmoDice') === true) return true;
        return false;
    }

    /**
     * Check if this ammo item uses the dice system (vs individual tracking).
     * Magic ammo or items explicitly opted out use individual tracking.
     */
    static usesAmmoDice(item) {
        if (!this.isAmmunition(item)) return false;
        // Explicit opt-out
        if (item.getFlag(FLAG_SCOPE, 'ammoTrackIndividual') === true) return false;
        // Magic items default to individual tracking unless opted in
        if (item.system.rarity && item.system.rarity !== 'common' && item.system.rarity !== '') {
            return item.getFlag(FLAG_SCOPE, 'isAmmoDice') === true;
        }
        return true;
    }

    // ─── Die State ──────────────────────────────────────────────────

    /**
     * Get the current ammo die size for an item.
     * Returns the die denomination (e.g., 12 for d12, 4 for d4, 1 for last shot, 0 for empty).
     */
    static getCurrentDie(item) {
        const die = item.getFlag(FLAG_SCOPE, 'ammoDie');
        if (die != null) return die;
        // Default: use max die (d12 for standard ammo)
        return this.getMaxDie(item);
    }

    /**
     * Get the maximum (full) die size for this ammo type.
     * Default is d12 for standard ammunition.
     */
    static getMaxDie(item) {
        const override = item.getFlag(FLAG_SCOPE, 'ammoMaxDie');
        if (override != null && override > 0) return override;
        return 12; // d12 default
    }

    /**
     * Set the current ammo die.
     */
    static async setCurrentDie(item, value) {
        await item.setFlag(FLAG_SCOPE, 'ammoDie', Math.max(0, value));
    }

    /**
     * Set the max die for this ammo type.
     */
    static async setMaxDie(item, value) {
        await item.setFlag(FLAG_SCOPE, 'ammoMaxDie', value);
    }

    /**
     * Check if the ammo is empty (fully depleted).
     */
    static isEmpty(item) {
        return this.getCurrentDie(item) <= 0;
    }

    /**
     * Check if the ammo is on its last shot.
     */
    static isLastShot(item) {
        return this.getCurrentDie(item) === 1;
    }

    /**
     * Get a display label for the current die.
     * e.g., "d12", "d4", "1 left", "Empty"
     */
    static getDieLabel(item) {
        const die = this.getCurrentDie(item);
        if (die <= 0) return game.i18n.localize('GLINVSLOTS.ammo.empty');
        if (die === 1) return game.i18n.localize('GLINVSLOTS.ammo.lastShot');
        return `d${die}`;
    }

    // ─── Rolling & Degradation ──────────────────────────────────────

    /**
     * Roll the ammo die after using ammunition.
     * On a 1 or 2, the die degrades one step.
     * If at "1" (last shot), using it empties the ammo.
     *
     * @param {Item} item - The ammunition item
     * @param {boolean} announce - Whether to post a chat message
     * @returns {{ rolled: number, degraded: boolean, newDie: number, depleted: boolean, lastShot: boolean }}
     */
    static async rollAmmoDie(item, announce = true) {
        const currentDie = this.getCurrentDie(item);

        // Already empty
        if (currentDie <= 0) {
            return { rolled: 0, degraded: false, newDie: 0, depleted: true, lastShot: false };
        }

        // Last shot — using it empties the ammo
        if (currentDie === 1) {
            await this.setCurrentDie(item, 0);
            if (announce) await this.announceRoll(item, null, true, 0);
            return { rolled: 0, degraded: true, newDie: 0, depleted: true, lastShot: true };
        }

        // Roll the die
        const roll = await new Roll(`1d${currentDie}`).evaluate();
        const result = roll.total;

        let degraded = false;
        let newDie = currentDie;

        if (result <= 2) {
            // Degrade one step
            newDie = this._degradeDie(currentDie);
            degraded = true;
            await this.setCurrentDie(item, newDie);
        }

        if (announce) await this.announceRoll(item, roll, degraded, newDie);

        return {
            rolled: result,
            degraded,
            newDie,
            depleted: newDie <= 0,
            lastShot: newDie === 1
        };
    }

    /**
     * Step a die down one size in the chain.
     * d12 → d10 → d8 → d6 → d4 → 1 (last shot)
     */
    static _degradeDie(currentDie) {
        const idx = AMMO_DIE_CHAIN.indexOf(currentDie);
        if (idx >= 0 && idx < AMMO_DIE_CHAIN.length - 1) {
            return AMMO_DIE_CHAIN[idx + 1];
        }
        // At d4 (last in chain) → go to 1 (last shot)
        if (currentDie === AMMO_DIE_CHAIN[AMMO_DIE_CHAIN.length - 1]) {
            return 1;
        }
        // Unknown die or already at 1
        return currentDie <= 1 ? 0 : 1;
    }

    // ─── Replenishment ──────────────────────────────────────────────

    /**
     * Replenish the ammo die by one step (e.g., d8 → d10).
     * Returns the cost to do so.
     */
    static async replenishDie(item) {
        const currentDie = this.getCurrentDie(item);
        const maxDie = this.getMaxDie(item);

        if (currentDie >= maxDie) return { cost: 0, newDie: currentDie, alreadyFull: true };

        // Step up one
        const newDie = this._replenishDie(currentDie);
        const cost = this.getReplenishCost(item, newDie);

        await this.setCurrentDie(item, Math.min(newDie, maxDie));
        return { cost, newDie: Math.min(newDie, maxDie), alreadyFull: false };
    }

    /**
     * Fully replenish the ammo die to max.
     * Returns the total cost.
     */
    static async fullReplenish(item) {
        const currentDie = this.getCurrentDie(item);
        const maxDie = this.getMaxDie(item);

        if (currentDie >= maxDie) return { cost: 0, steps: 0, alreadyFull: true };

        let totalCost = 0;
        let die = currentDie;
        let steps = 0;

        while (die < maxDie) {
            const nextDie = this._replenishDie(die);
            totalCost += this.getReplenishCost(item, nextDie);
            die = Math.min(nextDie, maxDie);
            steps++;
        }

        await this.setCurrentDie(item, maxDie);
        return { cost: totalCost, steps, alreadyFull: false };
    }

    /**
     * Step a die up one size.
     * 0 → 1 → d4 → d6 → d8 → d10 → d12 → d20
     */
    static _replenishDie(currentDie) {
        if (currentDie <= 0) return 1;
        if (currentDie === 1) return AMMO_DIE_CHAIN[AMMO_DIE_CHAIN.length - 1]; // → d4

        const idx = AMMO_DIE_CHAIN.indexOf(currentDie);
        if (idx > 0) return AMMO_DIE_CHAIN[idx - 1];
        if (idx === 0) return currentDie; // Already at max of chain
        return currentDie; // Unknown
    }

    /**
     * Get the cost to replenish one step to a given die size.
     * Cost is a percentage of the ammo's base price.
     */
    static getReplenishCost(item, targetDie) {
        const basePrice = item.system.price?.value ?? 0;
        const percent = AMMO_REPLENISH_COST[targetDie] ?? 0.20;
        return Math.max(0, Math.round(basePrice * percent * 100) / 100);
    }

    /**
     * Get the total cost to fully replenish from current die to max.
     */
    static getTotalReplenishCost(item) {
        const currentDie = this.getCurrentDie(item);
        const maxDie = this.getMaxDie(item);

        if (currentDie >= maxDie) return 0;

        let totalCost = 0;
        let die = currentDie;

        while (die < maxDie) {
            const nextDie = this._replenishDie(die);
            totalCost += this.getReplenishCost(item, nextDie);
            die = Math.min(nextDie, maxDie);
        }

        return totalCost;
    }

    // ─── Reset ──────────────────────────────────────────────────────

    /**
     * Reset ammo die to full (max die).
     */
    static async resetToFull(item) {
        const maxDie = this.getMaxDie(item);
        await this.setCurrentDie(item, maxDie);
    }

    // ─── Chat Messages ──────────────────────────────────────────────

    /**
     * Announce an ammo die roll in chat.
     */
    static async announceRoll(item, roll, degraded, newDie) {
        const actor = item.parent;

        let content = `<div class="glinv-ammo-chat">`;
        content += `<strong>${item.name}</strong>`;

        if (roll) {
            content += ` — ${game.i18n.localize('GLINVSLOTS.ammo.rolled')}: <strong>${roll.total}</strong> `;
            content += `(d${roll.dice[0]?.faces || '?'})`;

            if (degraded) {
                if (newDie === 1) {
                    content += `<br><span class="glinv-ammo-warning">${game.i18n.localize('GLINVSLOTS.ammo.degradedToLast')}</span>`;
                } else if (newDie <= 0) {
                    content += `<br><span class="glinv-ammo-depleted">${game.i18n.localize('GLINVSLOTS.ammo.depleted')}</span>`;
                } else {
                    content += `<br><span class="glinv-ammo-degraded">${game.i18n.localize('GLINVSLOTS.ammo.degraded')}: d${newDie}</span>`;
                }
            } else {
                content += `<br><small>${game.i18n.localize('GLINVSLOTS.ammo.noChange')}</small>`;
            }
        } else {
            // Last shot used
            content += `<br><span class="glinv-ammo-depleted">${game.i18n.localize('GLINVSLOTS.ammo.lastShotUsed')}</span>`;
        }

        content += `</div>`;

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content,
            flavor: `<i class="fas fa-bullseye"></i> ${game.i18n.localize('GLINVSLOTS.ammo.ammunitionDice')}`,
        });
    }

    // ─── Summary ────────────────────────────────────────────────────

    /**
     * Get a complete ammo dice summary for display.
     */
    static getAmmoSummary(item) {
        if (!this.usesAmmoDice(item)) return null;

        const currentDie = this.getCurrentDie(item);
        const maxDie = this.getMaxDie(item);
        const isEmpty = this.isEmpty(item);
        const isLastShot = this.isLastShot(item);
        const label = this.getDieLabel(item);
        const replenishCost = this.getTotalReplenishCost(item);

        return {
            currentDie,
            maxDie,
            isEmpty,
            isLastShot,
            label,
            replenishCost
        };
    }
}
