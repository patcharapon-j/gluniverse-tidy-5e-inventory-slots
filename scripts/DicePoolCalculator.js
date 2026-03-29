import { MODULE_ID, FLAG_SCOPE, DICE_POOL_DEFAULTS, getSetting } from './settings.js';

/**
 * Calculation engine for the Dice Pool system.
 *
 * A dice pool is a group of dice (default d6). When rolled, any die showing
 * at or below the discard threshold (default 1-2) is removed from the pool.
 * When the pool is empty the item becomes useless/depleted.
 *
 * GMs can configure the die type and discard threshold per item.
 */
export class DicePoolCalculator {

    // ─── Detection ──────────────────────────────────────────────────

    /**
     * Check if an item uses the dice pool system.
     */
    static usesDicePool(item) {
        if (!item) return false;
        return item.getFlag(FLAG_SCOPE, 'hasDicePool') === true;
    }

    // ─── Pool State ─────────────────────────────────────────────────

    /**
     * Get the current number of dice in the pool.
     */
    static getPoolSize(item) {
        const size = item.getFlag(FLAG_SCOPE, 'poolSize');
        if (size != null) return Math.max(0, size);
        return this.getMaxPoolSize(item);
    }

    /**
     * Get the maximum (full) pool size.
     */
    static getMaxPoolSize(item) {
        const override = item.getFlag(FLAG_SCOPE, 'poolMaxSize');
        if (override != null && override > 0) return override;
        return DICE_POOL_DEFAULTS.defaultPoolSize;
    }

    /**
     * Get the die type for this pool (e.g. 6 for d6, 8 for d8).
     */
    static getDieType(item) {
        const override = item.getFlag(FLAG_SCOPE, 'poolDieType');
        if (override != null && override > 0) return override;
        return DICE_POOL_DEFAULTS.defaultDieType;
    }

    /**
     * Get the discard threshold — dice showing this value or below are removed.
     */
    static getDiscardThreshold(item) {
        const override = item.getFlag(FLAG_SCOPE, 'poolDiscardThreshold');
        if (override != null && override > 0) return override;
        return DICE_POOL_DEFAULTS.defaultDiscardThreshold;
    }

    /**
     * Check if the pool is depleted (empty).
     */
    static isDepleted(item) {
        return this.getPoolSize(item) <= 0;
    }

    // ─── State Setters ──────────────────────────────────────────────

    static async setPoolSize(item, value) {
        await item.setFlag(FLAG_SCOPE, 'poolSize', Math.max(0, value));
    }

    static async setMaxPoolSize(item, value) {
        await item.setFlag(FLAG_SCOPE, 'poolMaxSize', Math.max(1, value));
    }

    static async setDieType(item, value) {
        await item.setFlag(FLAG_SCOPE, 'poolDieType', value);
    }

    static async setDiscardThreshold(item, value) {
        await item.setFlag(FLAG_SCOPE, 'poolDiscardThreshold', Math.max(1, value));
    }

    static async enableDicePool(item, enabled) {
        await item.setFlag(FLAG_SCOPE, 'hasDicePool', enabled);
        // Initialize pool if enabling for the first time
        if (enabled && item.getFlag(FLAG_SCOPE, 'poolSize') == null) {
            await item.setFlag(FLAG_SCOPE, 'poolSize', this.getMaxPoolSize(item));
        }
    }

    // ─── Rolling ────────────────────────────────────────────────────

    /**
     * Roll the entire dice pool.
     * Each die at or below the discard threshold is removed.
     *
     * @param {Item} item - The item with a dice pool
     * @param {boolean} announce - Whether to post a chat message
     * @returns {{ results: number[], kept: number[], discarded: number[], newSize: number, depleted: boolean }}
     */
    static async rollPool(item, announce = true) {
        const poolSize = this.getPoolSize(item);
        const dieType = this.getDieType(item);
        const threshold = this.getDiscardThreshold(item);

        if (poolSize <= 0) {
            return { results: [], kept: [], discarded: [], newSize: 0, depleted: true };
        }

        // Roll all dice in the pool
        const formula = `${poolSize}d${dieType}`;
        const roll = await new Roll(formula).evaluate();

        // Trigger Dice So Nice if available
        if (game.dice3d) {
            await game.dice3d.showForRoll(roll, game.user, true);
        }

        const results = roll.dice[0]?.results?.map(r => r.result) ?? [];
        const kept = [];
        const discarded = [];

        for (const val of results) {
            if (val <= threshold) {
                discarded.push(val);
            } else {
                kept.push(val);
            }
        }

        const newSize = kept.length;
        await this.setPoolSize(item, newSize);

        if (announce) await this.announceRoll(item, roll, results, kept, discarded, newSize);

        return {
            results,
            kept,
            discarded,
            newSize,
            depleted: newSize <= 0
        };
    }

    // ─── Pool Management ────────────────────────────────────────────

    /**
     * Add dice to the pool (up to max).
     * @param {Item} item
     * @param {number} count - Number of dice to add
     */
    static async addDice(item, count = 1) {
        const current = this.getPoolSize(item);
        const max = this.getMaxPoolSize(item);
        const newSize = Math.min(current + count, max);
        await this.setPoolSize(item, newSize);
        return { newSize, added: newSize - current };
    }

    /**
     * Remove dice from the pool.
     * @param {Item} item
     * @param {number} count - Number of dice to remove
     */
    static async removeDice(item, count = 1) {
        const current = this.getPoolSize(item);
        const newSize = Math.max(0, current - count);
        await this.setPoolSize(item, newSize);
        return { newSize, removed: current - newSize };
    }

    /**
     * Refill pool to max.
     */
    static async refillPool(item) {
        const max = this.getMaxPoolSize(item);
        await this.setPoolSize(item, max);
        return max;
    }

    // ─── Display ────────────────────────────────────────────────────

    /**
     * Get a display label for the pool state.
     */
    static getPoolLabel(item) {
        const size = this.getPoolSize(item);
        const dieType = this.getDieType(item);
        if (size <= 0) return game.i18n.localize('GLINVSLOTS.pool.depleted');
        return `${size}d${dieType}`;
    }

    /**
     * Get a complete pool summary for display.
     */
    static getPoolSummary(item) {
        if (!this.usesDicePool(item)) return null;

        const poolSize = this.getPoolSize(item);
        const maxSize = this.getMaxPoolSize(item);
        const dieType = this.getDieType(item);
        const threshold = this.getDiscardThreshold(item);
        const depleted = this.isDepleted(item);
        const label = this.getPoolLabel(item);

        return {
            poolSize,
            maxSize,
            dieType,
            threshold,
            depleted,
            label
        };
    }

    // ─── Chat Messages ──────────────────────────────────────────────

    /**
     * Announce a dice pool roll in chat.
     */
    static async announceRoll(item, roll, results, kept, discarded, newSize) {
        const actor = item.parent;
        const dieType = this.getDieType(item);
        const threshold = this.getDiscardThreshold(item);
        const maxSize = this.getMaxPoolSize(item);

        let content = `<div class="glinv-pool-chat">`;
        content += `<strong>${item.name}</strong>`;
        content += `<div class="glinv-pool-chat-formula">${results.length}d${dieType}</div>`;

        // Show each die result with visual styling
        content += `<div class="glinv-pool-chat-dice">`;
        for (const val of results) {
            const isDiscarded = val <= threshold;
            const cls = isDiscarded ? 'glinv-pool-chat-die glinv-pool-chat-die-discarded' : 'glinv-pool-chat-die glinv-pool-chat-die-kept';
            content += `<span class="${cls}">${val}</span>`;
        }
        content += `</div>`;

        // Summary
        if (discarded.length > 0) {
            content += `<div class="glinv-pool-chat-summary">`;
            content += `<span class="glinv-pool-chat-lost"><i class="fas fa-minus-circle"></i> ${discarded.length} ${game.i18n.localize('GLINVSLOTS.pool.diceLost')}</span>`;
            content += `</div>`;
        } else {
            content += `<div class="glinv-pool-chat-summary">`;
            content += `<span class="glinv-pool-chat-safe"><i class="fas fa-shield-alt"></i> ${game.i18n.localize('GLINVSLOTS.pool.noDiceLost')}</span>`;
            content += `</div>`;
        }

        // Pool state
        content += `<div class="glinv-pool-chat-state">`;
        if (newSize <= 0) {
            content += `<span class="glinv-pool-chat-depleted"><i class="fas fa-skull"></i> ${game.i18n.localize('GLINVSLOTS.pool.itemDepleted')}</span>`;
        } else {
            content += `<span>${game.i18n.localize('GLINVSLOTS.pool.remaining')}: <strong>${newSize}</strong> / ${maxSize}</span>`;
        }
        content += `</div>`;

        content += `</div>`;

        await ChatMessage.create({
            speaker: ChatMessage.getSpeaker({ actor }),
            content,
            flavor: `<i class="fas fa-cubes"></i> ${game.i18n.localize('GLINVSLOTS.pool.dicePool')}`,
        });
    }
}
