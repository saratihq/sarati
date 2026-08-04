# App-icon provenance

The node/app icons in [`app-icons.json`](app-icons.json) are **self-hosted** inline SVGs —
served directly by `src/icons/icons.controller.ts` with no external CDN and no outbound fetch.
Regenerate the map with `node scripts/build-icons.mjs` (reproducible recipe; the sources below are
build-time dev dependencies, not runtime dependencies).

## Sources

| Source | Used for | Artwork license |
|---|---|---|
| **Iconify `logos`** (`@iconify-json/logos`; the "SVG Logos" collection by Gil Barbara) | Full-colour brand marks — the primary source (~60 apps), incl. brands Simple Icons dropped | **CC0-1.0** |
| **Simple Icons** (`simple-icons`) | Single brand-colour marks for apps `logos` lacks (~18; mostly Google Workspace + long-tail) | **CC0-1.0** |
| **Own artwork** (generated in the client `NodeIcon`) | Monogram tiles for apps with no self-hosted logo (~13); lucide glyphs for control/utility nodes | Project license |

The **artwork bytes** above are CC0 / our own. The **brands they depict** remain the trademarks of
their respective owners — see [`TRADEMARKS.md`](../../../TRADEMARKS.md). Marks are shown unmodified, in
their own colours, on a neutral tile, nominatively (to identify an integration).

## Notes

- We do **not** pin an old Simple Icons version to recover marks its owners had removed — those come
  from the `logos` set (its own artwork) or fall back to a monogram.
- Apps with no clean self-hosted source today render a monogram tile (e.g. Outlook, Excel, SharePoint,
  DocuSign, ServiceNow, and long-tail apps). Adding a real mark later is a one-line map edit in
  `scripts/build-icons.mjs`; removing one (on a trademark owner's request) is the same — the app falls
  back to its monogram with no layout change.
