# Inspects a SUPPLIED QR image before it is used anywhere. Read-only: the
# original file is never modified, re-encoded or cropped.
#   python -m pip install opencv-python-headless==4.10.0.84
#   python tools/qr-verify.py <image> [--expect https://www.echoecho.tech/web/]
#
# Reports, as JSON:
#   - sha256 of the original file (so the printed copy can be tied to it)
#   - what the QR encodes, classified:
#       site_url    an https link; its host must be on ALLOWED_HOSTS
#       upi_payment a upi://pay link (payee VPA and name are shown); this is
#                   NOT used for checkout: online payment stays server-verified
#                   through Cashfree, and a static UPI QR cannot be tied to an
#                   order, a webhook or a refund
#       other       anything else (plain text, http://, another scheme)
#   - whether it still decodes when shrunk to poster-at-distance sizes
#   - the quiet zone, in modules (ISO/IEC 18004 asks for at least 4)
# Exit status: 0 only when it decodes, is a site_url on an allowed host (or
# matches --expect exactly) and has a quiet zone of at least 4 modules.
import hashlib, json, sys
from urllib.parse import urlparse, parse_qs
import cv2
import numpy as np

ALLOWED_HOSTS = {'www.echoecho.tech', 'echoecho.tech'}


def classify(data):
    if data.lower().startswith('upi://'):
        u = urlparse(data); qs = parse_qs(u.query)
        return {'kind': 'upi_payment', 'payee_vpa': qs.get('pa', [None])[0], 'payee_name': qs.get('pn', [None])[0],
                'amount': qs.get('am', [None])[0],
                'note': 'A static UPI QR. Do not use it for ECHO ECHO checkout: orders are paid through Cashfree and confirmed server-to-server.'}
    u = urlparse(data)
    if u.scheme == 'https' and u.hostname:
        return {'kind': 'site_url', 'host': u.hostname, 'path': u.path or '/',
                'allowed_host': u.hostname in ALLOWED_HOSTS}
    return {'kind': 'other', 'scheme': u.scheme or None,
            'note': 'Not an https link. A menu/site QR must point to an https ECHO ECHO URL.'}


def quiet_zone_modules(img, points, modules):
    """Smallest white margin around the symbol, measured in modules."""
    if points is None or not modules:
        return None
    pts = points.reshape(-1, 2)
    x0, y0 = pts.min(axis=0); x1, y1 = pts.max(axis=0)
    module_px = (x1 - x0) / modules
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    _, bw = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    h, w = bw.shape
    # The detector's corners can sit a little inside or outside the symbol;
    # snap to the outermost dark pixels within one module of them.
    pad = module_px
    rx0, ry0 = int(max(0, x0 - pad)), int(max(0, y0 - pad))
    rx1, ry1 = int(min(w, x1 + pad)), int(min(h, y1 + pad))
    ys, xs = np.nonzero(bw[ry0:ry1, rx0:rx1] == 0)
    if xs.size:
        x0, x1 = rx0 + xs.min(), rx0 + xs.max()
        y0, y1 = ry0 + ys.min(), ry0 + ys.max()
        module_px = (x1 - x0 + 1) / modules
    def clear(dx0, dy0, dx1, dy1):
        r = bw[max(0, int(dy0)):min(h, int(dy1)), max(0, int(dx0)):min(w, int(dx1))]
        return r.size == 0 or r.min() > 0
    margins = []
    for side in ('left', 'right', 'top', 'bottom'):
        n = 0
        while n < 20:
            step = (n + 1) * module_px
            box = {'left': (x0 - step, y0, x0 - n * module_px - 1, y1),
                   'right': (x1 + n * module_px + 1, y0, x1 + step, y1),
                   'top': (x0, y0 - step, x1, y0 - n * module_px - 1),
                   'bottom': (x0, y1 + n * module_px + 1, x1, y1 + step)}[side]
            edge = {'left': x0 - step < 0, 'right': x1 + step > w, 'top': y0 - step < 0, 'bottom': y1 + step > h}[side]
            if edge or not clear(*box):
                break
            n += 1
        margins.append(n)
    return min(margins)


def main():
    if len(sys.argv) < 2:
        print('usage: python tools/qr-verify.py <image> [--expect URL]'); return 2
    path = sys.argv[1]
    expect = sys.argv[sys.argv.index('--expect') + 1] if '--expect' in sys.argv else None
    raw = open(path, 'rb').read()
    img = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        print(json.dumps({'file': path, 'error': 'not a readable image'})); return 1
    det = cv2.QRCodeDetector()
    data, points, straight = det.detectAndDecode(img)
    report = {'file': path, 'sha256': hashlib.sha256(raw).hexdigest(), 'pixels': [int(img.shape[1]), int(img.shape[0])],
              'decoded': bool(data), 'data': data or None}
    if not data:
        report['error'] = 'no QR decoded; try the original file rather than a screenshot or photo'
        print(json.dumps(report, indent=1)); return 1
    report['classification'] = classify(data)
    modules = int(straight.shape[0]) if straight is not None else None
    report['modules'] = modules
    report['quiet_zone_modules'] = quiet_zone_modules(img, points, modules)
    sizes = {}
    side = max(img.shape[:2])
    for px in (600, 300, 150, 100):
        if px >= side:
            continue
        s = cv2.resize(img, (int(img.shape[1] * px / side), int(img.shape[0] * px / side)), interpolation=cv2.INTER_AREA)
        sizes[str(px)] = det.detectAndDecode(s)[0] == data
    report['decodes_when_shrunk_to_px'] = sizes
    c = report['classification']
    ok_dest = (data == expect) if expect else (c['kind'] == 'site_url' and c.get('allowed_host'))
    ok_qz = (report['quiet_zone_modules'] or 0) >= 4
    report['verdict'] = {'destination_ok': bool(ok_dest), 'quiet_zone_ok': ok_qz,
                         'expected': expect, 'usable_as_menu_qr': bool(ok_dest and ok_qz)}
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0 if ok_dest and ok_qz else 1


if __name__ == '__main__':
    sys.exit(main())
