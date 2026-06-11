import { MODULE_ID, FLAG_SCOPE, BULK_CATEGORIES, BULK_ORDER, TEMPER_GRADES, FRAGILITY, AMMO_DIE_CHAIN, DICE_POOL_DEFAULTS, DICE_POOL_DIE_TYPES, getSetting, unwrapElement } from './settings.js';
import { SlotCalculator } from './SlotCalculator.js';
import { NotchCalculator } from './NotchCalculator.js';
import { AmmoDiceCalculator } from './AmmoDiceCalculator.js';
import { DicePoolCalculator } from './DicePoolCalculator.js';

/**
 * Handles all integration points with the Tidy 5e Sheet module.
 *
 * v3 architecture: registers inline content through the Tidy 5e v13 API
 * (`register*Content` with `renderScheme: 'handlebars'`), so our UI lives
 * inside the sheet and is re-applied automatically across Svelte re-renders.
 * No floating panels, no requestAnimationFrame loop, no MutationObserver.
 */
export class TidyIntegration {

    static _api = null;

    /**
     * Selector inside the inventory tab that our slot panel is injected after.
     * Tidy 5e renders a `.encumbrance` meter on the character inventory tab; we
     * anchor to it so the panel sits directly beneath the (replaced) bar.
     *
     * ── VERIFY IN-APP ── If the panel does not appear, this is the one knob to
     * adjust: set it to a selector that exists on the open inventory tab (e.g.
     * `[data-tidy-sheet-part="item-table"]` with position 'beforebegin').
     */
    static ACTOR_ANCHOR = { selector: '.encumbrance', position: 'afterend' };

    static init(api) {
        this._api = api;
        console.log(`${MODULE_ID} | Tidy 5e API received — registering inline content (v3 architecture)`);
        this._registerContent();
    }

    // ─── Registration-API Integration (Quadrone + Classic) ───────────
    //
    // As of Tidy 5e v13, `register*Content` fans out to BOTH the Classic and
    // Quadrone runtimes and, with `renderScheme: 'handlebars'`, automatically
    // re-injects across Svelte re-renders. This replaces the old floating-panel
    // + requestAnimationFrame + body-wide MutationObserver machinery entirely:
    // content lives *inside* the sheet, scrolls and drags with it, and never
    // leaks listeners (each render hands us fresh nodes).

    static _registerContent() {
        const api = this._api;
        if (!api?.models?.HtmlContent) {
            console.error(`${MODULE_ID} | Tidy 5e HtmlContent model unavailable — is tidy5e-sheet up to date (v13+)?`);
            return;
        }
        const { HtmlContent } = api.models;

        // — Actor: slot panel + per-row badges, injected into the inventory tab.
        const actorContent = () => new HtmlContent({
            html: () => `<div class="glinv-scope glinv-actor-root" data-tidy-render-scheme="handlebars"></div>`,
            renderScheme: 'handlebars',
            injectParams: this.ACTOR_ANCHOR,
            enabled: () => this._anyFeatureEnabled(),
            onRender: (params) => this._onActorRender(params),
        });
        try {
            api.registerCharacterContent(actorContent(), { layout: 'all' });
            api.registerNpcContent(actorContent(), { layout: 'all' });
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to register actor content:`, err);
        }

        // — Item: configuration as a dedicated sheet tab. A registered tab is the
        //   reliable Quadrone injection point (a content block with no anchor has
        //   nowhere to render), and gives users a discoverable "Active Inventory"
        //   tab on physical item sheets.
        const PHYSICAL_ITEM_TYPES = ['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container', 'backpack'];
        const HtmlTab = api.models.HtmlTab;
        if (HtmlTab && typeof api.registerItemTab === 'function') {
            const itemTab = new HtmlTab({
                title: () => game.i18n.localize('GLINVSLOTS.itemConfig'),
                tabId: 'gluniverse-active-inventory',
                iconClass: 'fas fa-box-open',
                html: () => `<div class="glinv-scope glinv-item-root" data-tidy-render-scheme="handlebars"></div>`,
                renderScheme: 'handlebars',
                enabled: () => this._anyFeatureEnabled(),
                onRender: (params) => this._onItemRender(params),
            });
            try {
                api.registerItemTab(itemTab, { layout: 'all', autoHeight: true, types: PHYSICAL_ITEM_TYPES });
            } catch (err) {
                console.error(`${MODULE_ID} | Failed to register item tab:`, err);
            }
        } else {
            // Fallback for older Tidy: inject into the item sheet body.
            const itemContent = () => new HtmlContent({
                html: () => `<div class="glinv-scope glinv-item-root" data-tidy-render-scheme="handlebars"></div>`,
                renderScheme: 'handlebars',
                enabled: () => this._anyFeatureEnabled(),
                onRender: (params) => this._onItemRender(params),
            });
            try {
                api.registerItemContent(itemContent(), { layout: 'all' });
            } catch (err) {
                console.error(`${MODULE_ID} | Failed to register item content:`, err);
            }
        }

        // — Header readout chip: a compact used/max slots badge in the title bar,
        //   anchored to the (always-present) name container used by Tidy's own
        //   official example. Mirrors the clocks-and-tracker compact readout.
        const partName = api.constants?.SHEET_PARTS?.NAME_CONTAINER || 'name-container';
        const headerChip = () => new HtmlContent({
            html: () => `<span class="glinv-scope glinv-header-chip-root" data-tidy-render-scheme="handlebars"></span>`,
            renderScheme: 'handlebars',
            injectParams: { selector: `[data-tidy-sheet-part="${partName}"]`, position: 'beforebegin' },
            enabled: () => getSetting('enableSlotSystem'),
            onRender: (params) => this._onHeaderChipRender(params),
        });
        try {
            api.registerCharacterContent(headerChip(), { layout: 'all' });
            api.registerNpcContent(headerChip(), { layout: 'all' });
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to register header chip:`, err);
        }

        // — Native quick-action buttons in the inventory item-row summary.
        this._registerItemSummaryCommands();
    }

    /** Map<actorId, number> — last seen slotsUsed, for the ±N float animation. */
    static _slotCache = new Map();

    /**
     * Register tactile quick-action buttons that Tidy renders inside the item
     * summary expansion (and info card) on inventory rows. Feature-detected so
     * older Tidy builds without the itemSummary API simply skip these.
     */
    static _registerItemSummaryCommands() {
        const api = this._api;
        const register = api?.config?.itemSummary?.registerCommands;
        if (typeof register !== 'function') {
            console.log(`${MODULE_ID} | itemSummary.registerCommands unavailable — skipping row quick-actions`);
            return;
        }

        const L = (k) => game.i18n.localize(k);
        const physical = (item) => { try { return SlotCalculator._isPhysicalItem(item); } catch { return false; } };

        const commands = [
            // Ammunition dice
            {
                label: L('GLINVSLOTS.ammo.rollAmmo'),
                iconClass: 'fas fa-dice',
                enabled: ({ item }) => getSetting('enableAmmunitionDice')
                    && AmmoDiceCalculator.usesAmmoDice(item) && !AmmoDiceCalculator.isEmpty(item),
                execute: async ({ item }) => { await AmmoDiceCalculator.rollAmmoDie(item, true); },
            },
            {
                label: L('GLINVSLOTS.ammo.replenishFull'),
                iconClass: 'fas fa-arrows-rotate',
                enabled: ({ item }) => getSetting('enableAmmunitionDice')
                    && AmmoDiceCalculator.usesAmmoDice(item)
                    && AmmoDiceCalculator.getCurrentDie(item) < AmmoDiceCalculator.getMaxDie(item),
                execute: async ({ item }) => {
                    const r = await AmmoDiceCalculator.fullReplenish(item);
                    if (!r.alreadyFull) ui.notifications.info(`${item.name}: ${L('GLINVSLOTS.ammo.replenishFull')} (${r.cost} gp)`);
                },
            },
            // Dice pool
            {
                label: L('GLINVSLOTS.pool.rollPool'),
                iconClass: 'fas fa-cubes',
                enabled: ({ item }) => getSetting('enableDicePool')
                    && DicePoolCalculator.usesDicePool(item) && !DicePoolCalculator.isDepleted(item),
                execute: async ({ item }) => {
                    const r = await DicePoolCalculator.rollPool(item, true);
                    if (r.depleted) ui.notifications.warn(`${item.name}: ${L('GLINVSLOTS.pool.itemDepleted')}`);
                },
            },
            {
                label: L('GLINVSLOTS.pool.refill'),
                iconClass: 'fas fa-arrows-rotate',
                enabled: ({ item }) => getSetting('enableDicePool')
                    && DicePoolCalculator.usesDicePool(item)
                    && DicePoolCalculator.getPoolSize(item) < DicePoolCalculator.getMaxPoolSize(item),
                execute: async ({ item }) => { await DicePoolCalculator.refillPool(item); },
            },
            // Wear & tear
            {
                label: L('GLINVSLOTS.notch.addNotch'),
                iconClass: 'fas fa-hammer',
                enabled: ({ item }) => getSetting('enableWearAndTear') && physical(item),
                execute: async ({ item }) => {
                    const r = await NotchCalculator.addNotch(item);
                    await NotchCalculator.announceNotch(item, item.parent, L('GLINVSLOTS.notch.addNotch'));
                    if (r.shattered) ui.notifications.warn(`${item.name} ${L('GLINVSLOTS.notch.shattered')}!`);
                },
            },
            {
                label: L('GLINVSLOTS.notch.removeNotch'),
                iconClass: 'fas fa-wrench',
                enabled: ({ item }) => getSetting('enableWearAndTear')
                    && NotchCalculator.getEffectiveNotches(item) > 0,
                execute: async ({ item }) => { await NotchCalculator.removeNotch(item, 1); },
            },
            // Quickdraw toggle
            {
                label: L('GLINVSLOTS.quickdraw'),
                iconClass: 'fas fa-bolt',
                enabled: ({ item }) => getSetting('enableSlotSystem') && getSetting('enableQuickdraw') && physical(item),
                execute: async ({ item }) => {
                    const isQd = item.getFlag(FLAG_SCOPE, 'quickdraw') || false;
                    if (!isQd) {
                        const count = SlotCalculator.getQuickdrawCount(item.parent);
                        const max = SlotCalculator.getMaxQuickdrawSlots();
                        if (count >= max) { ui.notifications.warn(game.i18n.format('GLINVSLOTS.quickdrawFull', { max })); return; }
                    }
                    await item.setFlag(FLAG_SCOPE, 'quickdraw', !isQd);
                },
            },
        ];

        try {
            register.call(api.config.itemSummary, commands);
        } catch (err) {
            console.error(`${MODULE_ID} | Failed to register item-summary commands:`, err);
        }
    }

    static _onHeaderChipRender(params) {
        const actor = params.app?.document;
        const root = params.element?.classList?.contains('glinv-header-chip-root')
            ? params.element
            : params.element?.querySelector?.('.glinv-header-chip-root');
        if (!actor || actor.documentName !== 'Actor' || !root) return;
        if (actor.type === 'npc' && !getSetting('enableForNPCs')) { root.remove(); return; }
        if (actor.type !== 'character' && actor.type !== 'npc') { root.remove(); return; }

        try {
            const inv = SlotCalculator.calculateInventory(actor);
            const { slotsUsed, maxSlots, encumbranceState } = inv;
            const stateClass = encumbranceState === 'overburdened' ? 'glinv-overburdened'
                : encumbranceState === 'encumbered' ? 'glinv-encumbered'
                : slotsUsed > maxSlots * 0.75 ? 'glinv-heavy' : '';
            this._setHtmlIfChanged(root, `<span class="glinv-header-chip ${stateClass}" title="${this._esc(L_inv(slotsUsed, maxSlots))}">
                <i class="fas fa-box"></i>
                <span class="glinv-hc-used">${slotsUsed}</span><span class="glinv-hc-sep">/</span><span class="glinv-hc-max">${maxSlots}</span>
            </span>`);
        } catch (err) {
            console.error(`${MODULE_ID} | Error rendering header chip:`, err);
        }

        function L_inv(u, m) {
            return `${game.i18n.localize('GLINVSLOTS.inventorySlots')}: ${u}/${m}`;
        }
    }

    /**
     * Map<Element, string> of the last HTML we wrote into a node. Tidy's
     * `renderScheme: 'handlebars'` re-runs onRender on EVERY Svelte change
     * cycle (any actor update — HP, spell slots, effects…), so unconditional
     * innerHTML writes cause constant DOM teardown + reflow. Keyed weakly on
     * the node itself: when Tidy/Svelte hands us a fresh node the entry is
     * simply absent and we render normally.
     */
    static _htmlCache = new WeakMap();

    /**
     * Write `html` into `node` only if it differs from what we last wrote
     * there (and the node still has that content). Returns true when written.
     */
    static _setHtmlIfChanged(node, html) {
        if (this._htmlCache.get(node) === html && (node.firstChild || html === '')) return false;
        node.innerHTML = html;
        this._htmlCache.set(node, html);
        return true;
    }

    /** Escape a string for safe interpolation into innerHTML. */
    static _esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, (c) => (
            { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
        ));
    }

    // ─── Render Callbacks ────────────────────────────────────────────

    static _onActorRender(params) {
        const actor = params.app?.document;
        const root = params.element?.classList?.contains('glinv-actor-root')
            ? params.element
            : params.element?.querySelector?.('.glinv-actor-root');
        const sheetEl = unwrapElement(params.app?.element);
        if (!actor || actor.documentName !== 'Actor' || !root || !sheetEl) return;
        if (actor.type === 'npc' && !getSetting('enableForNPCs')) { root.remove(); return; }
        if (actor.type !== 'character' && actor.type !== 'npc') { root.remove(); return; }

        try {
            // Theme: always the dark HUD, but tag the host theme for fine-tuning.
            root.classList.toggle('glinv-host-dark', sheetEl.classList.contains('theme-dark'));

            if (getSetting('enableSlotSystem')) {
                const inv = SlotCalculator.calculateInventory(actor);
                const sig = this._slotSignature(actor, inv);
                const unchanged = this._actorSig.get(actor.id) === sig && root.querySelector('.glinv-slot-panel');

                // Re-render only when the slot state actually changed (or the node
                // was re-created empty) — not on every Svelte change cycle.
                if (!unchanged) {
                    const prevUsed = this._slotCache.get(actor.id);
                    root.innerHTML = this._buildSlotPanelHtml(actor, inv);

                    const btn = root.querySelector('[data-glinv-settings]');
                    if (btn) btn.addEventListener('click', (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        this._openSettingsDialog(actor);
                    });

                    // Slot-machine reel + trend triangle, only on a real change.
                    if (prevUsed !== undefined && prevUsed !== inv.slotsUsed) {
                        this._animateReel(root.querySelector('.glinv-count-used'), prevUsed, inv.slotsUsed);
                        this._emitTrend(root.querySelector('.glinv-slot-count'), inv.slotsUsed - prevUsed);
                    }
                    this._slotCache.set(actor.id, inv.slotsUsed);
                    this._actorSig.set(actor.id, sig);
                }
            } else {
                // Direct write (not _setHtmlIfChanged): the enabled branch writes
                // this root directly, so the cache could be stale here. Clearing
                // an already-empty node is free.
                root.innerHTML = '';
            }

            // Annotate inventory rows across the whole sheet (idempotent —
            // unchanged rows are skipped via _rowAnnotationCache).
            this._annotateBulkOnRows(sheetEl, actor);
        } catch (err) {
            console.error(`${MODULE_ID} | Error rendering actor content:`, err);
        }
    }

    /** Stable signature of the slot state — used to skip redundant re-renders. */
    static _slotSignature(actor, inv) {
        let qd = '';
        if (getSetting('enableQuickdraw')) {
            qd = (actor.items?.contents ?? [])
                .filter((i) => { try { return SlotCalculator._isPhysicalItem(i) && SlotCalculator.isQuickdraw(i); } catch { return false; } })
                .map((i) => i.id).join(',');
        }
        return [inv.slotsUsed, inv.maxSlots, inv.overburdenedMax, inv.encumbranceState,
            inv.quickdrawCount, inv.maxQuickdraw, qd].join('|');
    }

    /** Map<actorId, string> — last rendered slot signature. */
    static _actorSig = new Map();

    /**
     * Slot-machine digit reel: roll each digit from its old value to the new one.
     * Element is rebuilt fresh each render, so we seed at the old digit then
     * transition to the new digit on the next frame (CSS handles the roll).
     */
    static _animateReel(el, oldVal, newVal) {
        if (!el) return;
        const newStr = String(newVal);
        const oldStr = String(oldVal).padStart(newStr.length, '0');
        el.textContent = '';
        el.classList.add('glinv-reel-num');
        for (let i = 0; i < newStr.length; i++) {
            const oldD = parseInt(oldStr[i] ?? '0', 10) || 0;
            const newD = parseInt(newStr[i], 10) || 0;
            const reel = document.createElement('span');
            reel.className = 'glinv-reel';
            const strip = document.createElement('span');
            strip.className = 'glinv-reel-strip';
            for (let d = 0; d <= 9; d++) {
                const digit = document.createElement('span');
                digit.className = 'glinv-reel-digit';
                digit.textContent = String(d);
                strip.appendChild(digit);
            }
            strip.style.transform = `translateY(-${oldD}em)`;
            reel.appendChild(strip);
            el.appendChild(reel);
            requestAnimationFrame(() => requestAnimationFrame(() => {
                strip.style.transform = `translateY(-${newD}em)`;
            }));
        }
    }

    /** Green ▼ (lighter) / red ▲ (heavier) trend triangle, à la clocks-and-tracker. */
    static _emitTrend(container, delta) {
        if (!container || !delta) return;
        const t = document.createElement('span');
        t.className = `glinv-trend ${delta > 0 ? 'glinv-trend-up' : 'glinv-trend-down'}`;
        t.textContent = delta > 0 ? '▲' : '▼';
        container.appendChild(t);
        setTimeout(() => t.remove(), 1400);
    }

    static _onItemRender(params) {
        const item = params.app?.document;
        // Tabs hand us `tabContentsElement`; content blocks hand us `element`.
        const host = params.tabContentsElement || params.element;
        const root = host?.classList?.contains('glinv-item-root')
            ? host
            : host?.querySelector?.('.glinv-item-root') || host;
        const sheetEl = unwrapElement(params.app?.element);
        if (!item || item.documentName !== 'Item' || !root) return;

        const nonPhysical = ['spell', 'feat', 'class', 'subclass', 'background', 'race', 'facility'];
        if (nonPhysical.includes(item.type)) { this._setHtmlIfChanged(root, ''); return; }

        try {
            let html = '';
            if (getSetting('enableSlotSystem')) html += this._buildBulkConfigHtml(item);
            if (getSetting('enableWearAndTear')) html += this._buildNotchConfigHtml(item);
            if (getSetting('enableAmmunitionDice')) html += this._buildAmmoConfigHtml(item);
            if (getSetting('enableDicePool')) html += this._buildDicePoolConfigHtml(item);
            // Skip the rebuild (and re-bind) when nothing changed — change cycles
            // fire for every item/actor update, not just ones that affect us.
            if (!this._setHtmlIfChanged(root, html)) return;
            // Fresh nodes on every write → binding here cannot leak.
            this._bindAllTabEvents(root, item, sheetEl);
        } catch (err) {
            console.error(`${MODULE_ID} | Error rendering item content:`, err);
        }
    }

    /** True when at least one of the module's features is enabled. */
    static _anyFeatureEnabled() {
        return getSetting('enableSlotSystem') || getSetting('enableWearAndTear')
            || getSetting('enableAmmunitionDice') || getSetting('enableDicePool');
    }

    // ─── Slot Panel HTML ─────────────────────────────────────────────

    /**
     * Build the inline slot panel markup for an actor. Pure string builder —
     * the caller injects it into the registered actor content root.
     */
    static _buildSlotPanelHtml(actor, inventory = SlotCalculator.calculateInventory(actor)) {
        const breakdown = SlotCalculator.getSlotBreakdown(actor);
        const { maxSlots, slotsUsed, overburdenedMax, encumbranceState, quickdrawCount, maxQuickdraw } = inventory;

        const stateClass = encumbranceState === 'overburdened' ? 'glinv-overburdened'
            : encumbranceState === 'encumbered' ? 'glinv-encumbered'
            : slotsUsed > maxSlots * 0.75 ? 'glinv-heavy'
            : '';

        // Build tooltip
        let tooltipLines = [];
        if (breakdown.isOverridden) {
            tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.tooltip.overridden')}: ${breakdown.overrideValue}`);
        } else {
            const sizeNames = { tiny: 'Tiny', sm: 'Small', med: 'Medium', lg: 'Large', huge: 'Huge', grg: 'Gargantuan' };
            const sizeName = sizeNames[breakdown.size] || breakdown.size;
            tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.tooltip.size')}: ${sizeName}${breakdown.sizeOverridden ? ' ★' : ''}`);
            tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.tooltip.baseSlots')}: ${breakdown.baseSlots}`);

            if (breakdown.packEndurance) {
                tooltipLines.push(`STR: ${breakdown.strMod >= 0 ? '+' : ''}${breakdown.strMod} | CON: ${breakdown.conMod >= 0 ? '+' : ''}${breakdown.conMod}`);
                tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.tooltip.using')} ${breakdown.usedAbility} (${game.i18n.localize('GLINVSLOTS.tooltip.packEndurance')})`);
            } else {
                tooltipLines.push(`STR: ${breakdown.strMod >= 0 ? '+' : ''}${breakdown.strMod}`);
            }

            if (breakdown.strMult > 1) {
                tooltipLines.push(`${breakdown.usedAbility} × ${breakdown.strMult} = ${breakdown.modContribution >= 0 ? '+' : ''}${breakdown.modContribution}`);
            }

            tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.tooltip.total')}: ${breakdown.baseSlots} ${breakdown.modContribution >= 0 ? '+' : ''}${breakdown.modContribution} = ${breakdown.total}`);
        }
        tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.overburdenedAt')}: ${overburdenedMax}`);
        const tooltip = tooltipLines.join('\n');

        // Build box grid grouped by 5s
        const displayMax = Math.min(Math.max(maxSlots, slotsUsed), overburdenedMax);
        let boxesHtml = '';
        let groupHtml = '';
        for (let i = 1; i <= displayMax; i++) {
            let boxClass = 'glinv-slot-box';
            if (i <= slotsUsed && i <= maxSlots) {
                boxClass += ' glinv-filled';
            } else if (i <= slotsUsed && i > maxSlots) {
                boxClass += ' glinv-over';
            } else {
                boxClass += ' glinv-empty';
            }
            groupHtml += `<div class="${boxClass}"></div>`;

            if (i % 5 === 0 || i === displayMax) {
                boxesHtml += `<div class="glinv-slot-group">${groupHtml}</div>`;
                groupHtml = '';
            }
        }

        let quickdrawHtml = '';
        if (getSetting('enableQuickdraw')) {
            quickdrawHtml = `
                <div class="glinv-quickdraw-info">
                    <i class="fas fa-bolt"></i>
                    <span>${game.i18n.localize('GLINVSLOTS.quickdraw')}: ${quickdrawCount}/${maxQuickdraw}</span>
                </div>`;
        }

        let settingsBtn = '';
        if (game.user.isGM) {
            settingsBtn = `<button type="button" class="glinv-settings-btn" data-glinv-settings title="${game.i18n.localize('GLINVSLOTS.tooltip.configure')}">
                <i class="fas fa-cog"></i>
            </button>`;
        }

        const innerHtml = `
            <div class="glinv-grid-header">
                <span class="glinv-slot-label">
                    <i class="fas fa-box"></i>
                    ${game.i18n.localize('GLINVSLOTS.inventorySlots')}
                </span>
                <span class="glinv-slot-count">
                    <span class="glinv-count-used">${slotsUsed}</span>
                    <span class="glinv-count-sep">/</span>
                    <span class="glinv-count-max">${maxSlots}</span>
                    ${encumbranceState !== 'normal'
                        ? `<span class="glinv-state-badge">${game.i18n.localize(`GLINVSLOTS.state.${encumbranceState}`)}</span>`
                        : ''}
                </span>
                ${quickdrawHtml}
                ${settingsBtn}
            </div>
            <div class="glinv-slot-boxes">
                ${boxesHtml}
            </div>`;

        return `
            <div class="glinv-slot-panel glinv-glass ${stateClass}" title="${this._esc(tooltip)}">
                ${innerHtml}
                ${this._buildQuickdrawBeltHtml(actor)}
            </div>`;
    }

    /**
     * Build the quickdraw "belt" — a tray of gold chips for the actor's
     * quickdraw-flagged items. Read-only display (drag-to-reorder is deferred,
     * as it needs Foundry's drag/drop APIs verified in-app).
     */
    static _buildQuickdrawBeltHtml(actor) {
        if (!getSetting('enableQuickdraw')) return '';
        const items = (actor.items?.contents ?? []).filter((i) => {
            try { return SlotCalculator._isPhysicalItem(i) && SlotCalculator.isQuickdraw(i); }
            catch { return false; }
        });
        if (items.length === 0) return '';

        const max = SlotCalculator.getMaxQuickdrawSlots();
        const chips = items.map((i) => `
            <span class="glinv-qd-chip" data-item-id="${this._esc(i.id)}" title="${this._esc(i.name)}">
                ${i.img ? `<img src="${this._esc(i.img)}" alt="">` : '<i class="fas fa-bolt"></i>'}
                <span class="glinv-qd-chip-name">${this._esc(i.name)}</span>
            </span>`).join('');

        return `
            <div class="glinv-quickdraw-belt">
                <span class="glinv-qd-belt-label">
                    <i class="fas fa-bolt"></i> ${game.i18n.localize('GLINVSLOTS.quickdraw')}
                    <span class="glinv-qd-belt-count">${items.length}/${max}</span>
                </span>
                <div class="glinv-qd-chips">${chips}</div>
            </div>`;
    }

    // ─── Settings Dialog (GM Override) ───────────────────────────────

    static async _openSettingsDialog(actor) {
        const currentOverride = actor.getFlag(FLAG_SCOPE, 'maxSlotsOverride') ?? '';
        const currentSizeOverride = actor.getFlag(FLAG_SCOPE, 'sizeOverride') ?? '';
        const breakdown = SlotCalculator.getSlotBreakdown(actor);

        const sizeOptions = [
            { value: '', label: `${game.i18n.localize('GLINVSLOTS.auto')} (${actor.system.traits?.size || 'med'})` },
            { value: 'tiny', label: 'Tiny' },
            { value: 'sm', label: 'Small' },
            { value: 'med', label: 'Medium' },
            { value: 'lg', label: 'Large' },
            { value: 'huge', label: 'Huge' },
            { value: 'grg', label: 'Gargantuan' }
        ].map(s => `<option value="${s.value}" ${s.value === currentSizeOverride ? 'selected' : ''}>${s.label}</option>`).join('');

        const content = `
            <div class="glinv-scope">
            <form class="glinv-override-form">
                <p style="margin-top:0;font-size:0.85rem;opacity:0.8;">
                    ${game.i18n.localize('GLINVSLOTS.dialog.calculatedSlots')}: <strong>${breakdown.total}</strong>
                </p>
                <div class="form-group">
                    <label>${game.i18n.localize('GLINVSLOTS.dialog.sizeOverride')}</label>
                    <select name="sizeOverride">${sizeOptions}</select>
                </div>
                <div class="form-group">
                    <label>${game.i18n.localize('GLINVSLOTS.dialog.maxSlotsOverride')}</label>
                    <input type="number" name="maxSlotsOverride" value="${currentOverride}"
                           placeholder="${game.i18n.localize('GLINVSLOTS.auto')} (${breakdown.total})" min="0" step="1">
                </div>
                <p style="font-size:0.75rem;opacity:0.6;margin-bottom:0;">
                    ${game.i18n.localize('GLINVSLOTS.dialog.overrideHint')}
                </p>
            </form>
            </div>`;

        const parseForm = (root) => ({
            sizeOverride: root.querySelector('[name="sizeOverride"]')?.value || '',
            maxSlotsOverride: root.querySelector('[name="maxSlotsOverride"]')?.value || ''
        });

        // Foundry v14 removes the Application V1 `Dialog` class; DialogV2 is the
        // only supported path. A rejected promise means the user dismissed the
        // dialog, so we simply abort without making changes.
        let result;
        try {
            result = await foundry.applications.api.DialogV2.prompt({
                window: { title: `${game.i18n.localize('GLINVSLOTS.inventorySlots')} — ${actor.name}` },
                content,
                ok: {
                    label: game.i18n.localize('GLINVSLOTS.dialog.save'),
                    callback: (event, button, dialog) => parseForm(button.closest('.application') || dialog)
                }
            });
        } catch {
            return;
        }

        if (!result) return;

        if (result.sizeOverride) await actor.setFlag(FLAG_SCOPE, 'sizeOverride', result.sizeOverride);
        else await actor.unsetFlag(FLAG_SCOPE, 'sizeOverride');

        const maxVal = parseInt(result.maxSlotsOverride);
        if (!isNaN(maxVal) && maxVal > 0) await actor.setFlag(FLAG_SCOPE, 'maxSlotsOverride', maxVal);
        else await actor.unsetFlag(FLAG_SCOPE, 'maxSlotsOverride');
    }

    // ─── Inline Slot Squares on Item Rows ────────────────────────────

    /**
     * Map<Element, string> of the annotation HTML last appended to a row's
     * name cell. Lets each render cycle skip rows whose badges are unchanged
     * instead of tearing down and rebuilding every badge on the sheet.
     */
    static _rowAnnotationCache = new WeakMap();

    static _annotateBulkOnRows(element, actor) {
        const rows = element.querySelectorAll('[data-tidy-sheet-part="item-table-row"]');
        const wearEnabled = getSetting('enableWearAndTear');
        const ammoEnabled = getSetting('enableAmmunitionDice');
        const poolEnabled = getSetting('enableDicePool');

        for (const row of rows) {
            const container = row.closest('[data-item-id]');
            const itemId = container?.dataset.itemId;
            if (!itemId) continue;

            const item = actor.items.get(itemId);
            if (!item) continue;
            if (!SlotCalculator._isPhysicalItem(item)) continue;

            const isBasic = SlotCalculator.isBasicSupply(item);
            const isQuickdraw = SlotCalculator.isQuickdraw(item);

            const totalBulk = SlotCalculator._isArmor(item)
                ? SlotCalculator.getArmorBulk(item, actor) * (item.system.quantity ?? 1)
                : SlotCalculator.getItemTotalBulk(item, actor);

            // Gold glow on quickdraw rows
            container.classList.toggle('glinv-quickdraw-row', isQuickdraw);

            const nameCell = row.querySelector('[data-tidy-sheet-part="item-name"]')
                || row.querySelector('.item-name')
                || row.querySelector('[data-tidy-sheet-part="table-cell"]');
            if (!nameCell) continue;

            const slotCount = isBasic ? 0 : Math.ceil(totalBulk);
            const displayBulk = isBasic ? '—' : (totalBulk % 1 === 0 ? String(totalBulk) : totalBulk.toFixed(1));

            const title = isBasic
                ? game.i18n.localize('GLINVSLOTS.basicSupplyTooltip')
                : `${displayBulk} ${game.i18n.localize('GLINVSLOTS.slots')}`;

            let slotsHtml = '';
            if (isBasic) {
                slotsHtml = `<span class="glinv-item-slots glinv-basic" title="${title}">
                    <i class="fas fa-campground glinv-icon-basic"></i>
                </span>`;
            } else {
                let colorClass = isQuickdraw ? 'glinv-sq-quickdraw' : 'glinv-sq-normal';
                let qdIcon = isQuickdraw ? '<i class="fas fa-bolt glinv-icon-quickdraw"></i>' : '';

                if (slotCount <= 5) {
                    let squares = '';
                    for (let i = 0; i < slotCount; i++) {
                        squares += `<span class="glinv-sq ${colorClass}"></span>`;
                    }
                    slotsHtml = `<span class="glinv-item-slots" title="${title}">
                        ${qdIcon}${squares}
                    </span>`;
                } else {
                    slotsHtml = `<span class="glinv-item-slots glinv-slot-compact" title="${title}">
                        ${qdIcon}<span class="glinv-sq ${colorClass}"></span><span class="glinv-slot-compact-times">×</span><span class="glinv-slot-compact-num">${slotCount}</span>
                    </span>`;
                }
            }

            // Assemble all badges (slots, then notch/ammo/pool indicators) into
            // one string and reconcile: rows whose annotations are unchanged are
            // left untouched, so a change cycle only mutates the rows it affects.
            let annotationsHtml = slotsHtml;
            if (wearEnabled) annotationsHtml += this._buildNotchIndicator(item);
            if (ammoEnabled) annotationsHtml += this._buildAmmoIndicator(item);
            if (poolEnabled) annotationsHtml += this._buildDicePoolIndicator(item);

            const hasBadges = !!nameCell.querySelector('.glinv-item-slots');
            if (hasBadges && this._rowAnnotationCache.get(nameCell) === annotationsHtml) continue;

            nameCell.querySelectorAll('.glinv-item-slots, .glinv-notch-indicator, .glinv-ammo-indicator, .glinv-pool-indicator')
                .forEach(el => el.remove());
            nameCell.insertAdjacentHTML('beforeend', annotationsHtml);
            this._rowAnnotationCache.set(nameCell, annotationsHtml);
        }
    }

    /**
     * Build the inline notch indicator HTML for an item row.
     */
    static _buildNotchIndicator(item) {
        const notches = NotchCalculator.getEffectiveNotches(item);
        const max = NotchCalculator.getMaxNotches(item);
        const temper = NotchCalculator.getTemper(item);
        const shattered = NotchCalculator.isShattered(item);

        // Don't show indicator if no notches and no temper
        if (notches === 0 && temper === 'none') return '';

        let tooltipLines = [];
        tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.notch.notches')}: ${notches}/${max}`);

        if (temper !== 'none') {
            tooltipLines.push(`${game.i18n.localize(`GLINVSLOTS.notch.temper.${temper}`)}`);
        }

        if (shattered) {
            tooltipLines.push(game.i18n.localize('GLINVSLOTS.notch.shattered'));
        } else if (item.type === 'weapon' && notches > 0) {
            const deg = NotchCalculator.getDegradedWeaponDamage(item);
            if (deg) tooltipLines.push(`${game.i18n.localize('GLINVSLOTS.notch.damage')}: ${deg.degraded}`);
        } else if (item.type === 'equipment' && notches > 0) {
            const penalty = NotchCalculator.getArmorACPenalty(item);
            if (penalty > 0) tooltipLines.push(`AC −${penalty}`);
        }

        const tooltip = tooltipLines.join('\n');
        const quality = NotchCalculator.getQualityGrade(item);

        // Temper badge
        let temperBadge = '';
        if (temper !== 'none') {
            temperBadge = `<span class="glinv-temper-badge glinv-temper-${temper}" title="${game.i18n.localize(`GLINVSLOTS.notch.temper.${temper}`)}">&#9670;</span>`;
        }

        if (shattered) {
            return `<span class="glinv-notch-indicator glinv-shattered" title="${tooltip}">
                ${temperBadge}<i class="fas fa-heart-crack"></i>
            </span>`;
        }

        if (notches === 0 && temper !== 'none') {
            // Only show temper badge
            return `<span class="glinv-notch-indicator" title="${tooltip}">${temperBadge}</span>`;
        }

        // Show notch pips (small slash marks)
        let pips = '';
        if (notches <= 5) {
            for (let i = 0; i < notches; i++) {
                pips += `<span class="glinv-notch-pip"></span>`;
            }
        } else {
            pips = `<span class="glinv-notch-pip"></span><span class="glinv-notch-count">×${notches}</span>`;
        }

        const stateClass = notches >= max * 0.75 ? 'glinv-notch-critical' :
                           notches >= max * 0.5 ? 'glinv-notch-warning' : '';

        return `<span class="glinv-notch-indicator ${stateClass}" title="${tooltip}">
            ${temperBadge}${pips}
        </span>`;
    }

    /**
     * Refresh the item config panel after a flag/item write.
     *
     * With the v3 registration architecture this is a no-op: writing a flag or
     * updating the item is an embedded-document change, which makes Tidy re-run
     * our `renderScheme: 'handlebars'` content and call `_onItemRender` again
     * with fresh nodes. Event handlers therefore retain their many call sites
     * without re-binding to a stale, ever-growing panel (the old leak).
     */
    static _refreshItemTab(_element, _item) { /* reactive — handled by Tidy re-render */ }

    // ─── Bulk Config HTML ───────────────────────────────────────────

    static _buildBulkConfigHtml(item) {
        const currentCategory = item.getFlag?.(FLAG_SCOPE, 'bulkCategory') || '';
        const currentOverride = item.getFlag?.(FLAG_SCOPE, 'bulkOverride');
        const isQuickdraw = item.getFlag?.(FLAG_SCOPE, 'quickdraw') || false;
        const isBasicSupply = item.getFlag?.(FLAG_SCOPE, 'isBasicSupply') || false;
        const objectScale = item.getFlag?.(FLAG_SCOPE, 'objectScale') || 'med';
        const containerSlots = item.getFlag?.(FLAG_SCOPE, 'containerSlotsOverride');
        const magicSlots = item.getFlag?.(FLAG_SCOPE, 'magicContainerSlots');
        const isContainer = item.type === 'container' || item.type === 'backpack';

        const categoryOptions = Object.entries(BULK_CATEGORIES).map(([key, cat]) =>
            `<option value="${key}" ${key === currentCategory ? 'selected' : ''}>${game.i18n.localize(cat.label)} (${cat.value})</option>`
        ).join('');

        const scaleOptions = [
            { value: 'tiny', label: 'GLINVSLOTS.scale.tiny' },
            { value: 'sm', label: 'GLINVSLOTS.scale.small' },
            { value: 'med', label: 'GLINVSLOTS.scale.medium' },
            { value: 'lg', label: 'GLINVSLOTS.scale.large' },
            { value: 'huge', label: 'GLINVSLOTS.scale.huge' },
            { value: 'grg', label: 'GLINVSLOTS.scale.gargantuan' }
        ].map(s => `<option value="${s.value}" ${s.value === objectScale ? 'selected' : ''}>${game.i18n.localize(s.label)}</option>`).join('');

        let containerHtml = isContainer ? `
            <div class="glinv-item-field">
                <label>${game.i18n.localize('GLINVSLOTS.containerSlots')}</label>
                <input type="number" class="glinv-container-slots" value="${containerSlots ?? ''}"
                       placeholder="${game.i18n.localize('GLINVSLOTS.auto')}" min="0" step="1">
            </div>
            <div class="glinv-item-field">
                <label>${game.i18n.localize('GLINVSLOTS.magicContainerSlots')}</label>
                <input type="number" class="glinv-magic-slots" value="${magicSlots ?? ''}"
                       placeholder="${game.i18n.localize('GLINVSLOTS.none')}" min="0" step="1">
            </div>` : '';

        let scalingHtml = getSetting('enableObjectScaling') ? `
            <div class="glinv-item-field">
                <label>${game.i18n.localize('GLINVSLOTS.objectScale')}</label>
                <select class="glinv-object-scale">${scaleOptions}</select>
            </div>` : '';

        let quickdrawHtml = getSetting('enableQuickdraw') ? `
            <div class="glinv-item-field glinv-checkbox-field">
                <label>
                    <input type="checkbox" class="glinv-quickdraw-toggle" ${isQuickdraw ? 'checked' : ''}>
                    <i class="fas fa-bolt"></i> ${game.i18n.localize('GLINVSLOTS.quickdraw')}
                </label>
            </div>` : '';

        return `
            <div class="glinv-item-config" data-glinv-section="bulk">
                <h4 class="glinv-config-header">
                    <i class="fas fa-box"></i> ${game.i18n.localize('GLINVSLOTS.itemConfig')}
                </h4>
                <div class="glinv-item-fields">
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.bulkCategory')}</label>
                        <select class="glinv-bulk-category">
                            <option value="">${game.i18n.localize('GLINVSLOTS.auto')}</option>
                            ${categoryOptions}
                        </select>
                    </div>
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.bulkOverride')}</label>
                        <input type="number" class="glinv-bulk-override" value="${currentOverride ?? ''}"
                               placeholder="${game.i18n.localize('GLINVSLOTS.auto')}" min="0" step="0.1">
                    </div>
                    ${scalingHtml}
                    ${containerHtml}
                    ${quickdrawHtml}
                    <div class="glinv-item-field glinv-checkbox-field">
                        <label>
                            <input type="checkbox" class="glinv-basic-supply-toggle" ${isBasicSupply ? 'checked' : ''}>
                            <i class="fas fa-campground"></i> ${game.i18n.localize('GLINVSLOTS.basicSupply')}
                        </label>
                    </div>
                </div>
            </div>`;
    }

    // ─── Notch Config HTML ──────────────────────────────────────────

    static _buildNotchConfigHtml(item) {
        const notches = NotchCalculator.getNotches(item);
        const effectiveNotches = NotchCalculator.getEffectiveNotches(item);
        const maxNotches = NotchCalculator.getMaxNotches(item);
        const fragility = NotchCalculator.getFragility(item);
        const temper = NotchCalculator.getTemper(item);
        const quality = NotchCalculator.getQualityGrade(item);
        const shattered = NotchCalculator.isShattered(item);
        const isArcaneFocus = NotchCalculator.isArcaneFocus(item);
        const peakNotches = item.getFlag?.(FLAG_SCOPE, 'peakNotches') ?? 0;

        const fragilityOptions = Object.entries(FRAGILITY).map(([key, f]) =>
            `<option value="${key}" ${key === fragility ? 'selected' : ''}>${game.i18n.localize(f.label)} (${f.maxNotches})</option>`
        ).join('');

        let temperHtml = '';
        if (getSetting('enableTempering')) {
            const temperOptions = Object.keys(TEMPER_GRADES).map(key =>
                `<option value="${key}" ${key === temper ? 'selected' : ''}>${game.i18n.localize(`GLINVSLOTS.notch.temper.${key}`)}</option>`
            ).join('');
            temperHtml = `
                <div class="glinv-item-field">
                    <label>${game.i18n.localize('GLINVSLOTS.notch.currentTemper')}</label>
                    <select class="glinv-temper-select">${temperOptions}</select>
                </div>`;
        }

        // Effect display
        let effectHtml = '';
        if (effectiveNotches > 0 && !shattered) {
            if (item.type === 'weapon') {
                const deg = NotchCalculator.getDegradedWeaponDamage(item);
                if (deg) {
                    effectHtml = `<div class="glinv-notch-effect">
                        <small>${game.i18n.localize('GLINVSLOTS.notch.degradedDamage')}: <strong>${deg.original}</strong> → <strong class="glinv-degraded">${deg.degraded}</strong></small>
                    </div>`;
                }
            } else if (item.type === 'equipment') {
                const penalty = NotchCalculator.getArmorACPenalty(item);
                if (penalty > 0) {
                    effectHtml = `<div class="glinv-notch-effect">
                        <small>${game.i18n.localize('GLINVSLOTS.notch.acPenalty')}: <strong class="glinv-degraded">−${penalty}</strong></small>
                    </div>`;
                }
            }
            if (isArcaneFocus && effectiveNotches > 0) {
                effectHtml += `<div class="glinv-notch-effect">
                    <small>${game.i18n.localize('GLINVSLOTS.notch.focusPenalty')}: <strong class="glinv-degraded">−${effectiveNotches}</strong> ${game.i18n.localize('GLINVSLOTS.notch.toSpellAttackDC')}</small>
                </div>`;
            }
        }

        let shatteredHtml = shattered ? `<div class="glinv-shattered-banner">
            <i class="fas fa-heart-crack"></i> ${game.i18n.localize('GLINVSLOTS.notch.shattered')}
        </div>` : '';

        const qualityLabel = game.i18n.localize(`GLINVSLOTS.notch.quality.${quality.key}`);
        const repairCost = NotchCalculator.getRepairCostPerNotch(item);
        const totalRepair = NotchCalculator.getTotalRepairCost(item);

        // Quality select for GM editing
        const qualityKeys = ['pristine', 'worn', 'wellWorn', 'scarred'];
        const qualityOptions = qualityKeys.map(key =>
            `<option value="${key}" ${quality.key === key ? 'selected' : ''}>${game.i18n.localize(`GLINVSLOTS.notch.quality.${key}`)}</option>`
        ).join('');

        // Notch bar visualization
        let notchBarHtml = '';
        if (maxNotches <= 20) {
            let pips = '';
            for (let i = 1; i <= maxNotches; i++) {
                const cls = i <= effectiveNotches ? 'glinv-notch-bar-pip glinv-notch-bar-filled' : 'glinv-notch-bar-pip';
                pips += `<div class="${cls}"></div>`;
            }
            notchBarHtml = `<div class="glinv-notch-bar">${pips}</div>`;
        }

        // Arcane focus checkbox (for equipment items)
        let focusHtml = '';
        if (item.type === 'equipment' || item.type === 'weapon' || item.type === 'loot') {
            focusHtml = `
                <div class="glinv-item-field glinv-checkbox-field">
                    <label>
                        <input type="checkbox" class="glinv-arcane-focus-toggle" ${isArcaneFocus ? 'checked' : ''}>
                        <i class="fas fa-hat-wizard"></i> ${game.i18n.localize('GLINVSLOTS.notch.arcaneFocus')}
                    </label>
                </div>`;
        }

        return `
            <div class="glinv-item-config glinv-notch-config" data-glinv-section="notch">
                <h4 class="glinv-config-header">
                    <i class="fas fa-hammer"></i> ${game.i18n.localize('GLINVSLOTS.notch.config')}
                </h4>
                ${shatteredHtml}
                <div class="glinv-item-fields">
                    <div class="glinv-notch-status">
                        <span class="glinv-notch-label">${game.i18n.localize('GLINVSLOTS.notch.notches')}</span>
                        <span class="glinv-notch-value">${effectiveNotches} / ${maxNotches}</span>
                        <span class="glinv-quality-badge glinv-quality-${quality.key}">${qualityLabel}</span>
                    </div>
                    ${notchBarHtml}
                    ${effectHtml}
                    <div class="glinv-notch-controls">
                        <button type="button" class="glinv-notch-add" title="${game.i18n.localize('GLINVSLOTS.notch.addNotch')}">
                            <i class="fas fa-plus"></i> ${game.i18n.localize('GLINVSLOTS.notch.notch')}
                        </button>
                        <button type="button" class="glinv-notch-remove" ${effectiveNotches <= 0 ? 'disabled' : ''} title="${game.i18n.localize('GLINVSLOTS.notch.removeNotch')}">
                            <i class="fas fa-wrench"></i> ${game.i18n.localize('GLINVSLOTS.notch.removeNotch')}
                        </button>
                    </div>
                    ${effectiveNotches > 0 ? `<div class="glinv-repair-info">
                        <small>${game.i18n.localize('GLINVSLOTS.notch.repairCost')}: ${repairCost} gp ${game.i18n.localize('GLINVSLOTS.notch.perNotch')} (${game.i18n.localize('GLINVSLOTS.notch.total')}: ${totalRepair} gp)</small>
                    </div>` : ''}
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.notch.fragility.label')}</label>
                        <select class="glinv-fragility-select">${fragilityOptions}</select>
                    </div>
                    ${temperHtml}
                    ${focusHtml}
                    ${game.user.isGM ? `
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.notch.quality.label')} (GM)</label>
                        <select class="glinv-quality-select">${qualityOptions}</select>
                    </div>
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.notch.notches')} (GM Override)</label>
                        <input type="number" class="glinv-notch-override" value="${notches || ''}"
                               placeholder="0" min="0" step="0.125">
                    </div>` : ''}
                </div>
            </div>`;
    }

    // ─── Ammo Config HTML ────────────────────────────────────────────

    static _buildAmmoConfigHtml(item) {
        // Weapons get a pairing UI instead
        if (item.type === 'weapon') return this._buildWeaponAmmoPairingHtml(item);

        // Only show for ammunition items or items manually opted in
        const isAmmo = AmmoDiceCalculator.isAmmunition(item);
        const usesAmmoDice = AmmoDiceCalculator.usesAmmoDice(item);
        const isManuallyTagged = item.getFlag(FLAG_SCOPE, 'isAmmoDice') === true;
        const trackIndividual = item.getFlag(FLAG_SCOPE, 'ammoTrackIndividual') === true;

        // If it's not ammo at all and not manually tagged, show opt-in only for consumables
        if (!isAmmo && item.type !== 'consumable') return '';

        const currentDie = AmmoDiceCalculator.getCurrentDie(item);
        const maxDie = AmmoDiceCalculator.getMaxDie(item);
        const isEmpty = AmmoDiceCalculator.isEmpty(item);
        const isLastShot = AmmoDiceCalculator.isLastShot(item);
        const dieLabel = AmmoDiceCalculator.getDieLabel(item);
        const replenishCost = AmmoDiceCalculator.getTotalReplenishCost(item);

        // Die options for max die select
        const dieOptions = [4, 6, 8, 10, 12, 20].map(d =>
            `<option value="${d}" ${d === maxDie ? 'selected' : ''}>d${d}</option>`
        ).join('');

        // Current die display options (for GM override)
        const currentDieOptions = [0, 1, 4, 6, 8, 10, 12, 20].map(d => {
            const label = d === 0 ? game.i18n.localize('GLINVSLOTS.ammo.empty')
                : d === 1 ? game.i18n.localize('GLINVSLOTS.ammo.lastShot')
                : `d${d}`;
            return `<option value="${d}" ${d === currentDie ? 'selected' : ''}>${label}</option>`;
        }).join('');

        // Die visualization
        let dieVisualClass = 'glinv-ammo-die-normal';
        if (isEmpty) dieVisualClass = 'glinv-ammo-die-empty';
        else if (isLastShot) dieVisualClass = 'glinv-ammo-die-last';
        else if (currentDie <= 6) dieVisualClass = 'glinv-ammo-die-low';

        // Only show full UI if using ammo dice
        if (!usesAmmoDice) {
            return `
                <div class="glinv-item-config glinv-ammo-config" data-glinv-section="ammo">
                    <h4 class="glinv-config-header">
                        <i class="fas fa-bullseye"></i> ${game.i18n.localize('GLINVSLOTS.ammo.config')}
                    </h4>
                    <div class="glinv-item-fields">
                        <div class="glinv-item-field glinv-checkbox-field">
                            <label>
                                <input type="checkbox" class="glinv-ammo-dice-toggle" ${isManuallyTagged ? 'checked' : ''}>
                                <i class="fas fa-dice-d20"></i> ${game.i18n.localize('GLINVSLOTS.ammo.useAmmoDice')}
                            </label>
                        </div>
                        ${isAmmo ? `<div class="glinv-item-field glinv-checkbox-field">
                            <label>
                                <input type="checkbox" class="glinv-ammo-individual-toggle" ${trackIndividual ? 'checked' : ''}>
                                <i class="fas fa-hashtag"></i> ${game.i18n.localize('GLINVSLOTS.ammo.trackIndividual')}
                            </label>
                            <small class="glinv-field-hint">${game.i18n.localize('GLINVSLOTS.ammo.trackIndividualHint')}</small>
                        </div>` : ''}
                    </div>
                </div>`;
        }

        const L = (k) => game.i18n.localize(`GLINVSLOTS.${k}`);
        const faceText = isEmpty ? '∅' : isLastShot ? '1' : `d${currentDie}`;
        // Depletion track: one pip per chain step at or below the max die.
        const track = AMMO_DIE_CHAIN.filter((d) => d <= maxDie)
            .map((d) => `<span class="glinv-step ${currentDie >= d ? 'on' : ''}" title="d${d}"></span>`).join('');

        return `
            <div class="glinv-item-config glinv-card glinv-ammo-config ${dieVisualClass}" data-glinv-section="ammo">
                <div class="glinv-card-head">
                    <i class="fas fa-bullseye"></i><span class="glinv-card-title">${L('ammo.config')}</span>
                    <span class="glinv-card-tag">${faceText}</span>
                </div>
                <div class="glinv-die-hero">
                    <div class="glinv-die"><span class="glinv-die-face">${faceText}</span></div>
                    <div class="glinv-die-meta">
                        <div class="glinv-die-track">${track}</div>
                        <div class="glinv-die-sub">${L('ammo.maxDie')} d${maxDie}${replenishCost > 0 ? ` · ${replenishCost} gp` : ''}</div>
                    </div>
                </div>
                <div class="glinv-btn-row">
                    <button type="button" class="glinv-icon-btn glinv-ammo-roll" ${isEmpty ? 'disabled' : ''} title="${L('ammo.rollAmmo')}"><i class="fas fa-dice"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-ammo-replenish" ${currentDie >= maxDie ? 'disabled' : ''} title="${L('ammo.replenish')}"><i class="fas fa-plus"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-ammo-replenish-full" ${currentDie >= maxDie ? 'disabled' : ''} title="${L('ammo.replenishFull')}"><i class="fas fa-arrows-rotate"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-ammo-reset" title="${L('ammo.reset')}"><i class="fas fa-undo"></i></button>
                </div>
                <div class="glinv-mini-fields">
                    <label class="glinv-mini-field"><span>${L('ammo.maxDie')}</span><select class="glinv-ammo-max-die">${dieOptions}</select></label>
                    ${game.user.isGM ? `<label class="glinv-mini-field"><span>${L('ammo.currentDie')}</span><select class="glinv-ammo-current-die">${currentDieOptions}</select></label>` : ''}
                    <label class="glinv-mini-check" title="${L('ammo.trackIndividualHint')}"><input type="checkbox" class="glinv-ammo-individual-toggle" ${trackIndividual ? 'checked' : ''}><i class="fas fa-hashtag"></i> ${L('ammo.trackIndividual')}</label>
                </div>
            </div>`;
    }

    /**
     * Build weapon-ammo pairing UI for weapon items.
     * Allows selecting which ammo item to roll dice for when this weapon attacks.
     */
    static _buildWeaponAmmoPairingHtml(item) {
        const actor = item.parent;
        if (!actor) return '';

        const pairedAmmoId = item.getFlag(FLAG_SCOPE, 'pairedAmmoId') || '';

        // Gather all ammo items on this actor that use dice tracking
        const ammoItems = (actor.items?.contents ?? []).filter(i =>
            AmmoDiceCalculator.isAmmunition(i) || i.getFlag(FLAG_SCOPE, 'isAmmoDice') === true
        );

        if (ammoItems.length === 0 && !pairedAmmoId) return '';

        const ammoOptions = ammoItems.map(a => {
            const dieLabel = AmmoDiceCalculator.usesAmmoDice(a) ? ` (${AmmoDiceCalculator.getDieLabel(a)})` : '';
            return `<option value="${a.id}" ${a.id === pairedAmmoId ? 'selected' : ''}>${this._esc(a.name)}${dieLabel}</option>`;
        }).join('');

        // Show paired ammo status
        let pairedStatusHtml = '';
        if (pairedAmmoId) {
            const pairedAmmo = actor.items.get(pairedAmmoId);
            if (pairedAmmo && AmmoDiceCalculator.usesAmmoDice(pairedAmmo)) {
                const currentDie = AmmoDiceCalculator.getCurrentDie(pairedAmmo);
                const maxDie = AmmoDiceCalculator.getMaxDie(pairedAmmo);
                const isEmpty = AmmoDiceCalculator.isEmpty(pairedAmmo);
                const isLastShot = AmmoDiceCalculator.isLastShot(pairedAmmo);
                const dieLabel = AmmoDiceCalculator.getDieLabel(pairedAmmo);

                let dieVisualClass = 'glinv-ammo-die-normal';
                if (isEmpty) dieVisualClass = 'glinv-ammo-die-empty';
                else if (isLastShot) dieVisualClass = 'glinv-ammo-die-last';
                else if (currentDie <= 6) dieVisualClass = 'glinv-ammo-die-low';

                pairedStatusHtml = `
                    <div class="glinv-ammo-status">
                        <div class="glinv-ammo-die-display ${dieVisualClass}">
                            <i class="fas fa-dice-d20"></i>
                            <span class="glinv-ammo-die-label">${dieLabel}</span>
                        </div>
                        <span class="glinv-ammo-max">/ d${maxDie}</span>
                        <span class="glinv-ammo-paired-name">${this._esc(pairedAmmo.name)}</span>
                    </div>
                    <div class="glinv-ammo-controls">
                        <button type="button" class="glinv-ammo-roll-paired" ${isEmpty ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}">
                            <i class="fas fa-dice"></i> ${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}
                        </button>
                    </div>`;
            } else if (pairedAmmo) {
                pairedStatusHtml = `<div class="glinv-repair-info">
                    <small>${this._esc(pairedAmmo.name)} — ${game.i18n.localize('GLINVSLOTS.ammo.trackIndividual')}</small>
                </div>`;
            }
        }

        return `
            <div class="glinv-item-config glinv-ammo-config" data-glinv-section="ammo">
                <h4 class="glinv-config-header">
                    <i class="fas fa-bullseye"></i> ${game.i18n.localize('GLINVSLOTS.ammo.config')}
                </h4>
                <div class="glinv-item-fields">
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.ammo.pairedAmmo')}</label>
                        <select class="glinv-ammo-pair-select">
                            <option value="">${game.i18n.localize('GLINVSLOTS.none')}</option>
                            ${ammoOptions}
                        </select>
                    </div>
                    ${pairedStatusHtml}
                </div>
            </div>`;
    }

    /**
     * Build inline ammo die indicator for inventory item rows.
     */
    static _buildAmmoIndicator(item) {
        if (!AmmoDiceCalculator.usesAmmoDice(item)) return '';

        const currentDie = AmmoDiceCalculator.getCurrentDie(item);
        const maxDie = AmmoDiceCalculator.getMaxDie(item);
        const isEmpty = AmmoDiceCalculator.isEmpty(item);
        const isLastShot = AmmoDiceCalculator.isLastShot(item);
        const label = AmmoDiceCalculator.getDieLabel(item);

        let stateClass = '';
        if (isEmpty) stateClass = 'glinv-ammo-ind-empty';
        else if (isLastShot) stateClass = 'glinv-ammo-ind-last';
        else if (currentDie <= 6) stateClass = 'glinv-ammo-ind-low';

        const tooltip = `${game.i18n.localize('GLINVSLOTS.ammo.ammoDie')}: ${label} / d${maxDie}`;

        return `<span class="glinv-ammo-indicator ${stateClass}" title="${tooltip}">
            <i class="fas fa-dice-d20"></i><span class="glinv-ammo-ind-label">${label}</span>
        </span>`;
    }

    // ─── Dice Pool Config HTML ─────────────────────────────────────

    static _buildDicePoolConfigHtml(item) {
        const usesPool = DicePoolCalculator.usesDicePool(item);
        const poolSize = DicePoolCalculator.getPoolSize(item);
        const maxSize = DicePoolCalculator.getMaxPoolSize(item);
        const dieType = DicePoolCalculator.getDieType(item);
        const threshold = DicePoolCalculator.getDiscardThreshold(item);
        const depleted = DicePoolCalculator.isDepleted(item);
        const label = DicePoolCalculator.getPoolLabel(item);

        // Die type options
        const dieTypeOptions = DICE_POOL_DIE_TYPES.map(d =>
            `<option value="${d}" ${d === dieType ? 'selected' : ''}>d${d}</option>`
        ).join('');

        // Threshold options (1 to dieType-1)
        let thresholdOptions = '';
        for (let i = 1; i < dieType; i++) {
            thresholdOptions += `<option value="${i}" ${i === threshold ? 'selected' : ''}>${i} ${i === 1 ? '(1 only)' : `(1-${i})`}</option>`;
        }

        if (!usesPool) {
            return `
                <div class="glinv-item-config glinv-pool-config" data-glinv-section="pool">
                    <h4 class="glinv-config-header">
                        <i class="fas fa-cubes"></i> ${game.i18n.localize('GLINVSLOTS.pool.config')}
                    </h4>
                    <div class="glinv-item-fields">
                        <div class="glinv-item-field glinv-checkbox-field">
                            <label>
                                <input type="checkbox" class="glinv-pool-toggle">
                                <i class="fas fa-cubes"></i> ${game.i18n.localize('GLINVSLOTS.pool.useDicePool')}
                            </label>
                        </div>
                    </div>
                </div>`;
        }

        // Pool fill percentage for visual
        const fillPercent = maxSize > 0 ? Math.round((poolSize / maxSize) * 100) : 0;
        let stateClass = 'glinv-pool-healthy';
        if (depleted) stateClass = 'glinv-pool-empty';
        else if (fillPercent <= 25) stateClass = 'glinv-pool-critical';
        else if (fillPercent <= 50) stateClass = 'glinv-pool-low';

        // Dice visualization — show individual die pips up to 20
        let diceVisHtml = '';
        if (maxSize <= 20) {
            let pips = '';
            for (let i = 1; i <= maxSize; i++) {
                const cls = i <= poolSize
                    ? `glinv-pool-pip glinv-pool-pip-filled ${stateClass}`
                    : 'glinv-pool-pip glinv-pool-pip-empty';
                pips += `<div class="${cls}" title="d${dieType}"></div>`;
            }
            diceVisHtml = `<div class="glinv-pool-dice-bar">${pips}</div>`;
        }

        const L = (k) => game.i18n.localize(`GLINVSLOTS.${k}`);
        return `
            <div class="glinv-item-config glinv-card glinv-pool-config ${stateClass}" data-glinv-section="pool">
                <div class="glinv-card-head">
                    <i class="fas fa-cubes"></i><span class="glinv-card-title">${L('pool.config')}</span>
                    <span class="glinv-card-tag">${poolSize}d${dieType}</span>
                </div>
                <div class="glinv-pool-hero">
                    ${diceVisHtml || ''}
                    <span class="glinv-pool-fraction">${poolSize}<small>/${maxSize}</small></span>
                </div>
                <div class="glinv-btn-row">
                    <button type="button" class="glinv-icon-btn glinv-pool-roll" ${depleted ? 'disabled' : ''} title="${L('pool.rollPool')}"><i class="fas fa-dice"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-pool-refill" ${poolSize >= maxSize ? 'disabled' : ''} title="${L('pool.refill')}"><i class="fas fa-arrows-rotate"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-pool-add" ${poolSize >= maxSize ? 'disabled' : ''} title="${L('pool.addDie')}"><i class="fas fa-plus"></i></button>
                    <button type="button" class="glinv-icon-btn glinv-pool-remove" ${depleted ? 'disabled' : ''} title="${L('pool.removeDie')}"><i class="fas fa-minus"></i></button>
                </div>
                <div class="glinv-die-sub">${L('pool.discardHint')} (${threshold === 1 ? '1' : `1–${threshold}`})</div>
                <div class="glinv-mini-fields">
                    <label class="glinv-mini-field"><span>${L('pool.maxPool')}</span><input type="number" class="glinv-pool-max-size" value="${maxSize}" min="1" max="99" step="1"></label>
                    <label class="glinv-mini-field"><span>${L('pool.dieType')}</span><select class="glinv-pool-die-type">${dieTypeOptions}</select></label>
                    <label class="glinv-mini-field"><span>${L('pool.discardThreshold')}</span><select class="glinv-pool-threshold">${thresholdOptions}</select></label>
                    ${game.user.isGM ? `<label class="glinv-mini-field"><span>${L('pool.currentPool')}</span><input type="number" class="glinv-pool-current-override" value="${poolSize}" min="0" max="${maxSize}" step="1"></label>` : ''}
                    <label class="glinv-mini-check"><input type="checkbox" class="glinv-pool-toggle" checked><i class="fas fa-cubes"></i> ${L('pool.useDicePool')}</label>
                </div>
                ${depleted ? `<div class="glinv-card-banner"><i class="fas fa-skull"></i> ${L('pool.depleted')}</div>` : ''}
            </div>`;
    }

    /**
     * Build inline dice pool indicator for inventory item rows.
     */
    static _buildDicePoolIndicator(item) {
        if (!DicePoolCalculator.usesDicePool(item)) return '';

        const poolSize = DicePoolCalculator.getPoolSize(item);
        const maxSize = DicePoolCalculator.getMaxPoolSize(item);
        const dieType = DicePoolCalculator.getDieType(item);
        const depleted = DicePoolCalculator.isDepleted(item);
        const fillPercent = maxSize > 0 ? Math.round((poolSize / maxSize) * 100) : 0;

        let stateClass = '';
        if (depleted) stateClass = 'glinv-pool-ind-depleted';
        else if (fillPercent <= 25) stateClass = 'glinv-pool-ind-critical';
        else if (fillPercent <= 50) stateClass = 'glinv-pool-ind-low';

        const tooltip = `${game.i18n.localize('GLINVSLOTS.pool.dicePool')}: ${poolSize}d${dieType} / ${maxSize}d${dieType}`;

        return `<span class="glinv-pool-indicator ${stateClass}" title="${tooltip}">
            <i class="fas fa-cubes"></i><span class="glinv-pool-ind-label">${poolSize}d${dieType}</span>
        </span>`;
    }

    // ─── Tab Event Binding ──────────────────────────────────────────

    static _bindAllTabEvents(container, item, sheetElement) {
        // Bulk config events
        container.querySelector('.glinv-bulk-category')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val) await item.setFlag(FLAG_SCOPE, 'bulkCategory', val);
            else await item.unsetFlag(FLAG_SCOPE, 'bulkCategory');
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-bulk-override')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val !== '' && !isNaN(val)) await item.setFlag(FLAG_SCOPE, 'bulkOverride', parseFloat(val));
            else await item.unsetFlag(FLAG_SCOPE, 'bulkOverride');
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-object-scale')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'objectScale', ev.target.value);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-container-slots')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val !== '' && !isNaN(val)) await item.setFlag(FLAG_SCOPE, 'containerSlotsOverride', parseInt(val));
            else await item.unsetFlag(FLAG_SCOPE, 'containerSlotsOverride');
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-magic-slots')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val !== '' && !isNaN(val)) await item.setFlag(FLAG_SCOPE, 'magicContainerSlots', parseInt(val));
            else await item.unsetFlag(FLAG_SCOPE, 'magicContainerSlots');
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-quickdraw-toggle')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'quickdraw', ev.target.checked);
        });

        container.querySelector('.glinv-basic-supply-toggle')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'isBasicSupply', ev.target.checked);
        });

        // Notch config events
        container.querySelector('.glinv-notch-add')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const result = await NotchCalculator.addNotch(item);
            if (result.shattered) {
                ui.notifications.warn(`${item.name} ${game.i18n.localize('GLINVSLOTS.notch.shattered')}!`);
            }
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-notch-remove')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await NotchCalculator.removeNotch(item, 1);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-fragility-select')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'fragility', ev.target.value);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-temper-select')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'temper', ev.target.value);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-arcane-focus-toggle')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'isArcaneFocus', ev.target.checked);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-quality-select')?.addEventListener('change', async (ev) => {
            const qualityMap = { pristine: 0, worn: 1, wellWorn: 2, scarred: 4 };
            const peak = qualityMap[ev.target.value] ?? 0;
            await item.setFlag(FLAG_SCOPE, 'peakNotches', peak);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-notch-override')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val !== '' && !isNaN(val)) await NotchCalculator.setNotches(item, parseFloat(val));
            else await item.unsetFlag(FLAG_SCOPE, 'notches');
            this._refreshItemTab(sheetElement, item);
        });

        // Ammo dice events — weapon pairing
        container.querySelector('.glinv-ammo-pair-select')?.addEventListener('change', async (ev) => {
            const val = ev.target.value;
            if (val) await item.setFlag(FLAG_SCOPE, 'pairedAmmoId', val);
            else await item.unsetFlag(FLAG_SCOPE, 'pairedAmmoId');
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-roll-paired')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const pairedAmmoId = item.getFlag(FLAG_SCOPE, 'pairedAmmoId');
            const actor = item.parent;
            if (pairedAmmoId && actor) {
                const ammoItem = actor.items.get(pairedAmmoId);
                if (ammoItem) {
                    await AmmoDiceCalculator.rollAmmoDie(ammoItem, true);
                    this._refreshItemTab(sheetElement, item);
                }
            }
        });

        // Ammo dice events — ammo items
        container.querySelector('.glinv-ammo-dice-toggle')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'isAmmoDice', ev.target.checked);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-individual-toggle')?.addEventListener('change', async (ev) => {
            await item.setFlag(FLAG_SCOPE, 'ammoTrackIndividual', ev.target.checked);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-roll')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await AmmoDiceCalculator.rollAmmoDie(item, true);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-replenish')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const result = await AmmoDiceCalculator.replenishDie(item);
            if (result.alreadyFull) {
                ui.notifications.info(`${item.name}: already at full ammunition.`);
            } else {
                ui.notifications.info(`${item.name}: replenished to d${result.newDie} (${result.cost} gp)`);
            }
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-replenish-full')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const result = await AmmoDiceCalculator.fullReplenish(item);
            if (result.alreadyFull) {
                ui.notifications.info(`${item.name}: already at full ammunition.`);
            } else {
                ui.notifications.info(`${item.name}: fully replenished (${result.cost} gp, ${result.steps} steps)`);
            }
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-reset')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await AmmoDiceCalculator.resetToFull(item);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-max-die')?.addEventListener('change', async (ev) => {
            await AmmoDiceCalculator.setMaxDie(item, parseInt(ev.target.value));
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-ammo-current-die')?.addEventListener('change', async (ev) => {
            await AmmoDiceCalculator.setCurrentDie(item, parseInt(ev.target.value));
            this._refreshItemTab(sheetElement, item);
        });

        // Dice pool events
        container.querySelector('.glinv-pool-toggle')?.addEventListener('change', async (ev) => {
            await DicePoolCalculator.enableDicePool(item, ev.target.checked);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-roll')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            const result = await DicePoolCalculator.rollPool(item, true);
            if (result.depleted) {
                ui.notifications.warn(`${item.name}: ${game.i18n.localize('GLINVSLOTS.pool.itemDepleted')}`);
            }
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-refill')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await DicePoolCalculator.refillPool(item);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-add')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await DicePoolCalculator.addDice(item, 1);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-remove')?.addEventListener('click', async (ev) => {
            ev.preventDefault();
            await DicePoolCalculator.removeDice(item, 1);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-max-size')?.addEventListener('change', async (ev) => {
            const val = parseInt(ev.target.value);
            if (!isNaN(val) && val > 0) await DicePoolCalculator.setMaxPoolSize(item, val);
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-die-type')?.addEventListener('change', async (ev) => {
            await DicePoolCalculator.setDieType(item, parseInt(ev.target.value));
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-threshold')?.addEventListener('change', async (ev) => {
            await DicePoolCalculator.setDiscardThreshold(item, parseInt(ev.target.value));
            this._refreshItemTab(sheetElement, item);
        });

        container.querySelector('.glinv-pool-current-override')?.addEventListener('change', async (ev) => {
            const val = parseInt(ev.target.value);
            if (!isNaN(val)) await DicePoolCalculator.setPoolSize(item, val);
            this._refreshItemTab(sheetElement, item);
        });
    }

    // ─── Context Menu Integration ────────────────────────────────────

    static registerContextMenus() {
        Hooks.on('dnd5e.getItemContextOptions', (item, options) => {
            if (!getSetting('enableSlotSystem')) return;
            if (!SlotCalculator._isPhysicalItem(item)) return;

            if (getSetting('enableQuickdraw')) {
                const isQd = item.getFlag(FLAG_SCOPE, 'quickdraw') || false;
                options.push({
                    name: isQd ? game.i18n.localize('GLINVSLOTS.removeQuickdraw') : game.i18n.localize('GLINVSLOTS.setQuickdraw'),
                    icon: '<i class="fas fa-bolt"></i>',
                    callback: async () => {
                        if (!isQd) {
                            const count = SlotCalculator.getQuickdrawCount(item.parent);
                            const max = SlotCalculator.getMaxQuickdrawSlots();
                            if (count >= max) {
                                ui.notifications.warn(game.i18n.format('GLINVSLOTS.quickdrawFull', { max }));
                                return;
                            }
                        }
                        await item.setFlag(FLAG_SCOPE, 'quickdraw', !isQd);
                    }
                });
            }

            if (getSetting('enableBasicSupplies')) {
                const isBasic = item.getFlag(FLAG_SCOPE, 'isBasicSupply') || false;
                options.push({
                    name: isBasic ? game.i18n.localize('GLINVSLOTS.removeBasicSupply') : game.i18n.localize('GLINVSLOTS.setBasicSupply'),
                    icon: '<i class="fas fa-campground"></i>',
                    callback: async () => {
                        await item.setFlag(FLAG_SCOPE, 'isBasicSupply', !isBasic);
                    }
                });
            }

            // ─── Ammunition Dice context menu items ──────────────
            if (getSetting('enableAmmunitionDice') && AmmoDiceCalculator.usesAmmoDice(item)) {
                options.push({
                    name: game.i18n.localize('GLINVSLOTS.ammo.rollAmmo'),
                    icon: '<i class="fas fa-dice"></i>',
                    callback: async () => {
                        await AmmoDiceCalculator.rollAmmoDie(item, true);
                    }
                });

                const currentDie = AmmoDiceCalculator.getCurrentDie(item);
                const maxDie = AmmoDiceCalculator.getMaxDie(item);
                if (currentDie < maxDie) {
                    options.push({
                        name: game.i18n.localize('GLINVSLOTS.ammo.replenishFull'),
                        icon: '<i class="fas fa-arrows-rotate"></i>',
                        callback: async () => {
                            const result = await AmmoDiceCalculator.fullReplenish(item);
                            if (!result.alreadyFull) {
                                ui.notifications.info(`${item.name}: fully replenished (${result.cost} gp)`);
                            }
                        }
                    });
                }
            }

            // ─── Dice Pool context menu items ──────────────────
            if (getSetting('enableDicePool')) {
                if (DicePoolCalculator.usesDicePool(item)) {
                    options.push({
                        name: game.i18n.localize('GLINVSLOTS.pool.rollPool'),
                        icon: '<i class="fas fa-cubes"></i>',
                        callback: async () => {
                            const result = await DicePoolCalculator.rollPool(item, true);
                            if (result.depleted) {
                                ui.notifications.warn(`${item.name}: ${game.i18n.localize('GLINVSLOTS.pool.itemDepleted')}`);
                            }
                        }
                    });

                    if (DicePoolCalculator.getPoolSize(item) < DicePoolCalculator.getMaxPoolSize(item)) {
                        options.push({
                            name: game.i18n.localize('GLINVSLOTS.pool.refill'),
                            icon: '<i class="fas fa-arrows-rotate"></i>',
                            callback: async () => {
                                await DicePoolCalculator.refillPool(item);
                                ui.notifications.info(`${item.name}: pool refilled.`);
                            }
                        });
                    }
                } else {
                    options.push({
                        name: game.i18n.localize('GLINVSLOTS.pool.useDicePool'),
                        icon: '<i class="fas fa-cubes"></i>',
                        callback: async () => {
                            await DicePoolCalculator.enableDicePool(item, true);
                            ui.notifications.info(`${item.name}: dice pool enabled.`);
                        }
                    });
                }
            }

            // ─── Wear & Tear context menu items ─────────────────
            if (getSetting('enableWearAndTear')) {
                const notches = NotchCalculator.getEffectiveNotches(item);

                options.push({
                    name: game.i18n.localize('GLINVSLOTS.notch.addNotch'),
                    icon: '<i class="fas fa-hammer"></i>',
                    callback: async () => {
                        const result = await NotchCalculator.addNotch(item);
                        await NotchCalculator.announceNotch(item, item.parent, game.i18n.localize('GLINVSLOTS.notch.addNotch'));
                        if (result.shattered) {
                            ui.notifications.warn(`${item.name} ${game.i18n.localize('GLINVSLOTS.notch.shattered')}!`);
                        }
                    }
                });

                if (notches > 0) {
                    options.push({
                        name: game.i18n.localize('GLINVSLOTS.notch.removeNotch'),
                        icon: '<i class="fas fa-wrench"></i>',
                        callback: async () => {
                            await NotchCalculator.removeNotch(item, 1);
                            ui.notifications.info(`${item.name}: 1 notch repaired.`);
                        }
                    });
                }

                if (getSetting('enableTempering')) {
                    const currentTemper = NotchCalculator.getTemper(item);
                    const temperGrades = ['none', 'pure', 'royal', 'astral'];
                    const nextGrades = temperGrades.filter(g => g !== currentTemper);

                    for (const grade of nextGrades) {
                        if (grade === 'none' && currentTemper === 'none') continue;
                        options.push({
                            name: `${game.i18n.localize('GLINVSLOTS.notch.setTemper')}: ${game.i18n.localize(`GLINVSLOTS.notch.temper.${grade}`)}`,
                            icon: '<i class="fas fa-fire"></i>',
                            callback: async () => {
                                await item.setFlag(FLAG_SCOPE, 'temper', grade);
                                ui.notifications.info(`${item.name}: ${game.i18n.localize(`GLINVSLOTS.notch.temper.${grade}`)}`);
                            }
                        });
                    }
                }
            }
        });
    }
}
