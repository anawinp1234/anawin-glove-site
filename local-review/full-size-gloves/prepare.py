"""Local image preparation: python3 local-review/full-size-gloves/prepare.py.

Requires Pillow and cwebp. No source writes, retouching, sharpening or upscaling.
Whole input frames are centered on white squares, retaining all captured detail.
"""
from pathlib import Path
from PIL import Image, ImageCms, ImageOps
import hashlib
import io
import json
import subprocess
import tempfile
import argparse

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
OUT = HERE / 'assets'
OUT.mkdir(exist_ok=True)
ANGLES = {
    'back': 'back view showing finger stalls, web and wrist logo',
    'palm': 'open palm view showing pocket, web and lacing',
    'side': 'thumb and web side view',
    'finger_side': 'finger side view showing embroidered ANAWIN wordmark',
}
models = [('mint', 'mint_glove'), ('black', 'black_glove'), ('orange', 'orange_glove'), ('camel', 'camel')]
parser = argparse.ArgumentParser()
parser.add_argument('--model', choices=[color for color, _ in models])
selected = parser.parse_args().model
manifest = json.loads((HERE / 'manifest.json').read_text()) if selected else []
if selected:
    manifest = [entry for entry in manifest if entry['model'] != selected]
    models = [(color, folder) for color, folder in models if color == selected]
# Only these previously inspected sources were clipped. Replacement originals
# must be inspected before updating this list; do not reject an angle by name.
clipped_sources = {
    '2483ed5bfcfe2a9040fcaa223f152a76e6af395ba3e48b2ab410190ec0c48e99',
    'ace29fde885d8ab7efe5ef2241126a6e631064f4b1ce44fa1482c3c69b602638',
}
for color, folder in models:
    for angle, description in ANGLES.items():
        source = ROOT / 'images' / folder / f'{color}_{angle}.png'
        original = source.read_bytes()
        image = Image.open(io.BytesIO(original))
        profile = image.info.get('icc_profile')
        note = ''
        if color == 'orange':
            note = 'Screenshot metadata; low resolution. Back view has a faint foreign strip at the top edge. Confirm color and request original photos.'
        if hashlib.sha256(original).hexdigest() in clipped_sources:
            note = 'HOLD: glove/lace reaches the left source edge and is clipped. Request an uncropped original.'
        elif color == 'camel' and angle == 'side':
            note = 'Lower-resolution source (543 × 724); request a larger original for high-density displays.'
        eligible = not note.startswith('HOLD:')
        entry = dict(model=color, angle=angle, source=str(source.relative_to(ROOT)),
                     sha256=hashlib.sha256(original).hexdigest(), sourceDimensions=list(image.size),
                     sourceBytes=len(original), sourceProfile='embedded ICC' if profile else 'untagged; assumed sRGB',
                     hero=angle == 'back', usable=eligible, note=note,
                     alt=f'{color.capitalize()} Japanese Kip baseball glove, {description}', outputs=[])
        if eligible:
            image = ImageOps.exif_transpose(image)
            side = max(image.size)
            square = Image.new('RGB', (side, side), 'white')
            square.paste(image, ((side-image.width)//2, (side-image.height)//2),
                         image.getchannel('A') if 'A' in image.getbands() else None)
            # Preserve the source profile byte for byte. Tag untagged images as sRGB;
            # do not convert, recolor or increase contrast in their pixel values.
            profile = profile or ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()
            with tempfile.TemporaryDirectory() as temporary:
                for width in sorted(set([n for n in [480, 960] if n < side] + [side])):
                    resized = square if width == side else square.resize((width, width), Image.Resampling.LANCZOS)
                    png = Path(temporary) / 'input.png'
                    resized.save(png, icc_profile=profile)
                    name = f'{color}-{angle.replace("_", "-")}-{width}.webp'
                    target = OUT / name
                    subprocess.run(['cwebp', '-quiet', '-lossless', '-m', '6', '-metadata', 'icc', str(png), '-o', str(target)], check=True)
                    decoded = Image.open(target)
                    assert decoded.size == (width, width)
                    assert decoded.info['icc_profile'] == profile
                    assert decoded.convert('RGB').tobytes() == resized.tobytes()
                    entry['outputs'].append(dict(file=name, width=width, height=width, bytes=target.stat().st_size))
        assert hashlib.sha256(source.read_bytes()).hexdigest() == entry['sha256']
        manifest.append(entry)
(HERE / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(f'Prepared {sum(len(e["outputs"]) for e in manifest)} lossless WebPs; {sum(not e["usable"] for e in manifest)} photos held for review.')
