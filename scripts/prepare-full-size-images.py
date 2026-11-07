"""Build web images for the full-size gloves: python3 scripts/prepare-full-size-images.py [color ...]

Reads the source photos in images/<folder>/ and writes square, background-padded
WebP sizes plus a JPEG fallback to public/images/full-size/. Requires Pillow and cwebp.
Nothing is enlarged; each photo keeps its full frame.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'public' / 'images' / 'full-size'
OUT.mkdir(parents=True, exist_ok=True)

MODELS = [('mint', 'mint_glove'), ('black', 'black_glove'), ('camel', 'camel'), ('orange', 'orange_glove')]
ANGLES = ['back', 'palm', 'side', 'finger_side']
# Rows to trim from the top of a source photo (removes a stray screenshot strip).
TOP_TRIM = {('orange', 'back'): 8, ('orange', 'side'): 3}
# Turn upright side photos clockwise so they lie flat like the camel side view.
# Value: darkest gray that still counts as shadow (black leather is darker than 60;
# orange leather is colored, so its darker contact shadow can be cleared too).
ROTATE_CLOCKWISE = {('black', 'side'): 60, ('orange', 'side'): 15}

def clear_floor_shadow(image, darkest_shadow=60):
    """Whiten the soft gray floor shadow under an upright glove, before it is rotated.

    Each column is scanned upward from the bottom. Shadow is neutral gray that gets
    steadily darker toward the glove, so the scan stops at the first colored or very
    dark pixel (leather) or at a sudden brightening (a logo or lace), leaving the
    glove untouched.
    """
    pixels = image.load()
    for x in range(image.width):
        darkest = 255
        for y in range(image.height - 1, -1, -1):
            r, g, b = pixels[x, y]
            light = (r + g + b) // 3
            if max(r, g, b) - min(r, g, b) > 14 or light < darkest_shadow or light > darkest + 20:
                break
            darkest = min(darkest, light)
            pixels[x, y] = (254, 254, 254)
    return image


ONLY = set(sys.argv[1:])  # optional colors to rebuild, e.g. black orange

for color, folder in MODELS:
    if ONLY and color not in ONLY:
        continue
    for angle in ANGLES:
        image = ImageOps.exif_transpose(Image.open(ROOT / 'images' / folder / f'{color}_{angle}.png'))
        if image.mode in ('RGBA', 'LA', 'P'):
            image = image.convert('RGBA')
            flat = Image.new('RGB', image.size, 'white')
            flat.paste(image, mask=image.getchannel('A'))
            image = flat
        image = image.convert('RGB')
        trim = TOP_TRIM.get((color, angle), 0)
        if trim:
            image = image.crop((0, trim, image.width, image.height))
        if (color, angle) in ROTATE_CLOCKWISE:
            image = clear_floor_shadow(image, ROTATE_CLOCKWISE[(color, angle)]).transpose(Image.Transpose.ROTATE_270)
        side = max(image.size)
        # Pad with the photo's own background tone so no box edge shows.
        border = [image.getpixel((x, y)) for x in range(image.width) for y in (0, image.height - 1)]
        border += [image.getpixel((x, y)) for y in range(image.height) for x in (0, image.width - 1)]
        background = tuple(sorted(pixel[channel] for pixel in border)[len(border) // 2] for channel in range(3))
        square = Image.new('RGB', (side, side), background)
        square.paste(image, ((side - image.width) // 2, (side - image.height) // 2))
        name = f'{color}-{angle.replace("_", "-")}'
        square.save(OUT / f'{name}.jpg', quality=88, optimize=True, progressive=True)
        with tempfile.TemporaryDirectory() as temporary:
            for width in sorted(set([w for w in (480, 960) if w < side] + [side])):
                resized = square if width == side else square.resize((width, width), Image.Resampling.LANCZOS)
                png = Path(temporary) / 'in.png'
                resized.save(png)
                subprocess.run(['cwebp', '-quiet', '-q', '86', '-m', '6', str(png), '-o', str(OUT / f'{name}-{width}.webp')], check=True)
        print(name, side)
