import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

function extractNameFromCmdline(cmdline) {
    if (!cmdline) return null;
    
    const args = cmdline.split(/\0|\s+/).filter(a => a.length > 0);
    const genericBinaries = new Set([
        'electron', 'gjs', 'python', 'python2', 'python3', 'perl', 
        'ruby', 'bash', 'sh', 'bwrap', 'xdg-dbus-proxy'
    ]);
    
    for (const arg of args) {
        if (arg.startsWith('-')) continue;
        
        const basename = GLib.path_get_basename(arg);
        const lower = basename.toLowerCase();
        
        if (genericBinaries.has(lower)) continue;
        
        if (['app.asar', 'main.js', 'index.js'].includes(lower)) {
            const dir = GLib.path_get_dirname(arg);
            const parentDir = GLib.path_get_basename(dir);
            if (parentDir && !['lib', 'bin', 'src', 'app', 'opt', 'usr'].includes(parentDir.toLowerCase())) {
                return parentDir;
            }
        }
        
        return basename;
    }
    return null;
}

export function findDesktopAppInfo(hints) {
    const apps = Gio.AppInfo.get_all();
    
    if (hints.AppId) {
        let appId = hints.AppId;
        if (appId.startsWith('Flatpak: ')) appId = appId.substring(9);
        const target = `${appId.toLowerCase()}.desktop`;
        
        for (const app of apps) {
            const id = app.get_id();
            if (id && id.toLowerCase() === target) {
                return app;
            }
        }
    }
    
    const execTargets = new Set();
    for (const k of ['CmdlineName', 'IconName', 'Id']) {
        if (hints[k] && typeof hints[k] === 'string') {
            let val = hints[k];
            if (val.startsWith('Flatpak: ')) val = val.substring(9);
            execTargets.add(val.toLowerCase());
        }
    }
    
    for (const app of apps) {
        const exec = app.get_executable();
        if (exec) {
            const basename = GLib.path_get_basename(exec).toLowerCase();
            if (execTargets.has(basename)) {
                return app;
            }
        }
    }
    
    for (const target of execTargets) {
        if (!target || target.length < 3) continue;
        for (const app of apps) {
            const id = app.get_id();
            if (id) {
                const lowerId = id.toLowerCase().replace('.desktop', '');
                const parts = lowerId.replace(/-/g, '.').replace(/_/g, '.').split('.');
                if (parts.includes(target)) {
                    return app;
                }
            }
        }
    }
    
    return null;
}

async function readFile(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const contents = await new Promise(resolve => {
            file.load_contents_async(null, (file_, result) => {
                try {
                    const [success, bytes] = file_.load_contents_finish(result);
                    resolve(success ? bytes : null);
                } catch (e) {
                    resolve(null);
                }
            });
        });
        if (contents) {
            return new TextDecoder().decode(contents);
        }
    } catch (e) { }
    return null;
}

export async function resolveAppIdentity(busName, props = {}) {
    const info = {
        CommandLine: null,
        CmdlineName: null,
        AppId: null,
        CGroup: null,
        Id: props.Id || null,
        Title: props.Title || null,
        Category: props.Category || null,
        Status: props.Status || null,
        IconName: props.IconName || null,
        IconThemePath: props.IconThemePath || null,
        Menu: props.Menu || null,
        DesktopAppInfo: null,
        DesktopAppName: null,
        DerivedFriendlyTitle: null
    };

    try {
        const bus = Gio.bus_get_sync(Gio.BusType.SESSION, null);
        const pidVariant = await new Promise(resolve => {
            bus.call('org.freedesktop.DBus', '/', 'org.freedesktop.DBus', 'GetConnectionUnixProcessID',
                new GLib.Variant('(s)', [busName]),
                new GLib.VariantType('(u)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (source, result) => {
                    try {
                        resolve(bus.call_finish(result));
                    } catch (e) {
                        resolve(null);
                    }
                }
            );
        });

        if (pidVariant) {
            const pid = pidVariant.deepUnpack()[0];
            
            const cmdlineData = await readFile(`/proc/${pid}/cmdline`);
            if (cmdlineData) {
                const cmdline = cmdlineData.replace(/\0/g, ' ').trim();
                info.CommandLine = cmdline;
                info.CmdlineName = extractNameFromCmdline(cmdlineData); // Extract from raw to split by \0 properly
            }

            const cgroup = await readFile(`/proc/${pid}/cgroup`);
            if (cgroup) {
                info.CGroup = cgroup.trim();
                if (cgroup.includes('app-flatpak-')) {
                    const match = cgroup.match(/app-flatpak-([a-zA-Z0-9_.]+)-[0-9]+\.scope/);
                    if (match) info.AppId = `Flatpak: ${match[1]}`;
                } else if (cgroup.includes('snap.')) {
                    const match = cgroup.match(/snap\.([^.]+)/);
                    if (match) info.AppId = `Snap: ${match[1]}`;
                } else if (cgroup.includes('.scope') && cgroup.includes('/app.slice/')) {
                    const match = cgroup.match(/\/app-([^-]+(?:-[^-]+)*?)(?:-[0-9]+)?\.scope/);
                    if (match) {
                        let appName = match[1];
                        if (appName.startsWith('gnome-')) appName = appName.substring(6);
                        info.AppId = appName;
                    }
                }
            }
        }
    } catch (e) {
        console.warn(`[AppIdentity] Error resolving process info for ${busName}: ${e}`);
    }

    if (info.AppId === 'org.chromium.Chromium' && info.CmdlineName) {
        info.AppId = info.CmdlineName;
    }

    const appInfo = findDesktopAppInfo(info);
    if (appInfo) {
        info.DesktopAppInfo = appInfo;
        info.DesktopAppName = appInfo.get_name();
    }

    // Fallback logic as requested
    let derivedTitle = info.DesktopAppName || info.Title || info.AppId || info.Id;
    
    // Still protect against empty or very generic titles overriding AppId
    if (derivedTitle && typeof derivedTitle === 'string') {
        const isGeneric = derivedTitle.toLowerCase().startsWith('chrome_status_icon_') ||
                          derivedTitle.startsWith(':') ||
                          derivedTitle.includes('StatusNotifierItem');
        if (isGeneric && info.AppId) {
            derivedTitle = info.AppId;
        }
    }
    
    if (!derivedTitle) derivedTitle = 'Unknown';
    info.DerivedFriendlyTitle = derivedTitle;

    return info;
}
