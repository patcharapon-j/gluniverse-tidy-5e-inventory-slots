import { MODULE_ID, FLAG_SCOPE, BULK_CATEGORIES, BULK_ORDER, TEMPER_GRADES, FRAGILITY, AMMO_DIE_CHAIN, DICE_POOL_DEFAULTS, DICE_POOL_DIE_TYPES, getSetting } from './settings.js';
import { SlotCalculator } from './SlotCalculator.js';
import { NotchCalculator } from './NotchCalculator.js';
import { AmmoDiceCalculator } from './AmmoDiceCalculator.js';
import { DicePoolCalculator } from './DicePoolCalculator.js';

/**
 * Handles all integration points with the Tidy 5e Sheet module.
 * Uses a floating panel attached to the bottom of the character sheet
 * to avoid Svelte re-render wipes.
 */
export class TidyIntegration {

    static _api = null;
    /** Map<actorId, HTMLElement> — floating panels keyed by actor */
    static _panels = new Map();
    /** RAF handle for position tracking */
    static _rafHandle = null;
    /** Map<itemId, HTMLElement> — floating item config panels */
    static _itemPanels = new Map();

    static init(api) {
        this._api = api;
        console.log(`${MODULE_ID} | Tidy 5e API received, registering integrations`);
        this._hookSheetRender();
        this._setupDomObserver();
        this._startPositionLoop();
    }

    // ─── Sheet Render Hooks ──────────────────────────────────────────

    static _hookSheetRender() {
        // AppV1 Classic hooks
        Hooks.on('tidy5e-sheet.renderActorSheet', (app, element, data, forced) => {
            this._processActorSheet(app, element);
        });

        Hooks.on('renderActorSheet', (app, html, data) => {
            try { if (!this._api?.isTidy5eSheet(app)) return; } catch { return; }
            const el = html instanceof jQuery ? html[0] : html;
            this._processActorSheet(app, el);
        });

        // AppV2 hooks
        Hooks.on('renderApplication', (app, options) => {
            if (!app.constructor?.name?.includes('Tidy5e')) return;
            this._processActorSheet(app, app.element);
        });

        // Item sheets (both AppV1 and V2)
        Hooks.on('renderItemSheet', (app, html, data) => {
            if (!getSetting('enableSlotSystem') && !getSetting('enableWearAndTear') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;
            const item = app.document || app.item || app.object;
            if (!item) return;
            const el = html instanceof jQuery ? html[0] : html;
            this._injectItemTab(el, item);
        });

        Hooks.on('renderApplication', (app, options) => {
            if (!getSetting('enableSlotSystem') && !getSetting('enableWearAndTear') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;
            const doc = app.document || app.item || app.object;
            if (!doc || doc.documentName !== 'Item') return;
            const el = app.element instanceof jQuery ? app.element[0] : app.element;
            if (el) this._injectItemTab(el, doc);
        });
    }

    /**
     * MutationObserver: detect Tidy5e sheet content changes (Svelte re-renders).
     * For the floating panel we only need to re-annotate bulk on rows and
     * update the panel data. We no longer inject the grid into the sheet DOM.
     */
    static _setupDomObserver() {
        const observer = new MutationObserver((mutations) => {
            if (!getSetting('enableSlotSystem') && !getSetting('enableWearAndTear') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;

            const sheetsToProcess = new Set();

            for (const mutation of mutations) {
                // Detect new content being added (Svelte render)
                for (const node of mutation.addedNodes) {
                    if (node.nodeType !== Node.ELEMENT_NODE) continue;

                    const sheet = node.closest?.('.tidy5e-sheet') ||
                        (node.classList?.contains('tidy5e-sheet') ? node : null);
                    if (!sheet) continue;

                    // Skip our own mutations
                    if (node.classList?.contains('glinv-item-slots') ||
                        node.classList?.contains('glinv-quickdraw-row')) continue;

                    sheetsToProcess.add(sheet);
                }
            }

            for (const sheet of sheetsToProcess) {
                clearTimeout(sheet._glinvTimer);
                sheet._glinvTimer = setTimeout(() => {
                    this._processSheetElement(sheet);
                }, 200);
            }
        });

        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
        this._observer = observer;

        // Scan for already-open sheets (multiple passes for Svelte timing)
        for (const delay of [500, 1500, 3000]) {
            setTimeout(() => this._scanOpenSheets(), delay);
        }
    }

    static _scanOpenSheets() {
        if (!getSetting('enableSlotSystem')) return;
        const apps = foundry.applications?.instances
            ? [...foundry.applications.instances.values()]
            : Object.values(ui.windows || {});

        for (const app of apps) {
            const name = app.constructor?.name || '';
            if (!name.includes('Tidy5e')) continue;

            const doc = app.document || app.actor;
            if (!doc || doc.documentName !== 'Actor') continue;

            this._processActorSheet(app, app.element);
        }
    }

    static _processSheetElement(sheetEl) {
        const slotsEnabled = getSetting('enableSlotSystem');
        const wearEnabled = getSetting('enableWearAndTear');
        const ammoEnabled = getSetting('enableAmmunitionDice');
        const poolEnabled = getSetting('enableDicePool');
        if (!slotsEnabled && !wearEnabled && !ammoEnabled && !poolEnabled) return;
        if (!sheetEl) return;

        const apps = foundry.applications?.instances
            ? [...foundry.applications.instances.values()]
            : Object.values(ui.windows || {});

        const app = apps.find(a => {
            const el = a.element instanceof jQuery ? a.element[0] : a.element;
            return el === sheetEl;
        });
        if (!app) return;

        const actor = app.document || app.actor;
        if (!actor) return;

        if (actor.documentName === 'Actor' && (slotsEnabled || wearEnabled || ammoEnabled || poolEnabled)) {
            if (actor.type === 'npc' && !getSetting('enableForNPCs')) return;
            if (actor.type !== 'character' && actor.type !== 'npc') return;
            if (slotsEnabled) this._updatePanel(actor, sheetEl);
            this._annotateBulkOnRows(sheetEl, actor);
        }

        if (actor.documentName === 'Item') {
            this._injectItemTab(sheetEl, actor);
        }
    }

    static _processActorSheet(app, element) {
        if (!getSetting('enableSlotSystem') && !getSetting('enableWearAndTear') && !getSetting('enableAmmunitionDice') && !getSetting('enableDicePool')) return;

        const actor = app.document || app.actor;
        if (!actor) return;

        if (actor.documentName === 'Actor') {
            if (actor.type === 'npc' && !getSetting('enableForNPCs')) return;
            if (actor.type !== 'character' && actor.type !== 'npc') return;

            const el = element instanceof jQuery ? element[0] : element;
            if (!el) return;

            try {
                if (getSetting('enableSlotSystem')) this._updatePanel(actor, el);
                this._annotateBulkOnRows(el, actor);
            } catch (err) {
                console.error(`${MODULE_ID} | Error processing actor sheet:`, err);
            }
        }
    }

    // ─── Floating Panel ──────────────────────────────────────────────

    /**
     * Create or update the floating slot panel for an actor.
     * The panel lives in document.body, completely outside Svelte's control.
     */
    static _updatePanel(actor, sheetEl) {
        const inventory = SlotCalculator.calculateInventory(actor);
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

        // Get or create the panel element
        let panel = this._panels.get(actor.id);
        if (!panel) {
            panel = document.createElement('div');
            panel.classList.add('glinv-floating-panel');
            panel.dataset.actorId = actor.id;
            document.body.appendChild(panel);
            this._panels.set(actor.id, panel);
        }

        // Detect theme from sheet element
        const isQuadrone = sheetEl.classList.contains('quadrone');
        const isDark = sheetEl.classList.contains('theme-dark') || sheetEl.classList.contains('tidy5e-dark');
        panel.classList.toggle('glinv-panel-quadrone', isQuadrone);
        panel.classList.toggle('glinv-panel-dark', isDark);

        // Copy --t5e-* CSS variables from sheet to panel for theme matching
        const sheetStyles = getComputedStyle(sheetEl);
        const t5eVars = [
            '--t5e-background',
            '--t5e-faint-color',
            '--t5e-primary-color',
            '--t5e-secondary-color',
            '--t5e-primary-accent-color',
            '--t5e-header-background',
            '--t5e-separator-color',
            '--t5e-inspiration-inspired-text-shadow-color',
            '--t5e-body-font-family',
        ];
        for (const v of t5eVars) {
            const val = sheetStyles.getPropertyValue(v);
            if (val) panel.style.setProperty(v, val);
        }

        // Update class states
        panel.classList.remove('glinv-overburdened', 'glinv-encumbered', 'glinv-heavy');
        if (stateClass) panel.classList.add(stateClass);

        panel.title = tooltip;
        panel.innerHTML = innerHtml;

        // Store reference to the sheet element for positioning
        panel._sheetEl = sheetEl;
        panel.style.display = '';

        // Bind settings button
        const btn = panel.querySelector('[data-glinv-settings]');
        if (btn) {
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                this._openSettingsDialog(actor);
            });
        }

        // Position immediately
        this._positionPanel(panel);
    }

    /**
     * Position a floating panel at the bottom of its associated sheet.
     */
    static _positionPanel(panel) {
        const sheetEl = panel._sheetEl;
        if (!sheetEl || !sheetEl.isConnected) {
            panel.style.display = 'none';
            return;
        }

        const rect = sheetEl.getBoundingClientRect();
        const panelWidth = rect.width;

        panel.style.position = 'fixed';
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.bottom}px`;
        panel.style.width = `${panelWidth}px`;
        panel.style.zIndex = String((parseInt(sheetEl.style.zIndex) || 100) - 1);
    }

    /**
     * Continuous position tracking loop — keeps panels anchored to their sheets.
     * Also removes panels for sheets that have been closed.
     */
    static _startPositionLoop() {
        const tick = () => {
            // Actor sheet panels (bottom)
            for (const [actorId, panel] of this._panels) {
                const sheetEl = panel._sheetEl;
                if (!sheetEl || !sheetEl.isConnected) {
                    panel.remove();
                    this._panels.delete(actorId);
                    continue;
                }
                this._positionPanel(panel);
            }
            // Item sheet panels (right side)
            for (const [itemId, panel] of this._itemPanels) {
                const sheetEl = panel._sheetEl;
                if (!sheetEl || !sheetEl.isConnected) {
                    panel.remove();
                    this._itemPanels.delete(itemId);
                    continue;
                }
                this._positionItemPanel(panel);
            }
            this._rafHandle = requestAnimationFrame(tick);
        };
        this._rafHandle = requestAnimationFrame(tick);
    }

    /**
     * Remove a panel for a specific actor (e.g., when settings change).
     */
    static _removePanel(actorId) {
        const panel = this._panels.get(actorId);
        if (panel) {
            panel.remove();
            this._panels.delete(actorId);
        }
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
            </form>`;

        const parseForm = (root) => ({
            sizeOverride: root.querySelector('[name="sizeOverride"]')?.value || '',
            maxSlotsOverride: root.querySelector('[name="maxSlotsOverride"]')?.value || ''
        });

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
            result = await Dialog.prompt({
                title: `${game.i18n.localize('GLINVSLOTS.inventorySlots')} — ${actor.name}`,
                content,
                callback: (html) => parseForm(html instanceof jQuery ? html[0] : html)
            });
        }

        if (!result) return;

        if (result.sizeOverride) await actor.setFlag(FLAG_SCOPE, 'sizeOverride', result.sizeOverride);
        else await actor.unsetFlag(FLAG_SCOPE, 'sizeOverride');

        const maxVal = parseInt(result.maxSlotsOverride);
        if (!isNaN(maxVal) && maxVal > 0) await actor.setFlag(FLAG_SCOPE, 'maxSlotsOverride', maxVal);
        else await actor.unsetFlag(FLAG_SCOPE, 'maxSlotsOverride');
    }

    // ─── Inline Slot Squares on Item Rows ────────────────────────────

    static _annotateBulkOnRows(element, actor) {
        element.querySelectorAll('.glinv-item-slots').forEach(el => el.remove());
        element.querySelectorAll('.glinv-notch-indicator').forEach(el => el.remove());
        element.querySelectorAll('.glinv-ammo-indicator').forEach(el => el.remove());
        element.querySelectorAll('.glinv-pool-indicator').forEach(el => el.remove());
        element.querySelectorAll('.glinv-quickdraw-row').forEach(el => el.classList.remove('glinv-quickdraw-row'));

        const rows = element.querySelectorAll('[data-tidy-sheet-part="item-table-row"]');
        const wearEnabled = getSetting('enableWearAndTear');

        for (const row of rows) {
            const container = row.closest('[data-item-id]');
            const itemId = container?.dataset.itemId;
            if (!itemId) continue;

            const item = actor.items.get(itemId);
            if (!item) continue;
            if (!SlotCalculator._isPhysicalItem(item)) continue;

            const isBasic = SlotCalculator.isBasicSupply(item);
            const isQuickdraw = SlotCalculator.isQuickdraw(item);

            const bulk = SlotCalculator._isArmor(item)
                ? SlotCalculator.getArmorBulk(item, actor)
                : SlotCalculator.getItemBulk(item, actor);

            const totalBulk = SlotCalculator._isArmor(item)
                ? bulk * (item.system.quantity ?? 1)
                : SlotCalculator.getItemTotalBulk(item, actor);

            // Gold glow on quickdraw rows
            if (isQuickdraw) {
                const rowContainer = row.closest('[data-item-id]') || row;
                rowContainer.classList.add('glinv-quickdraw-row');
            }

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

            nameCell.insertAdjacentHTML('beforeend', slotsHtml);

            // ─── Notch Indicators ────────────────────────────────────
            if (wearEnabled) {
                const notchHtml = this._buildNotchIndicator(item);
                if (notchHtml) nameCell.insertAdjacentHTML('beforeend', notchHtml);
            }

            // ─── Ammo Dice Indicators ────────────────────────────────
            if (getSetting('enableAmmunitionDice')) {
                const ammoHtml = this._buildAmmoIndicator(item);
                if (ammoHtml) nameCell.insertAdjacentHTML('beforeend', ammoHtml);
            }

            // ─── Dice Pool Indicators ────────────────────────────────
            if (getSetting('enableDicePool')) {
                const poolHtml = this._buildDicePoolIndicator(item);
                if (poolHtml) nameCell.insertAdjacentHTML('beforeend', poolHtml);
            }
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

    // ─── Item Config Floating Panel ─────────────────────────────────

    /**
     * Create or update a compact floating panel attached to the right side
     * of the item sheet. Lives in document.body to survive Svelte re-renders.
     */
    static _injectItemTab(element, item) {
        if (!element) return;

        const nonPhysical = ['spell', 'feat', 'class', 'subclass', 'background', 'race', 'facility'];
        if (nonPhysical.includes(item.type)) return;

        let panel = this._itemPanels.get(item.id);
        if (!panel) {
            panel = document.createElement('div');
            panel.classList.add('glinv-item-panel');
            panel.dataset.itemId = item.id;
            document.body.appendChild(panel);
            this._itemPanels.set(item.id, panel);
        }

        // Copy theme from sheet
        const isDark = element.classList.contains('theme-dark') || element.classList.contains('tidy5e-dark');
        const isQuadrone = element.classList.contains('quadrone');
        panel.classList.toggle('glinv-panel-dark', isDark);
        panel.classList.toggle('glinv-panel-quadrone', isQuadrone);

        const sheetStyles = getComputedStyle(element);
        const t5eVars = [
            '--t5e-background', '--t5e-faint-color', '--t5e-primary-color',
            '--t5e-secondary-color', '--t5e-primary-accent-color',
            '--t5e-header-background', '--t5e-separator-color', '--t5e-body-font-family',
        ];
        for (const v of t5eVars) {
            const val = sheetStyles.getPropertyValue(v);
            if (val) panel.style.setProperty(v, val);
        }

        // Build content
        let html = '<div class="glinv-item-panel-inner">';
        if (getSetting('enableSlotSystem')) html += this._buildBulkConfigHtml(item);
        if (getSetting('enableWearAndTear')) html += this._buildNotchConfigHtml(item);
        if (getSetting('enableAmmunitionDice')) html += this._buildAmmoConfigHtml(item);
        if (getSetting('enableDicePool')) html += this._buildDicePoolConfigHtml(item);
        html += '</div>';

        panel.innerHTML = html;
        panel._sheetEl = element;
        panel.style.display = '';

        // Bind events
        this._bindAllTabEvents(panel, item, element);

        // Position immediately
        this._positionItemPanel(panel);
    }

    /**
     * Position an item panel to the right of its item sheet.
     */
    static _positionItemPanel(panel) {
        const sheetEl = panel._sheetEl;
        if (!sheetEl || !sheetEl.isConnected) {
            panel.style.display = 'none';
            return;
        }

        const rect = sheetEl.getBoundingClientRect();
        panel.style.position = 'fixed';
        panel.style.left = `${rect.right + 4}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.maxHeight = `${rect.height}px`;
        panel.style.zIndex = String((parseInt(sheetEl.style.zIndex) || 100) - 1);
    }

    /**
     * Rebuild floating item panel content (for real-time updates).
     */
    static _refreshItemTab(element, item) {
        const panel = this._itemPanels.get(item.id);
        if (!panel) return;

        let html = '<div class="glinv-item-panel-inner">';
        if (getSetting('enableSlotSystem')) html += this._buildBulkConfigHtml(item);
        if (getSetting('enableWearAndTear')) html += this._buildNotchConfigHtml(item);
        if (getSetting('enableAmmunitionDice')) html += this._buildAmmoConfigHtml(item);
        if (getSetting('enableDicePool')) html += this._buildDicePoolConfigHtml(item);
        html += '</div>';

        panel.innerHTML = html;
        this._bindAllTabEvents(panel, item, element);
    }

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

        return `
            <div class="glinv-item-config glinv-ammo-config" data-glinv-section="ammo">
                <h4 class="glinv-config-header">
                    <i class="fas fa-bullseye"></i> ${game.i18n.localize('GLINVSLOTS.ammo.config')}
                </h4>
                ${isEmpty ? `<div class="glinv-shattered-banner glinv-ammo-empty-banner">
                    <i class="fas fa-times-circle"></i> ${game.i18n.localize('GLINVSLOTS.ammo.empty')}
                </div>` : ''}
                <div class="glinv-item-fields">
                    <div class="glinv-ammo-status">
                        <div class="glinv-ammo-die-display ${dieVisualClass}">
                            <i class="fas fa-dice-d20"></i>
                            <span class="glinv-ammo-die-label">${dieLabel}</span>
                        </div>
                        <span class="glinv-ammo-max">/ d${maxDie}</span>
                    </div>
                    <div class="glinv-ammo-controls">
                        <button type="button" class="glinv-ammo-roll" ${isEmpty ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}">
                            <i class="fas fa-dice"></i> ${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}
                        </button>
                        <button type="button" class="glinv-ammo-replenish" ${currentDie >= maxDie ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.ammo.replenish')}">
                            <i class="fas fa-plus"></i> ${game.i18n.localize('GLINVSLOTS.ammo.replenish')}
                        </button>
                    </div>
                    <div class="glinv-ammo-controls">
                        <button type="button" class="glinv-ammo-replenish-full" ${currentDie >= maxDie ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.ammo.replenishFull')}">
                            <i class="fas fa-arrows-rotate"></i> ${game.i18n.localize('GLINVSLOTS.ammo.replenishFull')}
                        </button>
                        <button type="button" class="glinv-ammo-reset"
                                title="${game.i18n.localize('GLINVSLOTS.ammo.reset')}">
                            <i class="fas fa-undo"></i> ${game.i18n.localize('GLINVSLOTS.ammo.reset')}
                        </button>
                    </div>
                    ${replenishCost > 0 ? `<div class="glinv-repair-info">
                        <small>${game.i18n.localize('GLINVSLOTS.ammo.replenishCost')}: ${replenishCost} gp (${game.i18n.localize('GLINVSLOTS.ammo.replenishFull')})</small>
                    </div>` : ''}
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.ammo.maxDie')}</label>
                        <select class="glinv-ammo-max-die">${dieOptions}</select>
                    </div>
                    ${game.user.isGM ? `<div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.ammo.currentDie')} (GM)</label>
                        <select class="glinv-ammo-current-die">${currentDieOptions}</select>
                    </div>` : ''}
                    <div class="glinv-item-field glinv-checkbox-field">
                        <label>
                            <input type="checkbox" class="glinv-ammo-individual-toggle" ${trackIndividual ? 'checked' : ''}>
                            <i class="fas fa-hashtag"></i> ${game.i18n.localize('GLINVSLOTS.ammo.trackIndividual')}
                        </label>
                        <small class="glinv-field-hint">${game.i18n.localize('GLINVSLOTS.ammo.trackIndividualHint')}</small>
                    </div>
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
            return `<option value="${a.id}" ${a.id === pairedAmmoId ? 'selected' : ''}>${a.name}${dieLabel}</option>`;
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
                        <span class="glinv-ammo-paired-name">${pairedAmmo.name}</span>
                    </div>
                    <div class="glinv-ammo-controls">
                        <button type="button" class="glinv-ammo-roll-paired" ${isEmpty ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}">
                            <i class="fas fa-dice"></i> ${game.i18n.localize('GLINVSLOTS.ammo.rollAmmo')}
                        </button>
                    </div>`;
            } else if (pairedAmmo) {
                pairedStatusHtml = `<div class="glinv-repair-info">
                    <small>${pairedAmmo.name} — ${game.i18n.localize('GLINVSLOTS.ammo.trackIndividual')}</small>
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

        return `
            <div class="glinv-item-config glinv-pool-config" data-glinv-section="pool">
                <h4 class="glinv-config-header">
                    <i class="fas fa-cubes"></i> ${game.i18n.localize('GLINVSLOTS.pool.config')}
                </h4>
                ${depleted ? `<div class="glinv-shattered-banner glinv-pool-depleted-banner">
                    <i class="fas fa-skull"></i> ${game.i18n.localize('GLINVSLOTS.pool.depleted')}
                </div>` : ''}
                <div class="glinv-item-fields">
                    <div class="glinv-pool-status">
                        <div class="glinv-pool-display ${stateClass}">
                            <i class="fas fa-cubes"></i>
                            <span class="glinv-pool-label">${label}</span>
                        </div>
                        <span class="glinv-pool-fraction">${poolSize} / ${maxSize}</span>
                    </div>
                    ${diceVisHtml}
                    <div class="glinv-pool-controls">
                        <button type="button" class="glinv-pool-roll" ${depleted ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.pool.rollPool')}">
                            <i class="fas fa-dice"></i> ${game.i18n.localize('GLINVSLOTS.pool.rollPool')}
                        </button>
                        <button type="button" class="glinv-pool-refill" ${poolSize >= maxSize ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.pool.refill')}">
                            <i class="fas fa-arrows-rotate"></i> ${game.i18n.localize('GLINVSLOTS.pool.refill')}
                        </button>
                    </div>
                    <div class="glinv-pool-controls">
                        <button type="button" class="glinv-pool-add" ${poolSize >= maxSize ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.pool.addDie')}">
                            <i class="fas fa-plus"></i> ${game.i18n.localize('GLINVSLOTS.pool.addDie')}
                        </button>
                        <button type="button" class="glinv-pool-remove" ${depleted ? 'disabled' : ''}
                                title="${game.i18n.localize('GLINVSLOTS.pool.removeDie')}">
                            <i class="fas fa-minus"></i> ${game.i18n.localize('GLINVSLOTS.pool.removeDie')}
                        </button>
                    </div>
                    <div class="glinv-pool-info">
                        <small>${game.i18n.localize('GLINVSLOTS.pool.discardHint')} (${threshold === 1 ? '1 only' : `1-${threshold}`})</small>
                    </div>
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.pool.maxPool')}</label>
                        <input type="number" class="glinv-pool-max-size" value="${maxSize}" min="1" max="99" step="1">
                    </div>
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.pool.dieType')}</label>
                        <select class="glinv-pool-die-type">${dieTypeOptions}</select>
                    </div>
                    <div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.pool.discardThreshold')}</label>
                        <select class="glinv-pool-threshold">${thresholdOptions}</select>
                    </div>
                    ${game.user.isGM ? `<div class="glinv-item-field">
                        <label>${game.i18n.localize('GLINVSLOTS.pool.currentPool')} (GM)</label>
                        <input type="number" class="glinv-pool-current-override" value="${poolSize}" min="0" max="${maxSize}" step="1">
                    </div>` : ''}
                    <div class="glinv-item-field glinv-checkbox-field">
                        <label>
                            <input type="checkbox" class="glinv-pool-toggle" checked>
                            <i class="fas fa-cubes"></i> ${game.i18n.localize('GLINVSLOTS.pool.useDicePool')}
                        </label>
                    </div>
                </div>
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
