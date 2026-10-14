# Regenerates brand/qr/ and proves each file decodes to the poster URL.
#   python -m pip install segno==1.6.1 opencv-python-headless==4.10.0.84
#   python tools/qr-make.py brand/qr
# Error correction H (about 30% of the symbol can be damaged and still read),
# a 4-module quiet zone (the minimum ISO/IEC 18004 asks for), dark on white.
import sys, segno, cv2, numpy as np
URL = 'https://www.echoecho.tech/web/'
out = sys.argv[1]
q = segno.make(URL, error='h', micro=False, boost_error=False)
print('version', q.version, 'error', q.error, 'modules', q.symbol_size(border=0)[0])
q.save(f'{out}/echoecho-web-qr.svg', scale=10, border=4, dark='#1C1917', light='#FFFFFF', xmldecl=True, svgclass=None, lineclass=None)
q.save(f'{out}/echoecho-web-qr.png', scale=40, border=4, dark='#1C1917', light='#FFFFFF')
det = cv2.QRCodeDetector()
img = cv2.imread(f'{out}/echoecho-web-qr.png')
print('png size', img.shape)
for size in (img.shape[0], 400, 150, 80):
    small = cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA)
    data, pts, _ = det.detectAndDecode(small)
    print(f'decode @{size}px:', repr(data), 'OK' if data == URL else 'FAIL')
# a blurred, slightly rotated, lower-contrast photo-like copy
h = img.shape[0]
M = cv2.getRotationMatrix2D((h/2, h/2), 8, 0.9)
rot = cv2.warpAffine(img, M, (h, h), borderValue=(255,255,255))
rot = cv2.GaussianBlur(cv2.resize(rot, (500, 500)), (5,5), 0)
rot = cv2.addWeighted(rot, 0.6, np.full_like(rot, 128), 0.4, 0)
data, _, _ = det.detectAndDecode(rot)
print('decode rotated/blurred/low-contrast:', repr(data), 'OK' if data == URL else 'FAIL')
