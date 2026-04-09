
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const IconBehaviorData = GObject.registerClass({
    GTypeName: 'IconBehaviorData',
    Properties: {
        'id': GObject.ParamSpec.string(
            'id',
            'Id',
            'Icon ID',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'behavior': GObject.ParamSpec.int(
            'behavior',
            'Behavior',
            'Click Behavior',
            GObject.ParamFlags.READWRITE,
            0, 2, 0 // 0: Default, 1: Show Window
        ),
        'visibility': GObject.ParamSpec.int(
            'visibility',
            'Visibility',
            'Icon Visibility',
            GObject.ParamFlags.READWRITE,
            0, 2, 0 // 0: Visible, 1: Overflow, 2: Hidden
        ),
        'title': GObject.ParamSpec.string(
            'title',
            'Title',
            'Application Title',
            GObject.ParamFlags.READWRITE,
            ''
        ),
        'icon-name': GObject.ParamSpec.string(
            'icon-name',
            'Icon Name',
            'Icon Name',
            GObject.ParamFlags.READWRITE,
            ''
        ),
    },
}, class IconBehaviorData extends GObject.Object {
    get id() { return this._id; }
    set id(value) {
        this._id = value;
        this.notify('id');
    }

    get behavior() { return this._behavior; }
    set behavior(value) {
        this._behavior = value;
        this.notify('behavior');
    }

    get visibility() { return this._visibility; }
    set visibility(value) {
        this._visibility = value;
        this.notify('visibility');
    }

    get title() { return this._title; }
    set title(value) {
        this._title = value;
        this.notify('title');
    }

    get icon_name() { return this._icon_name; }
    set icon_name(value) {
        this._icon_name = value;
        this.notify('icon-name');
    }
});

export var IconBehaviorPage = GObject.registerClass(
    class IconBehaviorPage extends Adw.PreferencesPage {
        _init(settings, settingsKey) {
            super._init({
                title: _('Icon Behavior'),
                icon_name: 'preferences-system-windows-symbolic',
                name: 'Icon Behavior Page',
            });
            this._settings = settings;
            this._settingsKey = settingsKey;

            try {
                this.group = new Adw.PreferencesGroup({
                    title: _('Icon Click Behavior'),
                    description: _('Configure what happens when you left-click on an icon.'),
                });

                this.listStore = new Gio.ListStore({ item_type: IconBehaviorData });

                this._loadIcons();

                // Sort model by title
                this.sortModel = new Gtk.SortListModel({
                    model: this.listStore,
                    sorter: new Gtk.StringSorter({
                        expression: new Gtk.PropertyExpression(IconBehaviorData, null, 'title')
                    })
                });

                this.listBox = new Gtk.ListBox({
                    selection_mode: Gtk.SelectionMode.NONE,
                    css_classes: ['boxed-list'],
                });

                // Columns alignment
                this.behaviorSizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL });
                this.visibilitySizeGroup = new Gtk.SizeGroup({ mode: Gtk.SizeGroupMode.HORIZONTAL });

                // Header Row
                const headerRow = new Adw.ActionRow({
                    title: _('Application'),
                });
                headerRow.add_css_class('header-row');
                headerRow.set_activatable(false);
                headerRow.set_selectable(false);

                const behaviorHeader = new Gtk.Label({
                    label: `<b>${_('Click Behavior')}</b>`,
                    use_markup: true,
                    xalign: 0,
                });
                const visibilityHeader = new Gtk.Label({
                    label: `<b>${_('Visibility')}</b>`,
                    use_markup: true,
                    xalign: 0,
                });

                this.behaviorSizeGroup.add_widget(behaviorHeader);
                this.visibilitySizeGroup.add_widget(visibilityHeader);

                headerRow.add_suffix(behaviorHeader);
                headerRow.add_suffix(visibilityHeader);
                headerRow.add_suffix(new Gtk.Label({ width_chars: 4 })); // Spacer for remove button

                const headerListBox = new Gtk.ListBox({
                    selection_mode: Gtk.SelectionMode.NONE,
                    css_classes: ['boxed-list'],
                    margin_bottom: 0,
                });
                headerListBox.append(headerRow);
                this.group.add(headerListBox);

                this.listBox.add_css_class('top-flush'); // We'll need some CSS to remove top border/radius if possible

                this.listBox.bind_model(this.sortModel, (iconData) => {
                    const row = new Adw.ActionRow({
                        title: iconData.title || iconData.id,
                    });

                    if (iconData.icon_name) {
                        row.add_prefix(new Gtk.Image({
                            icon_name: iconData.icon_name,
                            pixel_size: 32,
                        }));
                    }

                    const box = new Gtk.Box({ spacing: 12 });

                    const behaviorDropdown = new Gtk.DropDown({
                        model: Gtk.StringList.new([_('Default'), _('Show Window')]),
                        valign: Gtk.Align.CENTER,
                    });
                    behaviorDropdown.selected = iconData.behavior;

                    const visibilityDropdown = new Gtk.DropDown({
                        model: Gtk.StringList.new([_('Visible'), _('Overflow'), _('Hidden')]),
                        valign: Gtk.Align.CENTER,
                    });
                    visibilityDropdown.selected = iconData.visibility;

                    this.behaviorSizeGroup.add_widget(behaviorDropdown);
                    this.visibilitySizeGroup.add_widget(visibilityDropdown);

                    // Bind changes
                    behaviorDropdown.connect('notify::selected', () => {
                        iconData.behavior = behaviorDropdown.selected;
                        this._saveBehavior(iconData.title, iconData.behavior);
                    });

                    visibilityDropdown.connect('notify::selected', () => {
                        iconData.visibility = visibilityDropdown.selected;
                        this._saveVisibility(iconData.title, iconData.visibility);
                    });

                    box.append(behaviorDropdown);
                    box.append(visibilityDropdown);

                    const removeButton = new Gtk.Button({
                        icon_name: 'window-close-symbolic',
                        valign: Gtk.Align.CENTER,
                        css_classes: ['flat', 'circular'],
                        tooltip_text: _('Remove Saved Settings'),
                    });
                    removeButton.connect('clicked', () => this._removeIconSettings(iconData));
                    box.append(removeButton);

                    row.add_suffix(box);
                    return row;
                });

                this.group.add(this.listBox);
                this.add(this.group);
            } catch (e) {
                console.error('Failed to initialize IconBehaviorPage:', e);
                logError(e); // Ensure it hits the journal

                // Show error in UI
                const errorLabel = new Gtk.Label({
                    label: `Error loading settings: ${e.message}\n${e.stack}`,
                    wrap: true,
                    selectable: true,
                });
                this.add(new Adw.PreferencesGroup()); // Placeholder
                this.group = new Adw.PreferencesGroup({ title: 'Error' });
                this.group.add(errorLabel);
                this.add(this.group);
            }
        }

        _loadIcons() {
            this.listStore.remove_all();

            const knownIcons = this._settings.get_strv(this._settingsKey.KNOWN_ICONS) || [];
            const behaviors = this._settings.get_value(this._settingsKey.ICON_ACTIVATION_BEHAVIOR).deep_unpack();
            const overflowIcons = this._settings.get_strv(this._settingsKey.OVERFLOW_ICONS) || [];
            const hiddenIcons = this._settings.get_strv(this._settingsKey.HIDDEN_ICONS) || [];
            const metadata = this._settings.get_value(this._settingsKey.ICON_METADATA).deep_unpack();

            // Grouping by title
            const groupedData = new Map();

            // Process existing metadata
            Object.keys(metadata).forEach(id => {
                const info = metadata[id] || [];
                const title = info[0] || '';
                const iconName = info[1] || '';

                if (!title || title === 'Unknown')
                    return;

                if (!groupedData.has(title)) {
                    groupedData.set(title, {
                        id,
                        title,
                        iconName,
                        behavior: behaviors[title] || behaviors[id] || 0,
                        visibility: hiddenIcons.includes(title) || hiddenIcons.includes(id) ? 2
                            : (overflowIcons.includes(title) || overflowIcons.includes(id) ? 1 : 0),
                    });
                }
            });

            // Ensure we handle icons that might be in settings but not in metadata yet (unlikely but possible)
            allIds: {
                const allIds = new Set([...knownIcons, ...Object.keys(behaviors), ...overflowIcons]);
                allIds.forEach(id => {
                    const info = metadata[id];
                    if (info && info[0] && info[0] !== 'Unknown') return;

                    // If it's in behaviors or overflowIcons using its ID directly, we might want to show it
                    // but without a title it's hard. The current logic skips "Unknown".
                });
            }

            groupedData.forEach((data) => {
                const item = new IconBehaviorData();
                item.id = data.id;
                item.behavior = data.behavior;
                item.visibility = data.visibility;
                item.title = data.title;
                item.icon_name = data.iconName;
                this.listStore.append(item);
            });
        }

        _saveBehavior(title, behavior) {
            const currentBehaviors = this._settings.get_value(this._settingsKey.ICON_ACTIVATION_BEHAVIOR).deep_unpack();

            if (behavior === 0) {
                delete currentBehaviors[title];
            } else {
                currentBehaviors[title] = behavior;
            }

            this._settings.set_value(
                this._settingsKey.ICON_ACTIVATION_BEHAVIOR,
                new GLib.Variant('a{si}', currentBehaviors)
            );
        }

        _saveVisibility(title, visibility) {
            let currentOverflows = this._settings.get_strv(this._settingsKey.OVERFLOW_ICONS) || [];
            let currentHiddens = this._settings.get_strv(this._settingsKey.HIDDEN_ICONS) || [];

            const overflowIndex = currentOverflows.indexOf(title);
            const hiddenIndex = currentHiddens.indexOf(title);

            // Remove from both first to ensure mutual exclusivity
            if (overflowIndex !== -1) currentOverflows.splice(overflowIndex, 1);
            if (hiddenIndex !== -1) currentHiddens.splice(hiddenIndex, 1);

            if (visibility === 1) { // Overflow
                currentOverflows.push(title);
            } else if (visibility === 2) { // Hidden
                currentHiddens.push(title);
            }
            // else 0 (Visible): already removed from both

            this._settings.set_strv(this._settingsKey.OVERFLOW_ICONS, currentOverflows);
            this._settings.set_strv(this._settingsKey.HIDDEN_ICONS, currentHiddens);
        }

        _removeIconSettings(iconData) {
            const { title, id } = iconData;

            // 1. Behaviors
            const behaviors = this._settings.get_value(this._settingsKey.ICON_ACTIVATION_BEHAVIOR).deep_unpack();
            delete behaviors[title];
            delete behaviors[id];
            this._settings.set_value(this._settingsKey.ICON_ACTIVATION_BEHAVIOR, new GLib.Variant('a{si}', behaviors));

            // 2. Overflow
            let overflows = this._settings.get_strv(this._settingsKey.OVERFLOW_ICONS) || [];
            overflows = overflows.filter(t => t !== title && t !== id);
            this._settings.set_strv(this._settingsKey.OVERFLOW_ICONS, overflows);

            // 3. Hidden
            let hiddens = this._settings.get_strv(this._settingsKey.HIDDEN_ICONS) || [];
            hiddens = hiddens.filter(t => t !== title && t !== id);
            this._settings.set_strv(this._settingsKey.HIDDEN_ICONS, hiddens);

            // 4. Known icons
            let known = this._settings.get_strv(this._settingsKey.KNOWN_ICONS) || [];
            known = known.filter(t => t !== title && t !== id);
            this._settings.set_strv(this._settingsKey.KNOWN_ICONS, known);

            // 5. Metadata
            const metadata = this._settings.get_value(this._settingsKey.ICON_METADATA).deep_unpack();
            delete metadata[id];
            // Remove all IDs that share this title
            Object.keys(metadata).forEach(key => {
                if (metadata[key][0] === title)
                    delete metadata[key];
            });
            this._settings.set_value(this._settingsKey.ICON_METADATA, new GLib.Variant('a{s(ss)}', metadata));

            // 6. UI Update
            const [found, index] = this.listStore.find(iconData);
            if (found)
                this.listStore.remove(index);
        }
    });
