"""Derive the café photographs in packages/media/cafes/ from the originals.

The originals are the owner's GPS Map Camera shots of each kiosk (16 Sep
2026), kept out of Git with the rest of "Google map*/" because they carry a
location overlay and show people. They are only read, never modified.

For each café this:

  * crops to the kiosk: the camera's map / address / coordinates overlay
    along the bottom is cut away, and so is every bystander's face (the
    Chai Garam queue sits below the crop; the two students beside Tulips
    sit outside it)
  * softly blurs one small region where a person is visible behind glass
  * nudges brightness, contrast and colour by a few percent and sharpens
    lightly after resizing; nothing is redrawn or replaced
  * writes WebP at three widths plus one JPEG fallback, with no EXIF, so no
    GPS position is published

    python tools/cafe-photos.py "<folder with the originals>"
"""
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'packages', 'media', 'cafes')

CAFES = {
    'tulips-cafe': {
        'source': '20260916_45232PMByGPSMapCamera.jpg',
        'crop': (845, 256, 2785, 2163),          # of the 4096 x 3072 original
        'tone': (1.06, 1.06, 1.04),              # brightness, contrast, colour
        'privacy': [(1320, 1120, 1450, 1270)],   # staff member behind the glass
        'widths': [480, 800, 1200], 'jpeg': 800,
    },
    'chai-garam-cafe': {
        'source': '20260916_35824PMByGPSMapCamera.jpg',
        'crop': (512, 0, 4096, 1421),
        'tone': (1.02, 1.04, 1.02),
        'privacy': [],
        'widths': [800, 1200, 1800], 'jpeg': 1200,
    },
}


def main(originals):
    os.makedirs(OUT, exist_ok=True)
    for name, c in CAFES.items():
        im = ImageOps.exif_transpose(Image.open(os.path.join(originals, c['source']))).convert('RGB')
        im = im.crop(c['crop'])
        b, k, col = c['tone']
        im = ImageEnhance.Color(ImageEnhance.Contrast(ImageEnhance.Brightness(im).enhance(b)).enhance(k)).enhance(col)
        for box in c['privacy']:
            mask = Image.new('L', im.size, 0)
            ImageDraw.Draw(mask).ellipse(box, fill=255)
            im = Image.composite(im.filter(ImageFilter.GaussianBlur(9)), im, mask.filter(ImageFilter.GaussianBlur(14)))
        for w in c['widths']:
            r = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
            r = r.filter(ImageFilter.UnsharpMask(radius=1.0, percent=35, threshold=2))
            r.save(os.path.join(OUT, f'{name}-{w}.webp'), quality=80, method=6)
            if w == c['jpeg']:
                r.save(os.path.join(OUT, f'{name}-{w}.jpg'), quality=82, optimize=True, progressive=True)
        print(name, im.size)


if __name__ == '__main__':
    main(sys.argv[1])
