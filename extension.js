import Gio from "gi://Gio";
import St from "gi://St";
import GObject from "gi://GObject";

import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

const GDCTL = "gdctl";
const NOTIFY_TITLE = "Simple Display Switcher";

function notify(msg) {
    try { Main.notify(NOTIFY_TITLE, msg); }
    catch (e) { log(msg); }
}

function parseGdctlShow(output) {
    const mon_match = output.match(/^Monitors:\n(.*)\n\n/s);
    const mon_lines = mon_match[1].split(/\n/);
    const mons = [];

    for (let ln of mon_lines) {
        ln = ln.trim();
        const mon_match = ln.match(/^[\u251C\u2514]\u2500\u2500Monitor\s+([^\s(]+)(\s+\((.*)\))?/);
        if (mon_match) {
            const id = mon_match[1].trim();
            const desc = (mon_match[3] || "").trim();
            const builtin = /eDP|LVDS|DSI|built-in/i.test(desc) || /eDP|LVDS|DSI/i.test(id);
            mons.push({ id, desc, builtin });
        }
    }
    
    const lmon_match = output.match(/\nLogical monitors:\n(.*)\n\n/s);
    const lmon_lines = lmon_match[1].split(/\n/);
    let logicalBlocks = [];
    let currentBlock = null;
    let collecting = false;
    const builtins = mons.filter(m => m.builtin).map(m => m.id);

    for (let ln of lmon_lines) {
        const t = ln.trim();
        if (/^[\u251C\u2514]\u2500\u2500Logical monitor/.test(t)) {
            if (currentBlock) {
                logicalBlocks.push(currentBlock);
            }
            currentBlock = { monitors: [], primary: false, builtin: false };
            collecting = false;
        } else if (/^[\s\u2502]\s{2}[\u251C\u2514]\u2500\u2500Primary: yes/.test(t)) {
            currentBlock.primary = true;
        } else if (/^[\s\u2502]\s{2}[\u251C\u2514]\u2500\u2500Monitors:/.test(t)) {
            collecting = true;
        } else if (collecting) {
            const m = t.match(/^[\s\u2502]\s{2}[\s\u2502]\s{3}[\u251C\u2514]\u2500\u2500([A-Za-z0-9\-_]+)/);
            if (m) {
                currentBlock.monitors.push(m[1]);
                if (builtins.includes(m[1])) {
                    currentBlock["builtin"] = true;
                }
            }
        }
    }
    if (currentBlock) {
        logicalBlocks.push(currentBlock);
    }

    if (logicalBlocks.length === 0) {
        return [mons, "unknown"];
    }
    if (logicalBlocks.length > 1) {
        for (let lb of logicalBlocks) {
            if (lb.primary && lb.builtin) {
                return [mons, "join-builtin"]
            }
            if (lb.primary && !lb.builtin) {
                return [mons, "join-external"]
            }
        }
        return [mons, "unknown"];
    }
    if (logicalBlocks.length === 1) {
        for (let lb of logicalBlocks) {
            if (logicalBlocks[0].builtin) {
                return [mons, "builtin"]
            }
            if (!logicalBlocks[0].builtin) {
                return [mons, "external"]
            }
        }
    }
    
    return mons;
}

function buildGdctlArgsForMode(mode, mons) {
    const builtin = mons.filter(m => m.builtin).map(m => m.id);
    const ext = mons.filter(m => !m.builtin).map(m => m.id);
    let mon_list = null;
    let primary = null;
    const args = [];
    if (mode.startsWith("join-")) {
        mon_list = [...builtin, ...ext];
        if (mode == "join-external" && ext.length) {
            primary = ext[0];
        } else if (mode == "join-builtin" && builtin.length) {
            primary = builtin[0]
        } else {
            return null;
        }
    } else if (mode == "external" && ext.length) {
        mon_list = ext;
        primary = ext[0];
    } else if (mode == "builtin" && builtin.length) {
        mon_list = builtin;
        primary = builtin[0];
    } else {
        return null;
    }
    let prev = null;
    for (let m of mon_list) {
        args.push("--logical-monitor", "--monitor", m);
        if (prev) {
            args.push("--left-of", prev);
        }
        if (m == primary) {
            args.push("--primary");
        }
        prev = m;
    }
    return args;
}

function runGdctlShowAsync() {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new([GDCTL, "show", "-v"], Gio.SubprocessFlags.STDOUT_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [ok, out] = p.communicate_utf8_finish(res);
            if (!ok) reject(new Error("gdctl show failed")); else resolve(out);
        });
    });
}

function runGdctlSetAsync(args) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new([GDCTL, "set", ...args], Gio.SubprocessFlags.STDOUT_PIPE);
        proc.wait_async(null, (p, res) => {
            p.wait_finish(res);
            const status = p.get_exit_status();
            if (status === 0) resolve(); else reject(new Error("gdctl set failed"));
        });
    });
}

class DisplaySwitcherButton extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.0, "Simple Display Switcher");
        const icon = new St.Icon({ icon_name: "video-display-symbolic", style_class: "system-status-icon" });
        this.add_child(icon);

        this._modeItems = {};

        this._addModeItem("join-external", "Join (External primary)");
        this._addModeItem("join-builtin", "Join (Built-in primary)");
        this._addModeItem("external", "External only");
        this._addModeItem("builtin", "Built-in only");
    }

    _addModeItem(modeId, label) {
        const item = new PopupMenu.PopupMenuItem(label);
        item.connect("activate", () => this._onModeSelected(modeId));
        this.menu.addMenuItem(item);
        this._modeItems[modeId] = item;
    }

    _setActiveMode(mode) {
        for (const key in this._modeItems) {
            const item = this._modeItems[key];
            if (item._checkIcon) { item._checkIcon.destroy(); item._checkIcon = null; }
        }
        const sel = this._modeItems[mode];
        if (sel) {
            const icon = new St.Icon({ icon_name: "object-select-symbolic", style_class: "popup-menu-icon" });
            sel.add_child(icon);
            sel._checkIcon = icon;
        }
    }

    async detectActiveMode() {
        try {
            const out = await runGdctlShowAsync();
            const mode = parseGdctlShow(out)[1];
            this._setActiveMode(mode);
        } catch (e) { log("Detect mode failed: " + e); }
    }

    async _onModeSelected(mode) {
        try {
            const out = await runGdctlShowAsync();
            const mons = parseGdctlShow(out)[0];
            const args = buildGdctlArgsForMode(mode, mons);
            if (!args) return notify(`Cannot apply mode '${mode}'.`);
            await runGdctlSetAsync(args);
            this._setActiveMode(mode);
            notify(`Switched to ${mode}.`);
        } catch (e) {
            notify(`Error: ${e.message}`);
        }
    }
}

export default class DisplaySwitcherExtension {
    constructor() { this._indicator = null; }

    enable() {
        this._indicator = new DisplaySwitcherButton();
        Main.panel.addToStatusArea("simple-display-switcher", this._indicator, 1, "right");
        this._indicator.detectActiveMode();
    }

    disable() {
        if (this._indicator) { this._indicator.destroy(); this._indicator = null; }
    }
}
