"""
PRODUCTION-SAFE DERIVATIVES FROM THE BIDHOLI FIELD PHOTOGRAPHS

An offline, one-time evidence-processing step. It is NOT part of the server
runtime: nothing here runs in production and the repository stays Node-only at
run time. Requires Pillow.

    python tools/campus-photo-derivatives.py "<path to the 'Google map' folder>"

What it does to each photo it is asked for:

  1. Crops off the bottom caption band. GPS Map Camera burns a Google Maps
     thumbnail, a "Google" watermark and the coordinates into every frame.
     Publishing that as ECHO ECHO artwork would be passing off someone else's
     branding, so the band goes before anything else happens.
  2. Strips ALL metadata by copying pixels into a fresh image. No EXIF, no
     camera model, no timestamp travels onward.
  3. Resizes so the long edge is at most 1600 px and saves JPEG quality 82.
  4. Records the derivative against its source SHA-256 in a manifest.

What it explicitly does NOT do:

  * It does NOT detect or blur faces or vehicle number plates. There is no
    face detector here, and pretending there is would be worse than useless:
    somebody would publish an image believing it had been redacted. Every
    derivative is written with needs_redaction_review = yes, and the manifest
    carries forward whether people were already observed in that frame.
  * It does NOT publish anything. Storage is not configured, and no derivative
    may be served until a human has reviewed it.
  * It does NOT touch the originals. They are opened read-only.

Output goes to campus-field/derivatives/, which is git-ignored along with the
source archive. Original evidence is preserved untouched.
"""
import csv
import hashlib
import os
import sys
from pathlib import Path

try:
    from PIL import Image
except ImportError:
    sys.exit("Pillow is required: python -m pip install Pillow")

REPO = Path(__file__).resolve().parent.parent
EVIDENCE = REPO / "docs" / "campus" / "bidholi-field-2026-09-evidence.csv"
OUT_DIR = REPO / "campus-field" / "derivatives"
MANIFEST = REPO / "campus-field" / "derivatives-manifest.csv"

# The caption band sits at the bottom of the frame, and a separate
# "GPS Map Camera" badge floats just above it -- in landscape frames at about
# 0.69 of the height, in portrait at about 0.75. These fractions cut below
# both, which was confirmed by eye on frames of each orientation. Re-check
# them before pointing this at photos from a different app or phone.
KEEP_LANDSCAPE = 0.66
KEEP_PORTRAIT = 0.68
MAX_EDGE = 1600
QUALITY = 82


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_evidence():
    with open(EVIDENCE, encoding="utf-8") as fh:
        return {r["source_photo"]: r for r in csv.DictReader(fh)}


def derive(src_path, dest_path):
    """Crop the caption band, drop all metadata, resize, save."""
    with Image.open(src_path) as im:
        w, h = im.size
        keep = KEEP_PORTRAIT if h > w else KEEP_LANDSCAPE
        cropped = im.crop((0, 0, w, int(h * keep)))
        cropped = cropped.convert("RGB")
        cropped.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
        # A fresh image carries no EXIF from the original.
        clean = Image.new("RGB", cropped.size)
        clean.putdata(list(cropped.getdata()))
        dest_path.parent.mkdir(parents=True, exist_ok=True)
        clean.save(dest_path, "JPEG", quality=QUALITY, optimize=True)
        return clean.size


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    archive = Path(sys.argv[1]).resolve()
    if not archive.is_dir():
        sys.exit(f"archive folder not found: {archive}")

    evidence = load_evidence()

    # Only frames that actually show something identifiable are worth a
    # derivative. A photograph of the ground has nothing to publish.
    wanted = [
        r for r in evidence.values()
        if r["legible_signage"] or r["room_plate"] or r["subject"]
    ]

    rows = []
    for rec in sorted(wanted, key=lambda r: int(r["n"])):
        src = archive / rec["source_photo"]
        if not src.exists():
            print(f"  ! missing from archive: {rec['source_photo']}")
            continue
        actual = sha256_of(src)
        if actual != rec["sha256"]:
            print(f"  ! SHA-256 mismatch, skipped: {rec['source_photo']}")
            continue

        dest = OUT_DIR / f"bidholi-{int(rec['n']):03d}.jpg"
        size = derive(src, dest)
        rows.append({
            "derivative": dest.name,
            "source_photo": rec["source_photo"],
            "source_sha256": rec["sha256"],
            "width": size[0],
            "height": size[1],
            "bytes": dest.stat().st_size,
            "legible_signage": rec["legible_signage"],
            "room_plate": rec["room_plate"],
            "subject": rec["subject"],
            "caption_band_removed": "yes",
            "metadata_stripped": "yes",
            "people_or_plates_visible": rec["people_or_plates_visible"],
            "needs_redaction_review": "yes",
            "publishable": "no",
            "publish_block_reason": "awaiting human redaction review; not yet approved for publication",
        })
        print(f"  {dest.name}  <- {rec['source_photo']}  {size[0]}x{size[1]}  {dest.stat().st_size // 1024} KB")

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(fh, fieldnames=list(rows[0].keys()), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)

    total = sum(r["bytes"] for r in rows)
    print()
    print(f"derivatives: {len(rows)}   total {total / 1024 / 1024:.1f} MB")
    print(f"manifest:    {MANIFEST}")
    print()
    print("Every derivative is marked publishable=no and needs_redaction_review=yes.")
    print("Faces and number plates were NOT detected or blurred by this script.")
    print("Originals were opened read-only and are unchanged.")


if __name__ == "__main__":
    main()
