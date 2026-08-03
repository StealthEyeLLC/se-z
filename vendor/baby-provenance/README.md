# Baby provenance records

This directory contains machine-readable lineage for the exact deployed migration sources. It intentionally contains historical Baby names.

- `source-identities.json` pins deployed repository, commit, tree, manifest, and archive identities.
- `source-map.json` inventories every tracked source-tree file and its runtime purpose, dependencies, tests, and planned target disposition.
- `file-map.json` maps each copied or derived destination to an exact source SHA-256 and transformation class.
- `license-map.json` records notices and the same-owner proprietary-copy basis.
- `rename-map.json` separates direct identity conversion from nonmechanical canonical adaptation.

These records are evidence, not runtime dependencies. Generated source checkouts, build products, modules, keys, and live state are never committed here.
