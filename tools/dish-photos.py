"""Build the menu's dish thumbnails from tools/dish-photos.json.

Each entry names an openly licensed photo (CC0, public domain, CC BY or
CC BY-SA, found through Openverse) by its original URL. This downloads it,
cuts a square around `focus` (x, y as fractions of the image; the centre by
default) whose side is `zoom` times the image's short side (1 by default;
less to leave out a frame, a sign or a bystander), and writes
packages/media/dishes/<key>.webp at 192 px: twice the 84 px menu tile. Nothing is retouched beyond the crop and resize, and no
metadata is carried over.

    python tools/dish-photos.py <download-cache-dir>

The attribution for every photo is in packages/media/photos.js
(DISH_CREDITS), which the menu's "Photo credits" sheet shows.
"""
import json
import os
import sys
import urllib.request

from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'packages', 'media', 'dishes')
SIZE = 192
UA = 'EchoEcho-menu-photos/1.0 (+https://www.echoecho.tech)'


def fetch(url, dest):
    if not os.path.exists(dest):
        req = urllib.request.Request(url, headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=60) as r, open(dest, 'wb') as f:
            f.write(r.read())
    return dest


def square(im, focus, zoom=1.0):
    side = round(min(im.width, im.height) * zoom)
    fx, fy = focus
    left = min(max(round(fx * im.width - side / 2), 0), im.width - side)
    top = min(max(round(fy * im.height - side / 2), 0), im.height - side)
    return im.crop((left, top, left + side, top + side))


def main(cache):
    os.makedirs(cache, exist_ok=True)
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(ROOT, 'tools', 'dish-photos.json'), encoding='utf-8') as f:
        photos = json.load(f)
    for p in photos:
        src = fetch(p['src'], os.path.join(cache, p['key'] + '.img'))
        im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
        im = square(im, p.get('focus', [0.5, 0.5]), p.get('zoom', 1.0)).resize((SIZE, SIZE), Image.LANCZOS)
        im.save(os.path.join(OUT, p['key'] + '.webp'), quality=80, method=6)
        print(p['key'])


if __name__ == '__main__':
    main(sys.argv[1])
