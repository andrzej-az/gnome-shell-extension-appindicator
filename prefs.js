// -*- mode: js2; indent-tabs-mode: nil; js2-basic-offset: 4 -*-

/* exported init, buildPrefsWidget */

import Gtk from 'gi://Gtk';  // will be removed
import Gdk from 'gi://Gdk';
import * as GeneralPreferences from './preferences/generalPage.js';
import * as CustomIconPreferences from './preferences/customIconPage.js';
import * as IconBehaviorPreferences from './preferences/iconBehaviorPage.js';

import {
    ExtensionPreferences,
    gettext as _
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SettingsKey = {
    LEGACY_TRAY_ENABLED: 'legacy-tray-enabled',
    COMPACT_MODE_ENABLED: 'compact-mode-enabled',
    ICON_SIZE: 'icon-size',
    ICON_OPACITY: 'icon-opacity',
    ICON_SATURATION: 'icon-saturation',
    ICON_BRIGHTNESS: 'icon-brightness',
    ICON_CONTRAST: 'icon-contrast',
    TRAY_POS: 'tray-pos',
    CUSTOM_ICONS: 'custom-icons',
    KNOWN_ICONS: 'known-icons',
    OVERFLOW_ICONS: 'overflow-icons',
    HIDDEN_ICONS: 'hidden-icons',
    ICON_ACTIVATION_BEHAVIOR: 'icon-activation-behavior',
    ICON_METADATA: 'icon-metadata',
    ICON_PADDING: 'icon-padding',
};

export default class DockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const iconTheme = Gtk.IconTheme.get_for_display(Gdk.Display.get_default());
        if (!iconTheme.get_search_path().includes(`${this.path}/icons`))
            iconTheme.add_search_path(`${this.path}/icons`);


        const settings = this.getSettings();
        const generalPage = new GeneralPreferences.GeneralPage(settings, SettingsKey);
        const customIconPage = new CustomIconPreferences.CustomIconPage(settings, SettingsKey);
        const iconBehaviorPage = new IconBehaviorPreferences.IconBehaviorPage(settings, SettingsKey);

        window.add(generalPage);
        window.add(customIconPage);
        window.add(iconBehaviorPage);

        window.connect('close-request', () => {
            window.destroy();
        });
    }
}
