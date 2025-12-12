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

// --- Parse gdctl show output ---
function parseGdctlShow(output) {
    const lines = output.split(/\r?\n/);
    const mons = [];
    let cur = null;

    for (let ln of lines) {
        ln = ln.replace(/^[\s\u2500-\u257F]*/g, "").trim();
        const m = ln.match(/^Monitor\s+([^\s(]+)(?:\((.*)\))?/i);
        if (m) {
            if (cur) mons.push(cur);
            const id = m[1].trim();
            const desc = (m[2] || "").trim();
            const builtin = /eDP|LVDS|DSI|built-in/i.test(desc) || /eDP|LVDS|DSI/i.test(id);
            cur = { id, desc, builtin };
        }
    }
    if (cur) mons.push(cur);

    // Deduplicate
    const unique = [];
    const seen = new Set();
    for (const m of mons) {
        if (!seen.has(m.id)) { seen.add(m.id); unique.push(m); }
    }
    return unique;
}

// --- Determine current mode using Logical monitors from gdctl show ---
function determineCurrentModeFromLogical(showOutput) {
    const lines = showOutput.split(/\r?\n/);
    let logicalBlocks = [];
    let currentBlock = null;
    let collecting = false;

    for (let ln of lines) {
        const t = ln.trim();
        if (/^Logical monitor/i.test(t)) {
            if (currentBlock) logicalBlocks.push(currentBlock);
            currentBlock = { monitors: [] };
            collecting = false;
            continue;
        }
        if (/^Monitors:/i.test(t)) {
            collecting = true;
            continue;
        }
        if (collecting) {
            const m = t.match(/^([A-Za-z0-9\-_]+)/);
            if (m) currentBlock.monitors.push(m[1]);
        }
    }
    if (currentBlock) logicalBlocks.push(currentBlock);
    if (logicalBlocks.length === 0) return "unknown";

    
    if (logicalBlocks.length > 1)
        return "extend";

    const mon = logicalBlocks[0].monitors[0];
    if (/^(eDP|LVDS|DSI)/i.test(mon)) return "builtin-only";
    return "external-only";
}

// --- Build gdctl set arguments ---
function buildGdctlArgsForMode(mode, mons) {
    const builtin = mons.filter(m => m.builtin).map(m => m.id);
    const ext = mons.filter(m => !m.builtin).map(m => m.id);
    const args = ["set"]; // simplified version

    if (mode === "extend") {
        let prev = null;
        for (const m of mons) {
            args.push("--logical-monitor", "--monitor", m.id);
            if (prev) args.push("--right-of", prev);
            prev = m.id;
        }
        args.push("--primary");
        return args;
    }
    if (mode === "external-only" && ext.length) {
        args.push("--logical-monitor", "--monitor", ext[0], "--primary");
        return args;
    }
    if (mode === "builtin-only" && builtin.length) {
        args.push("--logical-monitor", "--monitor", builtin[0], "--primary");
        return args;
    }
    return null;
}

// --- gdctl run helpers ---
function runGdctlShowAsync() {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new([GDCTL, "show"], Gio.SubprocessFlags.STDOUT_PIPE);
        proc.communicate_utf8_async(null, null, (p, res) => {
            const [ok, out] = p.communicate_utf8_finish(res);
            if (!ok) reject(new Error("gdctl show failed")); else resolve(out);
        });
    });
}

function runGdctlSetAsync(args) {
    return new Promise((resolve, reject) => {
        const proc = Gio.Subprocess.new([GDCTL, ...args], Gio.SubprocessFlags.STDOUT_PIPE);
        proc.wait_async(null, (p, res) => {
            p.wait_finish(res);
            const status = p.get_exit_status();
            if (status === 0) resolve(); else reject(new Error("gdctl set failed"));
        });
    });
}

// --- UI ---
class DisplaySwitcherButton extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.0, "Simple Display Switcher");
        const icon = new St.Icon({ icon_name: "video-display-symbolic", style_class: "system-status-icon" });
        this.add_child(icon);

        this._modeItems = {};

        
        this._addModeItem("extend", "Extend displays");
        this._addModeItem("external-only", "External only");
        this._addModeItem("builtin-only", "Built-in only");
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
            const mode = determineCurrentModeFromLogical(out);
            this._setActiveMode(mode);
        } catch (e) { log("Detect mode failed: " + e); }
    }

    async _onModeSelected(mode) {
        try {
            const out = await runGdctlShowAsync();
            const mons = parseGdctlShow(out);
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
