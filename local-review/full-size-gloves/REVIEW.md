# Japanese Kip glove photo review

Live isolated preview: http://127.0.0.1:5198/ (loopback only). Restart with `node /private/tmp/anawin-full-size-isolated/local-review/full-size-gloves/server.mjs`. The snapshot uses the starting branch source and is unaffected by the concurrent storefront edits.

Start: `node local-review/full-size-gloves/server.mjs`. Regenerate: `python3 local-review/full-size-gloves/prepare.py` (Pillow and cwebp). Browser check: `node local-review/full-size-gloves/check-browser.mjs`, with this server and local-mode Vite on port 5197 running.

Review implementation and assets live entirely in this directory, outside `public/` and the Vite entry graph. It reuses the storefront renderer/CSS and actual gallery/lightbox functions without loading commerce. Image blend is normal on white to preserve color. No production files were changed by this work. Separate production launch changes appeared concurrently; their build inclusion needs resolution before claiming the whole checkout is local-only.

## Source findings

The requested Pictures path was absent; the owner authorized the existing `images/` folders. All 16 filenames match the apparent colorway and angle. No obvious cross-model mismatch or inconsistent logo, stitching or shape was found between the supplied views. Leather identity, physical color and previous editing cannot be verified without originals or a reference glove. The smooth prepared studio/cutout appearance alone does not establish alteration.

Recommended heroes: `mint_back.png`, `black_back.png`, `orange_back.png`, `camel_back.png`. Back views show the silhouette, web, finger stalls and wrist emblem together. Orange is provisional pending a full-resolution original.

Orange images embed Screenshot metadata and an ICC named LS34H55xG. Its back view has a faint foreign strip at the top edge. These sources are only 358–426 px tall and will look soft in a large viewer. Request originals and confirm color against the physical glove. The embedded profile is preserved byte for byte.

Camel palm and finger-side have been replaced with uncropped 1122 × 1402 sources. Both now show the full glove and laces and are included in the four-angle gallery. The back remains the hero. Its side photo is still only 543 × 724 and is limited at high pixel density.

## Preparation

The entire source frame is centered on a white square: no subject crop, enlargement, retouching, sharpening or recoloring. Padding makes output canvases square; it does not enlarge glove pixels. All captured shadows and any source defects remain visible. Responsive widths follow existing 480/960/native-cap conventions, skipping widths above the cap. Source orientation is respected. Explicit dimensions reserve space; the first two views load eagerly and later ones lazily.

WebPs are lossless: generation asserts exact equality to the prepared pixels after decoding, correct dimensions, and exact ICC retention. Untagged mint, black and camel assume sRGB and receive an sRGB profile without RGB pixel conversion. The orange profile is retained. All 16 source SHA-256 checks passed unchanged; hashes are in `manifest.json`. Lossless review files are large; later lossy optimization would need a separate visual check.

## Inventory

All output dimensions are square pixels. Each entry is width / KiB (1024 bytes). Exact filenames and bytes for every output are in `outputs.csv`.

| Model | Angle | Source dimensions | Outputs: px / KiB |
| --- | --- | --- | --- |
| mint | back (hero) | 1254 × 1254 | 480 / 146.1, 960 / 505.6, 1254 / 732.4 |
| mint | palm | 1254 × 1254 | 480 / 153.6, 960 / 572.5, 1254 / 871.8 |
| mint | side | 1254 × 1254 | 480 / 115.8, 960 / 406.2, 1254 / 598.1 |
| mint | finger_side | 1254 × 1254 | 480 / 153.1, 960 / 557.7, 1254 / 823.7 |
| black | back (hero) | 1122 × 1402 | 480 / 143.0, 960 / 561.6, 1402 / 1108.0 |
| black | palm | 1122 × 1402 | 480 / 156.9, 960 / 627.2, 1402 / 1242.2 |
| black | side | 1122 × 1402 | 480 / 139.9, 960 / 549.9, 1402 / 1079.6 |
| black | finger_side | 1122 × 1402 | 480 / 135.5, 960 / 547.8, 1402 / 1091.1 |
| orange | back (hero) | 548 × 415 | 480 / 145.4, 548 / 177.1 |
| orange | palm | 586 × 358 | 480 / 122.6, 586 / 166.2 |
| orange | side | 599 × 426 | 480 / 132.0, 599 / 186.7 |
| orange | finger_side | 567 × 364 | 480 / 142.6, 567 / 185.3 |
| camel | back (hero) | 1085 × 1449 | 480 / 128.9, 960 / 472.1, 1449 / 956.8 |
| camel | palm | 1122 × 1402 | 480 / 149.3, 960 / 573.4, 1402 / 1145.1 |
| camel | side | 543 × 724 | 480 / 143.1, 724 / 290.7 |
| camel | finger_side | 1122 × 1402 | 480 / 125.5, 960 / 464.4, 1402 / 925.2 |

## Validation

All 337 starting tests passed, as did `npm run build` (with `VITE_COMMERCE_MODE=local`) and `git diff --check`. After concurrent production edits appeared, the starting Git source plus this review directory was built and tested in `/private/tmp/anawin-full-size-isolated`; 337 tests and build passed there too. The isolated `dist/` contains no review assets, scripts, references or extra routes.

Chrome checks passed for mint, black, orange, camel, BR16, OB16 and CL16 at 375, 768 and 1440 CSS px, DPR 2. All decoded images loaded, no horizontal page overflow occurred, and measured CLS was 0 in all 21 cases. Native Enter activation, left/right wrap, Escape, Tab/Shift-Tab trapping, focus restoration, mobile pagination and expanded-image decoding passed. Initial trainer checks used the actual local-mode storefront on port 5197. All 21 checks were then repeated successfully against the isolated starting-source review on port 5198 and its baseline storefront on port 5199. The preview uses descriptive view-specific alt text. Screenshots and detailed results are under ignored `evidence/`.

Visual checks show complete captured gloves/laces in the usable views. Mint and black retain stitching detail; orange looks soft at expanded size and camel side is resolution-limited. The expanded viewer uses the existing storefront behavior, which enlarges the display box even when a low-resolution source cannot provide additional detail. Generated image files themselves are never upscaled.

Final shared-checkout checks: `VITE_COMMERCE_MODE=local npm test` passed all 342 tests after the concurrent changes settled; `npm run build` and `git diff --check` passed. The initial overlapping build/test attempt was discarded and the tests rerun sequentially. The shared build emits 16 routes, including four full-size routes introduced by the concurrent work. That checkout was also switched from `launch/full-size-gloves` to `claude-full-size` externally. Those changes were left untouched pending owner direction. Only the isolated starting-source build satisfies the requested production exclusion at present.

Owner direction: leave concurrent work untouched and verify the review in isolation. This was completed. The isolated snapshot passes all 337 baseline tests and the build, excludes review assets from production output, and passes all 21 browser checks. The shared checkout remains on the externally selected `claude-full-size` branch; no branch switch or cleanup of that work was performed.

Camel redo: the replacement palm and finger-side sources were inspected and accepted as uncropped. Both provide 480, 960 and 1402 square lossless WebPs. The four camel sources were left unchanged during processing. All 21 browser checks passed again, including four camel images at every viewport, keyboard navigation and expanded viewing with CLS 0. The isolated 337-test suite, build, production asset exclusion check and repository whitespace check passed.
