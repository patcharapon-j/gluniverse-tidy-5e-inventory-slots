import {
    MODULE_ID, FLAG_SCOPE, BULK_CATEGORIES, BULK_ORDER,
    CREATURE_SLOT_TABLE, OBJECT_SCALE_SHIFTS, ARMOR_BULK_TABLE,
    VEHICLE_SLOTS, getSetting
} from './settings.js';

/**
 * Core calculation engine for the inventory slot/bulk system.
 * Implements Giffyglyph's Darker Dungeons Active Inventory rules.
 */
export class SlotCalculator {

    // ─── Inventory Slot Capacity ─────────────────────────────────────

    /**
     * Calculate total inventory slots for a creature.
     * @param {Actor} actor - The FoundryVTT actor
     * @returns {number} Total inventory slots
     */
    static getMaxSlots(actor) {
        const breakdown = this.getSlotBreakdown(actor);
        return breakdown.total;
    }

    /**
     * Get a detailed breakdown of how max slots are calculated.
     * @param {Actor} actor
     * @returns {Object} Breakdown with all contributing factors
     */
    static getSlotBreakdown(actor) {
        const override = actor.getFlag(FLAG_SCOPE, 'maxSlotsOverride');
        if (override != null && override > 0) {
            return {
                total: override,
                isOverridden: true,
                overrideValue: override
            };
        }

        // Size: check for per-actor override first
        const sizeOverride = actor.getFlag(FLAG_SCOPE, 'sizeOverride');
        const size = sizeOverride || actor.system.traits?.size || 'med';
        const entry = CREATURE_SLOT_TABLE[size] || CREATURE_SLOT_TABLE.med;

        const strMod = actor.system.abilities?.str?.mod ?? 0;
        const conMod = actor.system.abilities?.con?.mod ?? 0;
        const packEndurance = getSetting('enablePackEndurance');

        let usedMod = strMod;
        let usedAbility = 'STR';
        if (packEndurance && conMod > strMod) {
            usedMod = conMod;
            usedAbility = 'CON';
        }

        const modContribution = usedMod * entry.strMult;
        const total = Math.max(0, entry.base + modContribution);

        return {
            total,
            isOverridden: false,
            size,
            sizeLabel: size.charAt(0).toUpperCase() + size.slice(1),
            sizeOverridden: !!sizeOverride,
            baseSlots: entry.base,
            strMod,
            conMod,
            usedMod,
            usedAbility,
            strMult: entry.strMult,
            modContribution,
            packEndurance
        };
    }

    /**
     * Get the encumbrance threshold (max slots before fully overburdened).
     * Cannot exceed max slots + floor(max slots / 2).
     */
    static getOverburdenedThreshold(actor) {
        const max = this.getMaxSlots(actor);
        return max + Math.floor(max / 2);
    }

    /**
     * Get the minimum bulk for this creature size.
     */
    static getMinimumBulk(actor) {
        const size = actor.system.traits?.size || 'med';
        const entry = CREATURE_SLOT_TABLE[size] || CREATURE_SLOT_TABLE.med;
        return entry.minBulk;
    }

    // ─── Item Bulk Calculation ───────────────────────────────────────

    /**
     * Get the bulk value for a single item (not counting quantity).
     * @param {Item} item - The FoundryVTT item
     * @param {Actor} [ownerActor] - The owning actor (for object scaling)
     * @returns {number} Bulk value per unit
     */
    static getItemBulk(item, ownerActor = null) {
        // Check for explicit bulk override on the item
        const bulkOverride = item.getFlag(FLAG_SCOPE, 'bulkOverride');
        if (bulkOverride != null && bulkOverride >= 0) return bulkOverride;

        // Check for explicit bulk category set on the item
        const bulkCategory = item.getFlag(FLAG_SCOPE, 'bulkCategory');
        if (bulkCategory && BULK_CATEGORIES[bulkCategory]) {
            let bulk = BULK_CATEGORIES[bulkCategory].value;

            // Apply object scaling if enabled
            if (getSetting('enableObjectScaling') && ownerActor) {
                bulk = this._applyObjectScaling(bulk, bulkCategory, item, ownerActor);
            }

            return bulk;
        }

        // Auto-calculate from weight if enabled
        if (getSetting('autoBulkFromWeight')) {
            return this._bulkFromWeight(item, ownerActor);
        }

        // Default: 1 bulk (small item)
        return 1;
    }

    /**
     * Get total bulk for an item stack (bulk × quantity).
     */
    static getItemTotalBulk(item, ownerActor = null) {
        const perUnit = this.getItemBulk(item, ownerActor);
        const qty = item.system.quantity ?? 1;

        // Tiny items: 5 tiny items = 1 slot (0.2 bulk each)
        return perUnit * qty;
    }

    /**
     * Derive bulk category from item weight.
     */
    static _bulkFromWeight(item, ownerActor = null) {
        const weight = item.system.weight?.value ?? item.system.weight ?? 0;

        let category;
        if (weight <= 0) category = 'TINY';
        else if (weight <= 2) category = 'SMALL';
        else if (weight <= 5) category = 'MEDIUM';
        else if (weight <= 10) category = 'LARGE';
        else if (weight <= 35) category = 'XLARGE';
        else category = 'XXLARGE';

        let bulk = BULK_CATEGORIES[category].value;

        // Apply object scaling
        if (getSetting('enableObjectScaling') && ownerActor) {
            bulk = this._applyObjectScaling(bulk, category, item, ownerActor);
        }

        return bulk;
    }

    /**
     * Apply object scaling based on the item's size relative to the creature's size.
     */
    static _applyObjectScaling(bulk, categoryKey, item, ownerActor) {
        const itemScale = item.getFlag(FLAG_SCOPE, 'objectScale');
        if (!itemScale || itemScale === 'med') return bulk;

        const shift = OBJECT_SCALE_SHIFTS[itemScale] || 0;
        if (shift === 0) return bulk;

        const currentIndex = BULK_ORDER.indexOf(categoryKey);
        if (currentIndex === -1) return bulk;

        const newIndex = Math.max(0, Math.min(BULK_ORDER.length - 1, currentIndex + shift));
        return BULK_CATEGORIES[BULK_ORDER[newIndex]].value;
    }

    // ─── Armor Bulk ──────────────────────────────────────────────────

    /**
     * Get the bulk for an armor item, using the armor bulk table if enabled.
     */
    static getArmorBulk(item, ownerActor = null) {
        if (!getSetting('enableArmorSlotCost')) {
            return this.getItemBulk(item, ownerActor);
        }

        const size = ownerActor?.system.traits?.size || 'med';
        const armorType = this._getArmorCategory(item);

        if (armorType && ARMOR_BULK_TABLE[size]) {
            return ARMOR_BULK_TABLE[size][armorType] ?? this.getItemBulk(item, ownerActor);
        }

        return this.getItemBulk(item, ownerActor);
    }

    /**
     * Determine armor category from item data.
     */
    static _getArmorCategory(item) {
        if (item.type !== 'equipment') return null;

        const armorType = item.system.type?.value || item.system.armor?.type;
        if (!armorType) return null;

        if (armorType === 'shield') return 'shield';
        if (['light'].includes(armorType)) return 'light';
        if (['medium'].includes(armorType)) return 'medium';
        if (['heavy'].includes(armorType)) return 'heavy';
        return null;
    }

    // ─── Container Calculations ──────────────────────────────────────

    /**
     * Calculate container internal slots (equal to its bulk rating).
     */
    static getContainerSlots(item) {
        if (!getSetting('enableContainerRules')) {
            return Infinity; // No limit when container rules disabled
        }

        const override = item.getFlag(FLAG_SCOPE, 'containerSlotsOverride');
        if (override != null && override >= 0) return override;

        // Magical containers have special slot counts
        const magicSlots = item.getFlag(FLAG_SCOPE, 'magicContainerSlots');
        if (magicSlots != null && magicSlots > 0) return magicSlots;

        // Normal container: slots = bulk value
        return this.getItemBulk(item);
    }

    /**
     * Calculate how many slots are used inside a container.
     */
    static getContainerUsedSlots(containerItem, allItems) {
        const containedItems = allItems.filter(i =>
            i.system.container === containerItem.id ||
            i.system.container === containerItem._id
        );

        let used = 0;
        for (const item of containedItems) {
            used += this.getItemTotalBulk(item);
        }
        return used;
    }

    // ─── Basic Supplies ──────────────────────────────────────────────

    /**
     * Check if an item qualifies as a free basic supply.
     * Basic supplies: 1 ration box (5 rations), 1 waterskin (5 drinks), 1 purse (100 coins).
     */
    static isBasicSupply(item) {
        if (!getSetting('enableBasicSupplies')) return false;
        return item.getFlag(FLAG_SCOPE, 'isBasicSupply') === true;
    }

    // ─── Quickdraw ───────────────────────────────────────────────────

    /**
     * Check if an item is marked as quickdraw.
     */
    static isQuickdraw(item) {
        if (!getSetting('enableQuickdraw')) return false;
        return item.getFlag(FLAG_SCOPE, 'quickdraw') === true;
    }

    /**
     * Count how many quickdraw items an actor has.
     */
    static getQuickdrawCount(actor) {
        const items = actor.items?.contents ?? [];
        return items.filter(i => i.getFlag(FLAG_SCOPE, 'quickdraw') === true).length;
    }

    /**
     * Get max quickdraw slots.
     */
    static getMaxQuickdrawSlots() {
        return getSetting('quickdrawSlots');
    }

    // ─── Full Inventory Calculation ──────────────────────────────────

    /**
     * Calculate complete inventory slot usage for an actor.
     * @param {Actor} actor
     * @returns {Object} Inventory summary
     */
    static calculateInventory(actor) {
        const items = actor.items?.contents ?? [];
        const maxSlots = this.getMaxSlots(actor);
        const overburdenedMax = this.getOverburdenedThreshold(actor);

        let totalBulk = 0;
        let quickdrawCount = 0;
        const itemDetails = [];

        for (const item of items) {
            // Skip non-physical items
            if (!this._isPhysicalItem(item)) continue;

            // Skip items inside containers (they count toward the container)
            if (item.system.container) continue;

            const isBasic = this.isBasicSupply(item);
            const isQuickdraw = this.isQuickdraw(item);

            let bulk;
            if (isBasic) {
                bulk = 0;
            } else if (this._isArmor(item)) {
                bulk = this.getArmorBulk(item, actor) * (item.system.quantity ?? 1);
            } else if (this._isContainer(item)) {
                // Container bulk = its own bulk (contents are inside)
                bulk = this.getItemBulk(item, actor);
            } else {
                bulk = this.getItemTotalBulk(item, actor);
            }

            if (isQuickdraw) quickdrawCount++;

            totalBulk += bulk;
            itemDetails.push({
                item,
                bulk: Math.round(bulk * 100) / 100,
                isBasicSupply: isBasic,
                isQuickdraw,
                isContainer: this._isContainer(item),
                isArmor: this._isArmor(item)
            });
        }

        // Round total bulk
        totalBulk = Math.round(totalBulk * 100) / 100;

        // Determine encumbrance state
        const slotsUsed = Math.ceil(totalBulk);
        let encumbranceState = 'normal';
        if (slotsUsed > overburdenedMax) {
            encumbranceState = 'overburdened'; // Cannot move
        } else if (slotsUsed > maxSlots) {
            encumbranceState = 'encumbered'; // Speed halved, disadvantage
        }

        // Percentage for bar display
        const percentage = maxSlots > 0 ? Math.min((slotsUsed / maxSlots) * 100, 150) : 0;

        return {
            maxSlots,
            overburdenedMax,
            slotsUsed,
            totalBulk,
            percentage,
            encumbranceState,
            quickdrawCount,
            maxQuickdraw: getSetting('enableQuickdraw') ? this.getMaxQuickdrawSlots() : 0,
            itemDetails
        };
    }

    // ─── Helpers ─────────────────────────────────────────────────────

    static _isPhysicalItem(item) {
        const physicalTypes = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container', 'backpack'];
        return physicalTypes.includes(item.type);
    }

    static _isContainer(item) {
        return item.type === 'container' || item.type === 'backpack';
    }

    static _isArmor(item) {
        if (item.type !== 'equipment') return false;
        const armorType = item.system.type?.value || item.system.armor?.type;
        return ['light', 'medium', 'heavy', 'shield'].includes(armorType);
    }

    /**
     * Get a human-readable bulk category name for a given bulk value.
     */
    static getBulkCategoryLabel(bulkValue) {
        if (bulkValue <= 0.2) return 'GLINVSLOTS.bulk.tiny';
        if (bulkValue <= 1) return 'GLINVSLOTS.bulk.small';
        if (bulkValue <= 2) return 'GLINVSLOTS.bulk.medium';
        if (bulkValue <= 3) return 'GLINVSLOTS.bulk.large';
        if (bulkValue <= 6) return 'GLINVSLOTS.bulk.xlarge';
        if (bulkValue <= 9) return 'GLINVSLOTS.bulk.xxlarge';
        return 'GLINVSLOTS.bulk.massive';
    }

    /**
     * Get the inferred bulk category key from weight.
     */
    static inferBulkCategory(weight) {
        if (weight <= 0) return 'TINY';
        if (weight <= 2) return 'SMALL';
        if (weight <= 5) return 'MEDIUM';
        if (weight <= 10) return 'LARGE';
        if (weight <= 35) return 'XLARGE';
        return 'XXLARGE';
    }
}
