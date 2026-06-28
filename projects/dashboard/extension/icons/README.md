# Icons

Icon PNGs at the sizes Chrome expects (16, 32, 48, 128) live here when
they exist. Currently empty — Chrome will use a default placeholder icon
when the extension is loaded unpacked.

To add icons:

1. Create a 128×128 source PNG.
2. Export at the standard sizes: `icon16.png`, `icon32.png`,
   `icon48.png`, `icon128.png`.
3. Update `manifest.json` to reference them under `"icons"` and
   `"action.default_icon"`.

For now the manifest omits the `"icons"` block entirely so Chrome
falls back to its default icon — no broken image, no manifest error.