/* ==========================================================================
   ECHO ECHO — IMAGE CROP (Campus Control)

   One crop tool for every image an administrator frames: a profile photo,
   a café photo, a dish photo, the website's logo, favicon, hero and banners.

     cropImage(file, { aspects, title, output }) -> Promise<Blob | null>

   The chosen file is read locally; nothing is uploaded and nothing existing
   is replaced until the caller uploads the Blob this returns (null when the
   person cancels). The person drags to position, zooms, rotates by 90° and
   picks an aspect preset, with a live preview of exactly what will be saved.
   The output is a re-encoded image (JPEG, or PNG where transparency matters)
   with no EXIF, so a phone photo's location does not travel with it. The
   server still checks the bytes it receives.
   ========================================================================== */

export const ASPECTS = {
  square: { label: 'Square', ratio: 1 },
  wide: { label: '16 : 9', ratio: 16 / 9 },
  card: { label: '4 : 3', ratio: 4 / 3 },
  banner: { label: '3 : 1', ratio: 3 },
  free: { label: 'Original', ratio: null },
};

/** The source rectangle for a crop: pure, so it can be tested. */
export function cropRect({ imgW, imgH, ratio, zoom = 1, cx = 0.5, cy = 0.5 }) {
  const r = ratio || imgW / imgH;
  /* The largest frame of ratio r that fits the image, shrunk by zoom. */
  let w = imgW, h = imgW / r;
  if (h > imgH) { h = imgH; w = imgH * r; }
  w /= zoom; h /= zoom;
  const x = Math.min(Math.max(cx * imgW - w / 2, 0), imgW - w);
  const y = Math.min(Math.max(cy * imgH - h / 2, 0), imgH - h);
  return { x, y, w, h };
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function loadBitmap(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file could not be read as an image.')); };
    img.src = url;
  });
}

/* The image turned by `rot` quarter turns, as a canvas to crop from. */
function rotated(img, rot) {
  const c = document.createElement('canvas');
  const q = ((rot % 4) + 4) % 4;
  c.width = q % 2 ? img.naturalHeight : img.naturalWidth;
  c.height = q % 2 ? img.naturalWidth : img.naturalHeight;
  const g = c.getContext('2d');
  g.translate(c.width / 2, c.height / 2);
  g.rotate(q * Math.PI / 2);
  g.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return c;
}

export async function cropImage(file, {
  aspects = ['square'], title = 'Frame the image', output = { maxSide: 1600, type: 'image/jpeg', quality: 0.9 },
  minSide = 0,
} = {}) {
  const { img, url } = await loadBitmap(file);
  let rot = 0, zoom = 1, cx = 0.5, cy = 0.5, aspect = aspects[0];
  let src = rotated(img, rot);

  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modalwrap cropwrap';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'crop-title');
    wrap.innerHTML = `
      <div class="scrim-fixed" data-crop="cancel"></div>
      <div class="modal crop">
        <div class="modal-head"><h2 class="t-h3" id="crop-title">${esc(title)}</h2>
          <p class="t-sm muted">Drag to position. Nothing is saved until you press Save.</p></div>
        <div class="modal-body">
          <div class="crop-stage"><canvas class="crop-canvas" tabindex="0" aria-label="Crop area: drag, or use the arrow keys, to position the image"></canvas></div>
          <div class="crop-controls">
            ${aspects.length > 1 ? `<div class="seg" role="group" aria-label="Shape">${aspects.map((a) => `
              <button type="button" class="seg-btn" data-aspect="${a}" aria-pressed="${a === aspect}">${esc(ASPECTS[a].label)}</button>`).join('')}</div>` : ''}
            <label class="crop-zoom"><span class="t-label">Zoom</span>
              <input type="range" min="1" max="4" step="0.01" value="1" data-crop-zoom aria-label="Zoom"></label>
            <button type="button" class="btn btn-secondary btn-sm" data-crop="rotate">Rotate 90°</button>
          </div>
          <p class="t-xs muted crop-size" aria-live="polite"></p>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn btn-ghost" data-crop="cancel">Cancel</button>
          <button type="button" class="btn btn-primary" data-crop="save">Save</button>
        </div>
      </div>`;
    document.body.append(wrap);
    const canvas = wrap.querySelector('canvas');
    const ctx = canvas.getContext('2d');
    const sizeNote = wrap.querySelector('.crop-size');
    const saveBtn = wrap.querySelector('[data-crop="save"]');

    const rect = () => cropRect({ imgW: src.width, imgH: src.height, ratio: ASPECTS[aspect].ratio, zoom, cx, cy });
    function draw() {
      const r = rect();
      const box = wrap.querySelector('.crop-stage').getBoundingClientRect();
      const maxW = Math.max(200, box.width - 2), maxH = Math.min(420, window.innerHeight * 0.5);
      const scale = Math.min(maxW / r.w, maxH / r.h);
      canvas.width = Math.round(r.w * scale); canvas.height = Math.round(r.h * scale);
      ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height);
      const out = Math.min(output.maxSide, Math.max(r.w, r.h));
      const ow = Math.round(r.w >= r.h ? out : out * r.w / r.h), oh = Math.round(r.w >= r.h ? out * r.h / r.w : out);
      const small = minSide && Math.min(r.w, r.h) < minSide;
      sizeNote.textContent = small
        ? `Too small: this frame is ${Math.round(r.w)} × ${Math.round(r.h)} px; at least ${minSide} px is needed. Zoom out or choose a larger image.`
        : `Saves as ${ow} × ${oh} px.`;
      saveBtn.disabled = !!small;
    }
    let drag = null;
    canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, cx, cy }; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = rect();
      const k = r.w / canvas.width;
      cx = drag.cx - ((e.clientX - drag.x) * k) / src.width;
      cy = drag.cy - ((e.clientY - drag.y) * k) / src.height;
      const n = rect(); cx = (n.x + n.w / 2) / src.width; cy = (n.y + n.h / 2) / src.height;
      draw();
    });
    canvas.addEventListener('pointerup', () => { drag = null; });
    canvas.addEventListener('keydown', (e) => {
      const step = 0.02 / zoom;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault(); cx += d[0]; cy += d[1];
      const n = rect(); cx = (n.x + n.w / 2) / src.width; cy = (n.y + n.h / 2) / src.height; draw();
    });
    wrap.querySelector('[data-crop-zoom]').addEventListener('input', (e) => { zoom = Number(e.target.value); draw(); });
    const finish = (blob) => {
      wrap.remove(); URL.revokeObjectURL(url);
      document.removeEventListener('keydown', onKey, true);
      resolve(blob);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); finish(null); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-crop], [data-aspect]');
      if (!b) return;
      if (b.dataset.aspect) {
        aspect = b.dataset.aspect;
        wrap.querySelectorAll('[data-aspect]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        draw(); return;
      }
      const act = b.dataset.crop;
      if (act === 'cancel') return finish(null);
      if (act === 'rotate') { rot += 1; src = rotated(img, rot); cx = 0.5; cy = 0.5; draw(); return; }
      if (act === 'save') {
        const r = rect();
        const out = Math.min(output.maxSide, Math.max(r.w, r.h));
        const c = document.createElement('canvas');
        c.width = Math.round(r.w >= r.h ? out : out * r.w / r.h);
        c.height = Math.round(r.w >= r.h ? out * r.h / r.w : out);
        const g = c.getContext('2d');
        if (output.type === 'image/jpeg') { g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
        b.disabled = true; b.textContent = 'Saving…';
        c.toBlob((blob) => finish(blob), output.type, output.quality);
      }
    });
    requestAnimationFrame(draw);
    canvas.focus();
  });
}
