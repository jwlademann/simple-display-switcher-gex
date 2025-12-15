import Gio from "gi://Gio";
import St from "gi://St";
import GObject from "gi://GObject";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const GDCTL = "gdctl";
const NOTIFY_TITLE = "Simple Display Switcher";
const CONFIG_FILE = "config.json";

const POSFLAG = {
    Left:  "--left-of",
    Right: "--right-of",
    Above: "--above",
    Below: "--below",
};

function getExtensionDir() {
    // import.meta.url → file:///…/extension.js
    const uri = import.meta.url.replace(/\/[^/]+$/, "");
    return Gio.File.new_for_uri(uri);
}

function loadConfig() {
    try {
        const file = getExtensionDir().get_child(CONFIG_FILE);
        const [ok, bytes] = file.load_contents(null);
        if (!ok)
            throw new Error();
        const config = JSON.parse(new TextDecoder().decode(bytes));
        if (!(config.joinPosition in POSFLAG))
            config.joinPosition = "Right";
        return config;
    } catch {
        return { joinPosition: "Right" };
    }
}

function saveConfig(config) {
    const file = getExtensionDir().get_child(CONFIG_FILE);
    file.replace_contents(
        JSON.stringify(config, null, 2),
        null,
        false,
        Gio.FileCreateFlags.REPLACE_DESTINATION,
        null
    );
}

function notify(msg) {
    try {
        Main.notify(NOTIFY_TITLE, msg);
    } catch {
        log(`${NOTIFY_TITLE}: ${msg}`);
    }
}

/* =========================
 * gdctl parsing (hardened)
 * ========================= */
function parseGdctlShow(output) {
    const mons = [];

    const monMatch = output.match(/^Monitors:\n(.*)\n\n/s);
    if (!monMatch)
        return [mons, "unknown"];

    for (let ln of monMatch[1].split(/\n/)) {
        ln = ln.trim();
        const m = ln.match(/^[\u251C\u2514]\u2500\u2500Monitor\s+([^\s(]+)(\s+\((.*)\))?/);
        if (!m)
            continue;

        const id = m[1].trim();
        const desc = (m[3] || "").trim();
        const builtin =
            /eDP|LVDS|DSI|built-in/i.test(desc) ||
            /eDP|LVDS|DSI/i.test(id);

        mons.push({ id, desc, builtin });
    }

    const lmonMatch = output.match(/\nLogical monitors:\n(.*)\n\n/s);
    if (!lmonMatch)
        return [mons, "unknown"];

    const builtins = mons.filter(m => m.builtin).map(m => m.id);
    const logicalBlocks = [];
    let current = null;
    let collecting = false;

    for (let ln of lmonMatch[1].split(/\n/)) {
        const t = ln.trim();

        if (/^[\u251C\u2514]\u2500\u2500Logical monitor/.test(t)) {
            if (current)
                logicalBlocks.push(current);
            current = { monitors: [], primary: false, builtin: false };
            collecting = false;
        } else if (/Primary: yes/.test(t)) {
            current.primary = true;
        } else if (/Monitors:/.test(t)) {
            collecting = true;
        } else if (collecting) {
            const m = t.match(/[\u251C\u2514]\u2500\u2500([A-Za-z0-9\-_]+)/);
            if (m) {
                current.monitors.push(m[1]);
                if (builtins.includes(m[1]))
                    current.builtin = true;
            }
        }
    }

    if (current)
        logicalBlocks.push(current);

    if (logicalBlocks.length === 0)
        return [mons, "unknown"];

    if (logicalBlocks.length > 1) {
        for (const lb of logicalBlocks) {
            if (lb.primary && lb.builtin)
                return [mons, "join-builtin"];
            if (lb.primary && !lb.builtin)
                return [mons, "join-external"];
        }
        return [mons, "unknown"];
    }

    return [
        mons,
        logicalBlocks[0].builtin ? "builtin" : "external",
    ];
}

/* =========================
 * gdctl invocation
 * ========================= */
function buildGdctlArgsForMode(mode, mons, joinPosition) {
    const builtin = mons.filter(m => m.builtin).map(m => m.id);
    const ext = mons.filter(m => !m.builtin).map(m => m.id);

    let list, primary;

    if (mode.startsWith("join-")) {
        list = [...builtin, ...ext];
        primary = mode === "join-external" ? ext[0] : builtin[0];
        if (!primary)
            return null;
    } else if (mode === "external") {
        list = ext;
        primary = ext[0];
    } else if (mode === "builtin") {
        list = builtin;
        primary = builtin[0];
    } else {
        return null;
    }

    const args = [];
    let prev = null;

    for (const m of list) {
        args.push("--logical-monitor", "--monitor", m);

        if (prev && mode.startsWith("join-"))
            args.push(POSFLAG[joinPosition] ?? POSFLAG.Right, prev);

        if (m === primary)
            args.push("--primary");

        prev = m;
    }

    return args;
}

function runGdctlShowAsync() {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(
            [GDCTL, "show", "-v"],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [ok, out, err] = p.communicate_utf8_finish(res);
            if (!ok)
                reject(new Error(err || "gdctl show failed"));
            else
                resolve(out);
        });
    });
}

function runGdctlSetAsync(args) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new(
            [GDCTL, "set", ...args],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );
        proc.wait_async(null, (p, res) => {
            p.wait_finish(res);
            p.get_exit_status() === 0
                ? resolve()
                : reject(new Error("gdctl set failed"));
        });
    });
}

/* =========================
 * Panel UI
 * ========================= */
class DisplaySwitcherButton extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor(config) {
        super(0.0, "Simple Display Switcher");
        this._config = config;

        this.add_child(new St.Icon({
            icon_name: "video-display-symbolic",
            style_class: "system-status-icon",
        }));

        this._modeItems = {};
        this.activeMode = null;

        this._addModeItem("join-external", "Join (External primary)");
        this._addModeItem("join-builtin", "Join (Built-in primary)");
        this._addModeItem("external", "External only");
        this._addModeItem("builtin", "Built-in only");

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._joinSubMenu = new PopupMenu.PopupSubMenuMenuItem("");
        this.menu.addMenuItem(this._joinSubMenu);

        this._joinItems = {};
        ["Left", "Right", "Above", "Below"].forEach(pos => {
            const item = new PopupMenu.PopupMenuItem(pos);
            item.connect("activate", () => {
                this._config.joinPosition = pos;
                saveConfig(this._config);
                this._updateJoinChecks();
                if (this.activeMode?.startsWith("join-"))
                    this._onModeSelected(this.activeMode);
            });
            this._joinSubMenu.menu.addMenuItem(item);
            this._joinItems[pos] = item;
        });
        this._updateJoinChecks();
        this.menu.connect("open-state-changed", (_menu, isOpen) => {
            if (isOpen) {
                this.detectActiveMode();
            }
        });
    }

    _addModeItem(id, label) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect("activate", () => this._onModeSelected(id));
        this.menu.addMenuItem(item);
        this._modeItems[id] = item;
    }

    _setActiveMode(mode) {
        for (const item of Object.values(this._modeItems)) {
            item._checkIcon?.destroy();
            item._checkIcon = null;
        }

        const sel = this._modeItems[mode];
        if (sel) {
            const icon = new St.Icon({
                icon_name: "object-select-symbolic",
                style_class: "popup-menu-icon",
            });
            sel.add_child(icon);
            sel._checkIcon = icon;
        }
        this.activeMode = mode;
    }

    async detectActiveMode() {
        try {
            const out = await runGdctlShowAsync();
            this._setActiveMode(parseGdctlShow(out)[1]);
        } catch (e) {
            log(e.message);
        }
    }

    async _onModeSelected(mode) {
        try {
            const out = await runGdctlShowAsync();
            const [mons] = parseGdctlShow(out);
            const args = buildGdctlArgsForMode(
                mode, mons, this._config.joinPosition
            );
            if (!args)
                return notify(`Cannot apply mode '${mode}'`);
            await runGdctlSetAsync(args);
            this._setActiveMode(mode);
        } catch (e) {
            notify(e.message);
        }
    }

    _updateJoinChecks() {
        this._joinSubMenu.label.text =
            `External join position (${this._config.joinPosition})`;

        for (const [pos, item] of Object.entries(this._joinItems)) {
            item._checkIcon?.destroy();
            item._checkIcon = null;
            if (pos === this._config.joinPosition) {
                const icon = new St.Icon({
                    icon_name: "object-select-symbolic",
                    style_class: "popup-menu-icon",
                });
                item.add_child(icon);
                item._checkIcon = icon;
            }
        }
    }
}

/* =========================
 * Extension entry
 * ========================= */
export default class DisplaySwitcherExtension {
    enable() {
        this._config = loadConfig();
        this._indicator = new DisplaySwitcherButton(this._config);
        Main.panel.addToStatusArea(
            "simple-display-switcher",
            this._indicator,
            1,
            "right"
        );
        this._indicator.detectActiveMode();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
