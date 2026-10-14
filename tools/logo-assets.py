# Derives every web asset of the ECHO ECHO logo from the owner-approved original.
#
#   python tools/logo-assets.py "C:\Users\ayush\Downloads\6.jpeg"
#
# The original is copied byte-for-byte to brand/logo/echoecho-logo-original.jpeg
# and never edited. Everything else is a resize of it, or of one square crop of
# it (the chef's head, for sizes where the whole logo cannot be read: favicons
# and the small mark). Nothing is redrawn or recoloured. Requires Pillow.
import hashlib
import shutil
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'brand' / 'logo'
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT / 'echoecho-logo-original.jpeg'

# The chef's head and hat, square, from the 1254 x 1254 original.
MARK_BOX = (285, 15, 895, 625)
# The artwork's own background, sampled from its corners, for padding only.
CREAM = (254, 247, 231)

OUT.mkdir(parents=True, exist_ok=True)
original = OUT / 'echoecho-logo-original.jpeg'
if SRC.resolve() != original.resolve():
    shutil.copyfile(SRC, original)
logo = Image.open(original).convert('RGB')
assert logo.size == (1254, 1254), f'unexpected original size {logo.size}'
mark = logo.crop(MARK_BOX)

def fit(im, px):
    return im.resize((px, px), Image.LANCZOS)

# Full logo, for the landing page and sign-in posters.
for px in (640, 320):
    fit(logo, px).save(OUT / f'echoecho-logo-{px}.webp', 'WEBP', quality=86, method=6)
# The mark, for the header, footer and assistant avatar (up to 48 px at 2x).
for px in (192, 96):
    fit(mark, px).save(OUT / f'echoecho-mark-{px}.webp', 'WEBP', quality=88, method=6)
# Browser and home-screen icons.
fit(mark, 180).save(OUT / 'apple-touch-icon.png', optimize=True)
fit(mark, 192).save(OUT / 'icon-192.png', optimize=True)
fit(mark, 48).save(OUT / 'favicon.ico', sizes=[(16, 16), (32, 32), (48, 48)])
fit(mark, 32).save(OUT / 'favicon-32.png', optimize=True)
# Social preview: the whole logo, unaltered, centred on its own background.
og = Image.new('RGB', (1200, 630), CREAM)
og.paste(fit(logo, 590), ((1200 - 590) // 2, 20))
og.save(OUT / 'og-image.jpg', 'JPEG', quality=88, optimize=True, progressive=True)

for f in sorted(OUT.iterdir()):
    print(f'{f.name:34} {f.stat().st_size:>8} bytes  sha256 {hashlib.sha256(f.read_bytes()).hexdigest()[:16]}')
