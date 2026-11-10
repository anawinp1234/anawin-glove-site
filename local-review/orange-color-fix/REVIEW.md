# Orange color-profile fix

Branch: `claude-full-size`, based on `481664e`.

Gallery: http://127.0.0.1:5197/full-size/orange

Source/before/after comparison: http://127.0.0.1:5197/local-review/orange-color-fix/compare.html

## Cause and change

The orange back, palm and finger-side PNGs embed the same 520-byte LS34H55xG RGB ICC profile (SHA-256 `9520dfb2bad1d955a65ba8a3ffecef068e3715ae09486b41067dca1bbd234c29`). Creating a new RGB canvas lost that profile. JPEG and temporary PNG saves omitted it, and cwebp defaults to dropping metadata. The RGB samples were consequently interpreted as sRGB in browsers, visibly muting the orange.

The script now captures the source profile before compositing, explicitly embeds it in JPEG and temporary PNG files, and asks cwebp to retain ICC. No pixel conversion, retouching, compression-setting, rotation, shadow, crop, responsive descriptor or gallery-reference changes were made. The eight affected output files retain exactly the same decoded RGB pixels as their prior versions; only color metadata/container structure changes. The untagged orange side and all other model assets remain byte-identical. All four orange source hashes remain unchanged (recorded in source-hashes.json).

Tracked changes: `scripts/prepare-full-size-images.py`, `test/full-size.test.js`, and the eight orange back/palm/finger-side JPEG/WebP assets under `public/images/full-size/`. Pre-existing trainer-source deletions and untracked source folders were preserved.

## Validation

- `VITE_COMMERCE_MODE=local npm test`: 346 passed, zero failed. Four new tests validate source ICC fingerprints, JPEG/WebP profile identity and flags, actual container dimensions, and the palm's native resolution cap. They do not require the untracked original photos in CI.
- `VITE_COMMERCE_MODE=local npm run build`: passed; 16 public routes plus 404. Built orange assets exactly match corrected public assets.
- `git diff --check`: passed.
- Chrome: source/before/JPEG/WebP comparison at 375 and 1440 CSS px; corrected outputs visually match the color-managed source within existing lossy compression. Browser canvas comparisons over colored source pixels reduce mean RGB error from about 15–16 levels to 5–7 levels. Full results/screenshots are under ignored evidence/.
- Correct responsive selection at DPR 1 and 2 with caching disabled. The palm selects only 422px at every viewport/density; no enlarged derivative exists.
- All 14 product/viewport checks passed: four full-size gloves and BR16/OB16/CL16 at mobile and desktop sizes. Native Enter, all four expanded images, arrow wrapping, Tab/Shift-Tab containment, Escape, focus restoration and mobile pagination passed. Measured CLS was zero. All three trainers add to the local cart; coming-soon gloves have no purchase controls. No Shopify requests or changes were made.

## Remaining source limitation

No approved higher-resolution orange palm original is available in the current source set. The 422 × 355 file is retained intact and padded to a 422 × 422 canvas without enlarging the photo. Replace it before launch; the expanded display remains soft on large/high-density screens. Orange back/finger-side sources are also relatively small (548/567px wide).

No commit, push, PR, merge, deployment, or Shopify change was performed.
