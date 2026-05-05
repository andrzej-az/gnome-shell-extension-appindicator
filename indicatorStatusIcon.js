// This file is part of the AppIndicator/KStatusNotifierItem GNOME Shell extension
//
// This program is free software; you can redistribute it and/or
// modify it under the terms of the GNU General Public License
// as published by the Free Software Foundation; either version 2
// of the License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program; if not, write to the Free Software
// Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301, USA.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Panel from 'resource:///org/gnome/shell/ui/panel.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';

import * as AppIndicator from './appIndicator.js';
import * as PromiseUtils from './promiseUtils.js';
import * as SettingsManager from './settingsManager.js';
import * as Util from './util.js';
import * as DBusMenu from './dbusMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const DEFAULT_ICON_SIZE = Panel.PANEL_ICON_SIZE || 16;

const OverflowPopup = GObject.registerClass({
    GTypeName: 'AppIndicatorOverflowPopup',
}, class OverflowPopup extends St.Widget {
    _init(sourceActor) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            visible: false,
        });

        this._sourceActor = sourceActor;

        // Background box with popup styling
        this._backgroundBin = new St.Bin({
            style_class: 'popup-menu-content',
            x_expand: true,
            y_expand: true,
        });

        // Icon container
        this._iconBox = new St.BoxLayout({
            style_class: 'popup-menu-item',
            vertical: false,
        });

        this._backgroundBin.child = this._iconBox;
        this.add_child(this._backgroundBin);

        // Add to UI group and ensure it's handled as a chrome element (on top)
        Main.layoutManager.addChrome(this);

        this._indicators = new Map();
        this._capturedEventId = 0;
    }

    open() {
        if (this.visible)
            return;

        this._updatePosition();
        this.visible = true;

        // Ensure it's on top of other siblings in the chrome layer
        this.get_parent()?.set_child_above_sibling(this, null);

        this.opacity = 0;
        this.ease({
            opacity: 255,
            duration: 200,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        // Handle clicking outside to close and Escape key
        if (this._capturedEventId === 0) {
            this._capturedEventId = global.stage.connect('captured-event', (actor, event) => {
                const type = event.type();
                if (type === Clutter.EventType.BUTTON_PRESS) {
                    const [x, y] = event.get_coords();
                    const target = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);

                    // If the clicked actor is NOT inside this popup and NOT the source button, close it
                    if (target && !this.contains(target) && !this._sourceActor.contains(target)) {
                        this.close();
                    }
                } else if (type === Clutter.EventType.KEY_PRESS) {
                    const symbol = event.get_key_symbol();
                    if (symbol === Clutter.KEY_Escape) {
                        this.close();
                        return Clutter.EVENT_STOP;
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }
    }

    close() {
        if (!this.visible)
            return;

        if (this._capturedEventId !== 0) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }

        this.ease({
            opacity: 0,
            duration: 150,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this.visible = false;
            },
        });
    }

    _updatePosition() {
        const [sourceX, sourceY] = this._sourceActor.get_transformed_position();
        const [sourceWidth, sourceHeight] = this._sourceActor.get_size();
        let monitor = Main.layoutManager.findMonitorForActor(this._sourceActor);
        if (!monitor) {
            console.log('[AppIndicator] Warning: No monitor found for source actor, using primary');
            monitor = Main.layoutManager.primaryMonitor;
        }

        if (!monitor) {
            console.log('[AppIndicator] Error: No monitor found at all!');
            return;
        }

        // Ensure popup has some styling before measurement
        this._backgroundBin.set_style('min-width: 100px; min-height: 30px; padding: 4px;');

        // Get popup size
        const [minWidth, natWidth] = this.get_preferred_width(-1);
        const [minHeight, natHeight] = this.get_preferred_height(-1);

        let x = sourceX;
        let y;

        // Check if panel is at top or bottom (rough heuristic)
        if (sourceY + sourceHeight / 2 < monitor.y + monitor.height / 2) {
            // Top panel - position below
            y = sourceY + sourceHeight;
        } else {
            // Bottom panel - position above
            y = sourceY - natHeight;
        }

        // Ensure popup stays on screen horizontally
        if (x + natWidth > monitor.x + monitor.width)
            x = monitor.x + monitor.width - natWidth;
        if (x < monitor.x)
            x = monitor.x;

        // Ensure popup stays on screen vertically
        if (y + natHeight > monitor.y + monitor.height)
            y = monitor.y + monitor.height - natHeight;
        if (y < monitor.y)
            y = monitor.y;

        this.set_position(Math.floor(x), Math.floor(y));
    }
    addIcon(statusIcon) {
        const uniqueId = statusIcon.uniqueId || 'unknown';
        const existing = this._indicators.get(uniqueId);
        if (existing) {
            if (existing === statusIcon)
                return;
            this.removeIcon(existing);
        }

        this._indicators.set(uniqueId, statusIcon);

        // Explicitly detach from previous parent
        const parent = statusIcon.get_parent();
        if (parent) {
            parent.remove_child(statusIcon);
        }

        this._iconBox.add_child(statusIcon);
        statusIcon.show();

        // Ensure we remove it if it's destroyed
        if (!statusIcon._overflowPopupDestroyId) {
            statusIcon._overflowPopupDestroyId = statusIcon.connect('destroy', () => {
                this.removeIcon(statusIcon);
            });
        }
    }

    removeIcon(statusIcon) {
        const uniqueId = statusIcon.uniqueId || 'unknown';
        if (this._indicators.get(uniqueId) === statusIcon) {
            this._indicators.delete(uniqueId);
        }

        if (statusIcon._overflowPopupDestroyId) {
            statusIcon.disconnect(statusIcon._overflowPopupDestroyId);
            delete statusIcon._overflowPopupDestroyId;
        }

        if (statusIcon.get_parent() === this._iconBox)
            this._iconBox.remove_child(statusIcon);
    }

    hasIcon(uniqueId) {
        return this._indicators.has(uniqueId);
    }

    getIconBox() {
        return this._iconBox;
    }

    getIcons() {
        return Array.from(this._indicators.values());
    }

    destroy() {
        if (this._capturedEventId !== 0) {
            global.stage.disconnect(this._capturedEventId);
            this._capturedEventId = 0;
        }
        super.destroy();
    }
});

const AppIndicatorOverflowButton = GObject.registerClass(
    class AppIndicatorOverflowButton extends St.Bin {
        _init() {
            super._init({
                reactive: true,
                can_focus: true,
                track_hover: true,
                style_class: 'panel-button',
            });

            this._icon = new St.Icon({
                icon_name: 'pan-up-symbolic',
                style_class: 'system-status-icon',
            });
            this.child = this._icon;

            // Create context menu
            this._menu = new PopupMenu.PopupMenu(this, 0.5, St.Side.TOP);
            Util.addActor(Main.uiGroup, this._menu.actor);
            this._menu.actor.hide();

            const settingsItem = new PopupMenu.PopupMenuItem(_('Settings'));
            settingsItem.connect('activate', () => {
                Main.extensionManager.openExtensionPrefs('appindicatorsupport@rgcjonas.gmail.com', '', {});
            });
            this._menu.addMenuItem(settingsItem);

            this._menuManager = new PopupMenu.PopupMenuManager(this);
            this._menuManager.addMenu(this._menu);

            // Toggle logic
            this.connect('button-press-event', (actor, event) => {
                const button = event.get_button();
                if (button === 1) { // Left click only
                    console.log('[AppIndicator] Overflow button left-clicked');
                    this._togglePopup();
                    return Clutter.EVENT_STOP;
                } else if (button === 3) { // Right click
                    console.log('[AppIndicator] Overflow button right-clicked');
                    this._menu.toggle();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            // Create custom popup
            this._popup = new OverflowPopup(this);

            // Toggle icon based on popup visibility
            this._popup.connect('notify::visible', () => {
                this._icon.icon_name = this._popup.visible ? 'pan-down-symbolic' : 'pan-up-symbolic';
            });

            // Settings listener to update icons dynamically
            const settings = SettingsManager.getDefaultGSettings();
            Util.connectSmart(settings, 'changed::overflow-icons', this, () => {
                // Icons will be re-evaluated by addIconToPanel calls
            });
            Util.connectSmart(settings, 'changed::icon-padding', this, this._updateIconPadding);
            this._updateIconPadding();
        }

        _togglePopup() {
            console.log('[AppIndicator] Toggle popup, current visible:', this._popup.visible);
            if (this._popup.visible)
                this._popup.close();
            else
                this._popup.open();
        }

        _updateIconPadding() {
            const settings = SettingsManager.getDefaultGSettings();
            const padding = settings.get_int('icon-padding');

            // Apply padding to the icon box spacing
            const iconBox = this._popup.getIconBox();
            if (padding > 0) {
                iconBox.set_style(`spacing: ${padding * 2}px;`);
            } else {
                iconBox.set_style(null);
            }
        }

        addIcon(statusIcon) {
            this._popup.addIcon(statusIcon);
            this.visible = this._popup._indicators.size > 0;
        }

        removeIcon(statusIcon) {
            this._popup.removeIcon(statusIcon);
            this.visible = this._popup._indicators.size > 0;

            // Close popup if no icons left
            if (this._popup._indicators.size === 0 && this._popup.visible) {
                this._popup.close();
            }
        }

        hasIcon(uniqueId) {
            return this._popup.hasIcon(uniqueId);
        }

        getIcons() {
            return this._popup.getIcons();
        }

        destroy() {
            if (this._menu) {
                this._menu.destroy();
                this._menu = null;
            }
            if (this._popup) {
                this._popup.destroy();
                this._popup = null;
            }
            super.destroy();
        }
    });

let _overflowButton = null;

export function getOverflowButton() {
    if (!_overflowButton) {
        _overflowButton = new AppIndicatorOverflowButton();
        _overflowButton.visible = false;

        const settings = SettingsManager.getDefaultGSettings();
        const updatePos = () => {
            if (!_overflowButton) return;

            const pos = settings.get_string('tray-pos');
            const box = (pos === 'left') ? Main.panel._leftBox : Main.panel._rightBox;
            const role = 'appindicator-overflow';

            try {
                if (Main.panel.statusArea[role]) {
                    const old = Main.panel.statusArea[role];
                    if (old !== _overflowButton) {
                        old.destroy();
                    } else {
                        old.get_parent()?.remove_child(old);
                    }
                    delete Main.panel.statusArea[role];
                }

                // Find the last indicator in the tray by matching children against statusArea
                const children = box.get_children();
                const statusArea = Main.panel.statusArea;
                let lastIndicatorIndex = -1;

                for (let i = 0; i < children.length; i++) {
                    const child = children[i];
                    // Check if this child is a registered status indicator (excluding ourselves)
                    for (const roleName in statusArea) {
                        if (statusArea[roleName] === child && roleName !== role) {
                            lastIndicatorIndex = i;
                            break;
                        }
                    }
                }

                const targetIndex = lastIndicatorIndex !== -1 ? lastIndicatorIndex + 1 : 0;
                box.insert_child_at_index(_overflowButton, targetIndex);
                Main.panel.statusArea[role] = _overflowButton;
                
                Util.Logger.debug(`[AppIndicator] Overflow button placed at index ${targetIndex} (last indicator was at ${lastIndicatorIndex})`);
            } catch (e) {
                Util.Logger.error(`[AppIndicator] Error in updatePos: ${e.message}`);
            }
        };

        updatePos();
        _overflowButton._trayPosId = settings.connect('changed::tray-pos', updatePos);

        _overflowButton.connect('destroy', () => {
            if (_overflowButton._trayPosId) {
                settings.disconnect(_overflowButton._trayPosId);
                delete _overflowButton._trayPosId;
            }
            _overflowButton = null;
        });
    }
    return _overflowButton;
}

export function destroyOverflowButton() {
    if (_overflowButton) {
        const role = 'appindicator-overflow';
        if (Main.panel.statusArea[role] === _overflowButton)
            delete Main.panel.statusArea[role];
        _overflowButton.destroy();
        _overflowButton = null;
    }
}

export function addIconToPanel(statusIcon) {
    if (!(statusIcon instanceof BaseStatusIcon))
        throw TypeError(`Unexpected icon type: ${statusIcon}`);

    // Safety check: has the icon already been destroyed/disposed?
    if (statusIcon.actor === null || statusIcon.uniqueId === 'unknown') {
        console.log('[AppIndicator] Skipping addIconToPanel for already disposed icon');
        return;
    }

    try {
        const settings = SettingsManager.getDefaultGSettings();
        const uniqueId = statusIcon.uniqueId || 'unknown';
        const stableId = statusIcon.stableId || uniqueId;
        const indicatorId = `appindicator-${uniqueId}`;

        const overflowBtn = getOverflowButton();

        // Kill any ghosts/duplicates with the same stableId
        const allExisting = [
            ...Object.values(Main.panel.statusArea),
            ...overflowBtn.getIcons()
        ];

        for (const icon of allExisting) {
            if (icon instanceof BaseStatusIcon && icon !== statusIcon) {
                if (icon.uniqueId === uniqueId) {
                    console.log(`[AppIndicator] Destroying duplicate icon for ${uniqueId}`);
                    icon.destroy();
                } else if (icon.stableId === stableId) {
                    // This might be a zombie of the same app (restarted) or a different app
                    // with a generic ID (e.g. Slack vs Element).
                    // We check if it's alive before taking any action.
                    icon._indicator.checkAlive();
                }
            }
        }

        const overflowIcons = settings.get_strv('overflow-icons') || [];
        const hiddenIcons = settings.get_strv('hidden-icons') || [];
        const shouldOverflow = overflowIcons.includes(statusIcon.settingsTitle);
        const isHidden = hiddenIcons.includes(statusIcon.settingsTitle);
        const isCurrentlyInOverflow = overflowBtn.hasIcon(uniqueId);

        // Check if it's already in the correct place in the panel
        const currentInPanel = Main.panel.statusArea[indicatorId];

        if (isHidden) {
            console.log(`[AppIndicator] ${uniqueId} is hidden, ensuring it's not shown...`);
            if (isCurrentlyInOverflow) {
                overflowBtn.removeIcon(statusIcon);
            }
            if (currentInPanel) {
                if (currentInPanel === statusIcon) {
                    statusIcon.get_parent()?.remove_child(statusIcon);
                } else {
                    currentInPanel.destroy();
                }
                delete Main.panel.statusArea[indicatorId];
            }
            statusIcon.visible = false;
        } else if (shouldOverflow) {
            if (!isCurrentlyInOverflow) {
                // Remove from panel if present
                if (currentInPanel) {
                    if (currentInPanel === statusIcon) {
                        statusIcon.get_parent()?.remove_child(statusIcon);
                    } else {
                        currentInPanel.destroy();
                    }
                    delete Main.panel.statusArea[indicatorId];
                }
                overflowBtn.addIcon(statusIcon);
            }
        } else {
            // Should be in panel
            if (isCurrentlyInOverflow) {
                console.log(`[AppIndicator] ${uniqueId} is currently in overflow, moving back to panel...`);
                overflowBtn.removeIcon(statusIcon);
            }

            const pos = settings.get_string('tray-pos');
            const box = (pos === 'left') ? Main.panel._leftBox : Main.panel._rightBox;
            const currentParent = statusIcon.get_parent();

            const isCorrectlyInPanel = currentInPanel === statusIcon;
            let shouldForceReadd = !isCorrectlyInPanel;
            if (isCorrectlyInPanel && (currentParent !== box || !statusIcon.visible || statusIcon.opacity === 0)) {
                console.log(`[AppIndicator] ${uniqueId} is in panel map but has wrong parent (${currentParent?.constructor.name}) or is hidden. Fixing...`);
                shouldForceReadd = true;
            }

            if (shouldForceReadd) {
                console.log(`[AppIndicator] ${uniqueId} adding/re-adding to panel...`);
                // Clean up any stale/wrong entries under this role
                if (currentInPanel && currentInPanel !== statusIcon) {
                    console.log(`[AppIndicator] Destroying stale instance for ${uniqueId}`);
                    currentInPanel.destroy();
                }
                delete Main.panel.statusArea[indicatorId];

                // Re-add to panel
                try {
                    if (currentParent) {
                        console.log(`[AppIndicator] Detaching ${uniqueId} from ${currentParent.constructor.name} before panel add`);
                        currentParent.remove_child(statusIcon);
                    }

                    // Use priority 1 instead of 0
                    Main.panel.addToStatusArea(indicatorId, statusIcon, 1, pos);

                    // Final safety check: if GNOME Shell failed to add it, force it manually
                    if (!statusIcon.get_parent()) {
                        box.add_child(statusIcon);
                        Main.panel.statusArea[indicatorId] = statusIcon;
                    }

                    // Aggressive visibility force
                    statusIcon.visible = true;
                    statusIcon.opacity = 255;

                    // Verification log
                    const newParent = statusIcon.get_parent();
                    console.log(`[AppIndicator] ${uniqueId} final parent: ${newParent ? newParent.constructor.name : 'NONE'}, visible: ${statusIcon.visible}`);
                } catch (e) {
                    console.log(`[AppIndicator] Failed to add ${uniqueId} to panel: ${e.message}`);
                    // Fallback: manual addition
                    if (statusIcon.get_parent() !== box) {
                        statusIcon.get_parent()?.remove_child(statusIcon);
                        box.insert_child_at_index(statusIcon, 0);
                        Main.panel.statusArea[indicatorId] = statusIcon;
                        statusIcon.visible = true;
                        statusIcon.opacity = 255;
                    }
                }
            }
        }

        // Connect to settings change to handle dynamic moving
        if (statusIcon._hiddenSignalId) {
            settings.disconnect(statusIcon._hiddenSignalId);
            delete statusIcon._hiddenSignalId;
        }

        statusIcon._hiddenSignalId = settings.connect('changed::hidden-icons', () => {
            addIconToPanel(statusIcon);
        });

        if (statusIcon._overflowSignalId) {
            settings.disconnect(statusIcon._overflowSignalId);
            delete statusIcon._overflowSignalId;
        }

        statusIcon._overflowSignalId = settings.connect('changed::overflow-icons', () => {
            addIconToPanel(statusIcon);
        });

        if (!statusIcon._trayPosSignalId) {
            statusIcon._trayPosSignalId = settings.connect('changed::tray-pos', () => {
                // Force re-add to move to new position/box
                const currentId = `appindicator-${statusIcon.uniqueId}`;
                if (Main.panel.statusArea[currentId] === statusIcon) {
                    delete Main.panel.statusArea[currentId];
                    statusIcon.get_parent()?.remove_child(statusIcon);
                }
                addIconToPanel(statusIcon);
            });
        }
    } catch (e) {
        console.log(`[AppIndicator] Error in addIconToPanel for ${statusIcon?.uniqueId}: ${e.message}`);
    }
}

export function getTrayIcons() {
    const icons = Object.values(Main.panel.statusArea).filter(
        i => i instanceof IndicatorStatusTrayIcon);

    if (_overflowButton) {
        icons.push(..._overflowButton.getIcons().filter(
            i => i instanceof IndicatorStatusTrayIcon));
    }

    return icons;
}

export function getAppIndicatorIcons() {
    const icons = Object.values(Main.panel.statusArea).filter(
        i => i instanceof IndicatorStatusIcon);

    if (_overflowButton) {
        icons.push(..._overflowButton.getIcons().filter(
            i => i instanceof IndicatorStatusIcon));
    }

    return icons;
}

export const BaseStatusIcon = GObject.registerClass(
    class IndicatorBaseStatusIcon extends PanelMenu.Button {
        _init(menuAlignment, nameText, iconActor, dontCreateMenu) {
            super._init(menuAlignment, nameText, dontCreateMenu);

            const settings = SettingsManager.getDefaultGSettings();
            Util.connectSmart(settings, 'changed::icon-opacity', this, this._updateOpacity);
            Util.connectSmart(settings, 'changed::icon-padding', this, this._updateIconPadding);
            this.connect('notify::hover', () => this._onHoverChanged());

            if (!super._onDestroy)
                this.connect('destroy', () => this._onDestroy());

            this._box = new St.BoxLayout({
                style_class: 'panel-status-indicators-box',
            });
            this.add_child(this._box);

            this._setIconActor(iconActor);
            this._showIfReady();
            this._updateIconPadding();
            this.set_style(IndicatorBaseStatusIcon.DEFAULT_STYLE);
        }

        _setIconActor(icon) {
            if (!(icon instanceof Clutter.Actor))
                throw new Error(`${icon} is not a valid actor`);

            if (this._icon && this._icon !== icon)
                this._icon.destroy();

            this._icon = icon;
            this._updateEffects();
            this._monitorIconEffects();

            if (this._icon) {
                this._box.add_child(this._icon);
                const id = this._icon.connect('destroy', () => {
                    this._icon.disconnect(id);
                    this._icon = null;
                    this._monitorIconEffects();
                });
            }
        }

        static get DEFAULT_STYLE() {
            const settings = SettingsManager.getDefaultGSettings();
            if (!settings.get_boolean('compact-mode-enabled'))
                return null; // drop to default -natural-hpadding.

            return '-natural-hpadding: 1px';
        }

        _updateCompactMode() {
            this._icon.set_style(AppIndicator.IconActor.DEFAULT_STYLE);
            this.set_style(IndicatorBaseStatusIcon.DEFAULT_STYLE);
        }

        _onDestroy() {
            if (this._icon)
                this._icon.destroy();

            if (super._onDestroy)
                super._onDestroy();
        }

        isReady() {
            throw new GObject.NotImplementedError('isReady() in %s'.format(this.constructor.name));
        }

        get icon() {
            return this._icon;
        }

        get uniqueId() {
            throw new GObject.NotImplementedError('uniqueId in %s'.format(this.constructor.name));
        }

        get stableId() {
            return this.uniqueId;
        }

        get settingsTitle() {
            throw new GObject.NotImplementedError('settingsTitle in %s'.format(this.constructor.name));
        }

        _showIfReady() {
            this.visible = this.isReady();
        }

        _onHoverChanged() {
            if (this.hover) {
                this.opacity = 255;
                if (this._icon)
                    this._icon.remove_effect_by_name('desaturate');
            } else {
                this._updateEffects();
            }
        }

        _updateOpacity() {
            const settings = SettingsManager.getDefaultGSettings();
            const userValue = settings.get_user_value('icon-opacity');
            if (userValue)
                this.opacity = userValue.unpack();
            else
                this.opacity = 255;
        }

        _updateEffects() {
            this._updateOpacity();

            if (this._icon) {
                this._updateSaturation();
                this._updateBrightnessContrast();
            }
        }

        _monitorIconEffects() {
            const settings = SettingsManager.getDefaultGSettings();
            const monitoring = !!this._iconSaturationIds;

            if (!this._icon && monitoring) {
                Util.disconnectSmart(settings, this, this._iconSaturationIds);
                delete this._iconSaturationIds;

                Util.disconnectSmart(settings, this, this._iconBrightnessIds);
                delete this._iconBrightnessIds;

                Util.disconnectSmart(settings, this, this._iconContrastIds);
                delete this._iconContrastIds;
            } else if (this._icon && !monitoring) {
                this._iconSaturationIds =
                    Util.connectSmart(settings, 'changed::icon-saturation', this,
                        this._updateSaturation);
                this._iconBrightnessIds =
                    Util.connectSmart(settings, 'changed::icon-brightness', this,
                        this._updateBrightnessContrast);
                this._iconContrastIds =
                    Util.connectSmart(settings, 'changed::icon-contrast', this,
                        this._updateBrightnessContrast);
            }
        }

        _updateSaturation() {
            const settings = SettingsManager.getDefaultGSettings();
            const desaturationValue = settings.get_double('icon-saturation');
            let desaturateEffect = this._icon.get_effect('desaturate');

            if (desaturationValue > 0) {
                if (!desaturateEffect) {
                    desaturateEffect = new Clutter.DesaturateEffect();
                    this._icon.add_effect_with_name('desaturate', desaturateEffect);
                }
                desaturateEffect.set_factor(desaturationValue);
            } else if (desaturateEffect) {
                this._icon.remove_effect(desaturateEffect);
            }
        }

        _updateBrightnessContrast() {
            const settings = SettingsManager.getDefaultGSettings();
            const brightnessValue = settings.get_double('icon-brightness');
            const contrastValue = settings.get_double('icon-contrast');
            let brightnessContrastEffect = this._icon.get_effect('brightness-contrast');

            if (brightnessValue !== 0 | contrastValue !== 0) {
                if (!brightnessContrastEffect) {
                    brightnessContrastEffect = new Clutter.BrightnessContrastEffect();
                    this._icon.add_effect_with_name('brightness-contrast', brightnessContrastEffect);
                }
                brightnessContrastEffect.set_brightness(brightnessValue);
                brightnessContrastEffect.set_contrast(contrastValue);
            } else if (brightnessContrastEffect) {
                this._icon.remove_effect(brightnessContrastEffect);
            }
        }

        _updateIconPadding() {
            const settings = SettingsManager.getDefaultGSettings();
            const padding = settings.get_int('icon-padding');

            if (padding > 0) {
                this._box.set_style(`padding-left: ${padding}px; padding-right: ${padding}px;`);
            } else {
                this._box.set_style(null);
            }
        }
    });

/*
 * IndicatorStatusIcon implements an icon in the system status area
 */
export const IndicatorStatusIcon = GObject.registerClass(
    class IndicatorStatusIcon extends BaseStatusIcon {
        _init(indicator) {
            super._init(0.5, indicator.accessibleName,
                new AppIndicator.IconActor(indicator, DEFAULT_ICON_SIZE));
            this._clickGesture?.set_enabled(false);
            this._indicator = indicator;

            this._lastClickTime = -1;
            this._lastClickX = -1;
            this._lastClickY = -1;

            this._box.add_style_class_name('appindicator-box');

            Util.connectSmart(this._indicator, 'ready', this, this._showIfReady);
            Util.connectSmart(this._indicator, 'menu', this, this._updateMenu);
            Util.connectSmart(this._indicator, 'label', this, this._updateLabel);
            Util.connectSmart(this._indicator, 'status', this, this._updateStatus);
            Util.connectSmart(this._indicator, 'reset', this, () => {
                this._updateStatus();
                this._updateLabel();
            });
            Util.connectSmart(this._indicator, 'accessible-name', this, () =>
                this.set_accessible_name(this._indicator.accessibleName));
            Util.connectSmart(this._indicator, 'command-line-ready', this, () =>
                this._updateKnownIcons());
            Util.connectSmart(this._indicator, 'destroy', this, () => this.destroy());

            this.connect('notify::visible', () => this._updateMenu());

            this._showIfReady();

            if (this._indicator.identityResolved)
                this._updateKnownIcons();
        }

        _updateKnownIcons() {
            if (!this.uniqueId)
                return;

            const settings = SettingsManager.getDefaultGSettings();
            let knownIcons = settings.get_strv('known-icons');
            const { stableId } = this;
            const title = this._indicator.friendlyTitle;
            const iconRef = this._indicator.desktopFileId || this._indicator.icon_name || '';

            console.log(`[AppIndicator] [Metadata] Updating known icons for stableId='${stableId}': title='${title}', iconRef='${iconRef}'`);

            if (!knownIcons.includes(stableId)) {
                console.log(`[AppIndicator] [Metadata] Adding '${stableId}' to known-icons`);
                knownIcons.push(stableId);
                settings.set_strv('known-icons', knownIcons);
            }

            const metadata = settings.get_value('icon-metadata').deep_unpack();

            if (!metadata[stableId] ||
                metadata[stableId][0] !== title ||
                metadata[stableId][1] !== iconRef) {

                metadata[stableId] = [title, iconRef];
                settings.set_value('icon-metadata', new GLib.Variant('a{s(ss)}', metadata));
            }
        }

        _onDestroy() {
            const settings = SettingsManager.getDefaultGSettings();

            const behaviors = settings.get_value('icon-activation-behavior').deep_unpack();
            const overflows = settings.get_strv('overflow-icons') || [];
            const hiddens = settings.get_strv('hidden-icons') || [];
            
            const title = this._indicator.friendlyTitle;
            const hasCustomBehavior = (behaviors[title] !== undefined) || (behaviors[this.stableId] !== undefined);
            const isOverflow = overflows.includes(title) || overflows.includes(this.stableId);
            const isHidden = hiddens.includes(title) || hiddens.includes(this.stableId);
            
            if (!hasCustomBehavior && !isOverflow && !isHidden) {
                const metadata = settings.get_value('icon-metadata').deep_unpack();
                if (metadata[this.stableId]) {
                    delete metadata[this.stableId];
                    settings.set_value('icon-metadata', new GLib.Variant('a{s(ss)}', metadata));
                }
                
                let knownIcons = settings.get_strv('known-icons');
                if (knownIcons.includes(this.stableId)) {
                    knownIcons = knownIcons.filter(id => id !== this.stableId);
                    settings.set_strv('known-icons', knownIcons);
                }
            }

            if (this._overflowSignalId) {
                settings.disconnect(this._overflowSignalId);
                delete this._overflowSignalId;
            }

            if (this._hiddenSignalId) {
                settings.disconnect(this._hiddenSignalId);
                delete this._hiddenSignalId;
            }

            if (this._trayPosSignalId) {
                settings.disconnect(this._trayPosSignalId);
                delete this._trayPosSignalId;
            }

            if (this._menuClient) {
                this._menuClient.disconnect(this._menuReadyId);
                this._menuClient.destroy();
                this._menuClient = null;
            }

            super._onDestroy();
        }

        get uniqueId() {
            return this._indicator.uniqueId;
        }

        get stableId() {
            return this._indicator.stableId;
        }

        get settingsTitle() {
            return this._indicator.friendlyTitle;
        }

        isReady() {
            return this._indicator && this._indicator.isReady;
        }

        _updateLabel() {
            const { label } = this._indicator;
            if (label) {
                if (!this._label || !this._labelBin) {
                    this._labelBin = new St.Bin({
                        yAlign: Clutter.ActorAlign.CENTER,
                    });
                    this._label = new St.Label();
                    Util.addActor(this._labelBin, this._label);
                    Util.addActor(this._box, this._labelBin);
                }
                this._label.set_text(label);
                if (!this._box.contains(this._labelBin))
                    Util.addActor(this._box, this._labelBin); // FIXME: why is it suddenly necessary?
            } else if (this._label) {
                this._labelBin.destroy_all_children();
                Util.removeActor(this._box, this._labelBin);
                this._labelBin.destroy();
                delete this._labelBin;
                delete this._label;
            }
        }

        _updateStatus() {
            const wasVisible = this.visible;
            this.visible = this._indicator.status !== AppIndicator.SNIStatus.PASSIVE;

            if (this.visible !== wasVisible)
                this._indicator.checkAlive().catch(logError);
        }

        _updateMenu() {
            if (this._menuClient) {
                this._menuClient.disconnect(this._menuReadyId);
                this._menuClient.destroy();
                this._menuClient = null;
                this.menu.removeAll();
            }

            if (this.visible && this._indicator.menuPath) {
                this._menuClient = new DBusMenu.Client(this._indicator.busName,
                    this._indicator.menuPath, this._indicator);

                if (this._menuClient.isReady)
                    this._menuClient.attachToMenu(this.menu);

                this._menuReadyId = this._menuClient.connect('ready-changed', () => {
                    if (this._menuClient.isReady)
                        this._menuClient.attachToMenu(this.menu);
                    else
                        this._updateMenu();
                });
            }
        }

        _showIfReady() {
            if (!this.isReady())
                return;

            // Re-evaluate known icons and panel/overflow placement once we have a stable ID
            this._updateKnownIcons();
            addIconToPanel(this);

            this._updateLabel();
            this._updateStatus();
            this._updateMenu();
        }

        _updateClickCount(event) {
            const [x, y] = event.get_coords();
            const time = event.get_time();
            const { doubleClickDistance, doubleClickTime } =
                Clutter.Settings.get_default();

            if (time > (this._lastClickTime + doubleClickTime) ||
                (Math.abs(x - this._lastClickX) > doubleClickDistance) ||
                (Math.abs(y - this._lastClickY) > doubleClickDistance))
                this._clickCount = 0;

            this._lastClickTime = time;
            this._lastClickX = x;
            this._lastClickY = y;

            this._clickCount = (this._clickCount % 2) + 1;

            return this._clickCount;
        }

        _maybeHandleDoubleClick(event) {
            if (this._indicator.supportsActivation === false)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            if (this._updateClickCount(event) === 2) {
                this._indicator.open(...event.get_coords(), event.get_time());
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }

        async _waitForDoubleClick() {
            const { doubleClickTime } = Clutter.Settings.get_default();
            this._waitDoubleClickPromise = new PromiseUtils.TimeoutPromise(
                doubleClickTime);

            try {
                await this._waitDoubleClickPromise;
                this.menu.toggle();
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    throw e;
            } finally {
                delete this._waitDoubleClickPromise;
            }
        }

        vfunc_event(event) {
            if (this.menu.numMenuItems && event.type() === Clutter.EventType.TOUCH_BEGIN)
                this.menu.toggle();

            return Clutter.EVENT_PROPAGATE;
        }

        vfunc_button_press_event(event) {
            if (this._waitDoubleClickPromise)
                this._waitDoubleClickPromise.cancel();

            // if middle mouse button clicked send SecondaryActivate dbus event and do not show appindicator menu
            if (event.get_button() === Clutter.BUTTON_MIDDLE) {
                if (Main.panel.menuManager.activeMenu)
                    Main.panel.menuManager._closeMenu(true, Main.panel.menuManager.activeMenu);
                this._indicator.secondaryActivate(event.get_time(), ...event.get_coords());
                return Clutter.EVENT_STOP;
            }

            if (event.get_button() === Clutter.BUTTON_PRIMARY) {
                const settings = SettingsManager.getDefaultGSettings();
                const behaviors = settings.get_value('icon-activation-behavior').deep_unpack();
                const behavior = behaviors[this.settingsTitle] || 0;

                if (behavior === 1) { // Show Window
                    this._indicator.open(...event.get_coords(), event.get_time());
                    return Clutter.EVENT_STOP;
                }
            }

            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                this.menu.toggle();
                return Clutter.EVENT_PROPAGATE;
            }

            const doubleClickHandled = this._maybeHandleDoubleClick(event);
            if (doubleClickHandled === Clutter.EVENT_PROPAGATE &&
                event.get_button() === Clutter.BUTTON_PRIMARY &&
                this.menu.numMenuItems) {
                if (this._indicator.supportsActivation !== false)
                    this._waitForDoubleClick().catch(logError);
                else
                    this.menu.toggle();
            }

            return Clutter.EVENT_PROPAGATE;
        }

        vfunc_scroll_event(event) {
            // Since Clutter 1.10, clutter will always send a smooth scrolling event
            // with explicit deltas, no matter what input device is used
            // In fact, for every scroll there will be a smooth and non-smooth scroll
            // event, and we can choose which one we interpret.
            if (event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH) {
                const [dx, dy] = event.get_scroll_delta();

                this._indicator.scroll(dx, dy);
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        }
    });

export const IndicatorStatusTrayIcon = GObject.registerClass(
    class IndicatorTrayIcon extends BaseStatusIcon {
        _init(icon) {
            const wmClass = icon.wm_class || 'unknown';

            // Cache IDs before calling super._init as it might trigger operations
            // that need these IDs, and more importantly, cache them for destruction
            const pid = icon.get_pid ? icon.get_pid() : (icon.pid || '0');
            this._cachedUniqueId = `legacy:${icon.wmClass || icon.wm_class || 'unknown'}:${pid}`;
            this._cachedStableId = `legacy:${icon.wmClass || icon.wm_class || 'unknown'}`;

            super._init(0.5, wmClass, icon, { dontCreateMenu: true });
            Util.Logger.debug(`Adding legacy tray icon ${this.uniqueId}`);
            this._box.add_style_class_name('appindicator-trayicons-box');
            this.add_style_class_name('appindicator-icon');
            this.add_style_class_name('tray-icon');

            this.connect('button-press-event', (_actor, _event) => {
                this.add_style_pseudo_class('active');
                return Clutter.EVENT_PROPAGATE;
            });
            this.connect('button-release-event', (_actor, event) => {
                this._icon.click(event);
                this.remove_style_pseudo_class('active');
                return Clutter.EVENT_PROPAGATE;
            });
            this.connect('key-press-event', (_actor, event) => {
                this.add_style_pseudo_class('active');
                this._icon.click(event);
                return Clutter.EVENT_PROPAGATE;
            });
            this.connect('key-release-event', (_actor, event) => {
                this._icon.click(event);
                this.remove_style_pseudo_class('active');
                return Clutter.EVENT_PROPAGATE;
            });

            Util.connectSmart(this._icon, 'destroy', this, () => {
                icon.clear_effects();
                this.destroy();
            });

            const settings = SettingsManager.getDefaultGSettings();
            Util.connectSmart(settings, 'changed::icon-size', this, this._updateIconSize);

            const themeContext = St.ThemeContext.get_for_stage(global.stage);
            Util.connectSmart(themeContext, 'notify::scale-factor', this, () =>
                this._updateIconSize());

            this._updateIconSize();
            this._updateKnownIcons();
        }

        get settingsTitle() {
            if (!this._icon)
                return 'Unknown';

            return this._icon.wm_class || this._icon.title || 'Unknown';
        }

        _updateKnownIcons() {
            if (!this.uniqueId)
                return;

            const settings = SettingsManager.getDefaultGSettings();
            let knownIcons = settings.get_strv('known-icons');
            const { stableId } = this;
            if (!knownIcons.includes(stableId)) {
                knownIcons.push(stableId);
                settings.set_strv('known-icons', knownIcons);
            }

            const metadata = settings.get_value('icon-metadata').deep_unpack();
            const title = this.settingsTitle;
            const iconName = this._icon.icon_name || '';

            if (!metadata[stableId] ||
                metadata[stableId][0] !== title ||
                metadata[stableId][1] !== iconName) {

                metadata[stableId] = [title, iconName];
                settings.set_value('icon-metadata', new GLib.Variant('a{s(ss)}', metadata));
            }
        }

        _onDestroy() {
            Util.Logger.debug(`Destroying legacy tray icon ${this.uniqueId}`);

            const settings = SettingsManager.getDefaultGSettings();

            const behaviors = settings.get_value('icon-activation-behavior').deep_unpack();
            const overflows = settings.get_strv('overflow-icons') || [];
            const hiddens = settings.get_strv('hidden-icons') || [];
            
            const title = this.settingsTitle;
            const hasCustomBehavior = (behaviors[title] !== undefined) || (behaviors[this.stableId] !== undefined);
            const isOverflow = overflows.includes(title) || overflows.includes(this.stableId);
            const isHidden = hiddens.includes(title) || hiddens.includes(this.stableId);
            
            if (!hasCustomBehavior && !isOverflow && !isHidden) {
                const metadata = settings.get_value('icon-metadata').deep_unpack();
                if (metadata[this.stableId]) {
                    delete metadata[this.stableId];
                    settings.set_value('icon-metadata', new GLib.Variant('a{s(ss)}', metadata));
                }
                
                let knownIcons = settings.get_strv('known-icons');
                if (knownIcons.includes(this.stableId)) {
                    knownIcons = knownIcons.filter(id => id !== this.stableId);
                    settings.set_strv('known-icons', knownIcons);
                }
            }

            if (this._overflowSignalId) {
                settings.disconnect(this._overflowSignalId);
                delete this._overflowSignalId;
            }

            if (this._hiddenSignalId) {
                settings.disconnect(this._hiddenSignalId);
                delete this._hiddenSignalId;
            }

            if (this._trayPosSignalId) {
                settings.disconnect(this._trayPosSignalId);
                delete this._trayPosSignalId;
            }

            if (this._waitDoubleClickPromise) {
                this._waitDoubleClickPromise.cancel();
                delete this._waitDoubleClickPromise;
            }

            super._onDestroy();
        }

        isReady() {
            return !!this._icon;
        }

        get uniqueId() {
            if (this._cachedUniqueId)
                return this._cachedUniqueId;

            if (!this._icon)
                return 'unknown';

            const pid = this._icon.get_pid ? this._icon.get_pid() : (this._icon.pid || '0');
            return `legacy:${this._icon.wmClass || this._icon.wm_class || 'unknown'}:${pid}`;
        }

        get stableId() {
            if (this._cachedStableId)
                return this._cachedStableId;

            if (!this._icon)
                return 'unknown';

            return `legacy:${this._icon.wmClass || this._icon.wm_class || 'unknown'}`;
        }

        vfunc_navigate_focus(from, direction) {
            this.grab_key_focus();
            return super.vfunc_navigate_focus(from, direction);
        }

        _getSimulatedButtonEvent(touchEvent) {
            const event = Clutter.Event.new(Clutter.EventType.BUTTON_RELEASE);
            event.set_button(1);
            event.set_time(touchEvent.get_time());
            event.set_flags(touchEvent.get_flags());
            event.set_stage(global.stage);
            event.set_source(touchEvent.get_source());
            event.set_coords(...touchEvent.get_coords());
            event.set_state(touchEvent.get_state());
            return event;
        }

        vfunc_touch_event(event) {
            // Under X11 we rely on emulated pointer events
            if (!imports.gi.Meta.is_wayland_compositor())
                return Clutter.EVENT_PROPAGATE;

            const slot = event.get_event_sequence().get_slot();

            if (!this._touchPressSlot &&
                event.get_type() === Clutter.EventType.TOUCH_BEGIN) {
                this.add_style_pseudo_class('active');
                this._touchButtonEvent = this._getSimulatedButtonEvent(event);
                this._touchPressSlot = slot;
                this._touchDelayPromise = new PromiseUtils.TimeoutPromise(
                    AppDisplay.MENU_POPUP_TIMEOUT);
                this._touchDelayPromise.then(() => {
                    delete this._touchDelayPromise;
                    delete this._touchPressSlot;
                    this._touchButtonEvent.set_button(3);
                    this._icon.click(this._touchButtonEvent);
                    this.remove_style_pseudo_class('active');
                });
            } else if (event.get_type() === Clutter.EventType.TOUCH_END &&
                this._touchPressSlot === slot) {
                delete this._touchPressSlot;
                delete this._touchButtonEvent;
                if (this._touchDelayPromise) {
                    this._touchDelayPromise.cancel();
                    delete this._touchDelayPromise;
                }

                this._icon.click(this._getSimulatedButtonEvent(event));
                this.remove_style_pseudo_class('active');
            } else if (event.get_type() === Clutter.EventType.TOUCH_UPDATE &&
                this._touchPressSlot === slot) {
                this.add_style_pseudo_class('active');
                this._touchButtonEvent = this._getSimulatedButtonEvent(event);
            }

            return Clutter.EVENT_PROPAGATE;
        }

        vfunc_leave_event(event) {
            this.remove_style_pseudo_class('active');

            if (this._touchDelayPromise) {
                this._touchDelayPromise.cancel();
                delete this._touchDelayPromise;
            }

            return super.vfunc_leave_event(event);
        }

        _updateIconSize() {
            const settings = SettingsManager.getDefaultGSettings();
            const { scaleFactor } = St.ThemeContext.get_for_stage(global.stage);
            let iconSize = settings.get_int('icon-size');

            if (iconSize <= 0)
                iconSize = DEFAULT_ICON_SIZE;

            this.height = -1;
            this._icon.set({
                width: iconSize * scaleFactor,
                height: iconSize * scaleFactor,
                xAlign: Clutter.ActorAlign.CENTER,
                yAlign: Clutter.ActorAlign.CENTER,
            });
        }
    });
