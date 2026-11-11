"""Build web images for the full-size gloves: python3 scripts/prepare-full-size-images.py [color ...]

Reads the source photos in images/<folder>/ and writes square, background-padded
WebP sizes plus a JPEG fallback to public/images/full-size/. Requires Pillow and cwebp.
Each photo is cropped (never enlarged) so the glove fills the frame the same way
the mini glove photos do, then the canvas size is printed for src/catalog.js.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
from PIL import Image, ImageChops, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'images' / 'full-size'
OUT.mkdir(parents=True, exist_ok=True)

MODELS = [('mint', 'mint_glove'), ('black', 'black_glove'), ('camel', 'camel_glove'), ('orange', 'orange_glove')]
ANGLES = ['back', 'palm', 'side', 'finger_side']
# Rows to trim from the top of a source photo (removes a stray screenshot strip).
TOP_TRIM = {('orange', 'back'): 8}
# Share of the square the glove's longer side fills. The mini glove photos average
# about 86%, which leaves roughly 7% white space on each side.
GLOVE_FILL = 0.86
# How far a pixel must differ from the background to count as glove.
GLOVE_THRESHOLD = 24

ONLY = set(sys.argv[1:])  # optional colors to rebuild, e.g. black orange

for color, folder in MODELS:
    if ONLY and color not in ONLY:
        continue
    for angle in ANGLES:
        image = ImageOps.exif_transpose(Image.open(ROOT / 'images' / folder / f'{color}_{angle}.png'))
        # Keep the source RGB interpretation through newly created canvases.
        # Dropping a non-sRGB ICC profile changes its appearance in the browser.
        profile = image.info.get('icc_profile')
        if image.mode in ('RGBA', 'LA', 'P'):
            image = image.convert('RGBA')
            flat = Image.new('RGB', image.size, 'white')
            flat.paste(image, mask=image.getchannel('A'))
            image = flat
        image = image.convert('RGB')
        trim = TOP_TRIM.get((color, angle), 0)
        if trim:
            image = image.crop((0, trim, image.width, image.height))
        # Pad with the photo's own background tone so no box edge shows.
        border = [image.getpixel((x, y)) for x in range(image.width) for y in (0, image.height - 1)]
        border += [image.getpixel((x, y)) for y in range(image.height) for x in (0, image.width - 1)]
        background = tuple(sorted(pixel[channel] for pixel in border)[len(border) // 2] for channel in range(3))
        # Find the glove, then center it on a square sized so it fills GLOVE_FILL of the frame.
        difference = ImageChops.difference(image, Image.new('RGB', image.size, background)).convert('L')
        left, top, right, bottom = difference.point(lambda value: 255 if value > GLOVE_THRESHOLD else 0).getbbox()
        side = min(max(image.size), round(max(right - left, bottom - top) / GLOVE_FILL))
        square = Image.new('RGB', (side, side), background)
        square.paste(image, (side // 2 - (left + right) // 2, side // 2 - (top + bottom) // 2))
        name = f'{color}-{angle.replace("_", "-")}'
        square.save(OUT / f'{name}.jpg', quality=88, optimize=True, progressive=True, icc_profile=profile)
        with tempfile.TemporaryDirectory() as temporary:
            for width in sorted(set([w for w in (480, 960) if w < side] + [side])):
                resized = square if width == side else square.resize((width, width), Image.Resampling.LANCZOS)
                png = Path(temporary) / 'in.png'
                resized.save(png, icc_profile=profile)
                subprocess.run(['cwebp', '-quiet', '-q', '86', '-m', '6', '-metadata', 'icc', str(png), '-o', str(OUT / f'{name}-{width}.webp')], check=True)
        print(name, side)
