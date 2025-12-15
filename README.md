# Simple Display Switcher

A GNOME Shell extension that provides a panel menu for quickly switching
display layouts using `gdctl`.

## Features
- Built-in only
- External only
- Joined displays (built-in or external primary)
- Configurable join position (left, right, above, below)
- Automatic state detection when opening the menu

## Requirements
- GNOME Shell 45+
- `gdctl` available in PATH (GNOME 45+)

## Notes
This extension uses `gdctl` to control display layouts and does not use
GSettings or Mutter private APIs.
