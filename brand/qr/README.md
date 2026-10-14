# Poster QR code

| File | Use |
|---|---|
| `echoecho-web-qr.svg` | Print (vector, scales to any size) |
| `echoecho-web-qr.png` | Screens and documents (1640 × 1640 px) |

- Encodes exactly `https://www.echoecho.tech/web/`: the production custom domain, HTTPS,
  no temporary deployment URL. That address answers 200 directly, with no redirect.
- QR version 4, error correction **H**, 33 × 33 modules plus a 4-module white quiet zone on
  every side (already inside the files; do not crop it, and keep other artwork off it).
- Dark `#1C1917` on white. Do not invert it, put it on a photo, or place a logo over it.

**Verified by software only.** `tools/qr-make.py` decodes each file with OpenCV, including
copies scaled down to 80 px and a rotated, blurred, low-contrast copy. It has **not** been
tested on a physical print. Before the run, print one proof at the real size and scan it with
an iPhone camera and an Android camera from about 1 m away.

Print size: at least **3 cm × 3 cm** including the quiet zone on a handout. On a poster, make
it at least a tenth of the distance it is scanned from (2 m away means 20 cm).
