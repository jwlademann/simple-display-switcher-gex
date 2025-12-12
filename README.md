# imple Display Switcher (GNOME Extension)

A simple GNOME Shell extension that switches between display modes using `gdctl`:

- **Extend**
- **External-only**
- **Built-in only**

Mirror mode has been removed due to gdctl/mutter limitations when monitors differ in resolution.

## Requirements

- GNOME Shell 45+
- Wayland session
- `gdctl` installed (part of newer GNOME/mutter tools)

You can test gdctl with:

```bash
gdctl show
