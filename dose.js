// ===================== Dose (RTDOSE) viewer =====================
// Total dose only. The grid is resampled in Python onto whichever primary plane is shown, so the dose
// overlays every scan (they are all displayed in the primary's geometry).
// Levels (isolines, colourwash limits) are stored as % of the reference dose; the Gy/% switch only
// changes how they are shown and typed.
let dose = null;
const ISO_W = {1: 1, 2: 2, 3: 3.5};                         // thin / medium / thick (CSS px at viewer size)
const ISO_DEFAULT = [[100, '#ff2a2a'], [95, '#ffe600'], [90, '#3cff3c'], [80, '#28e0ff'], [50, '#4a7bff']];
const WASH_STOPS = ['#0000ff', '#00b4ff', '#00ff7f', '#c8ff00', '#ffd400', '#ff6a00', '#ff0000'];
let washLut = null;
function getWashLut() {
  if (washLut) return washLut;
  const sc = d3.scaleLinear().domain(WASH_STOPS.map((_, i) => i / (WASH_STOPS.length - 1))).range(WASH_STOPS).interpolate(d3.interpolateRgb);
  washLut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) { const c = d3.rgb(sc(i / 255)); washLut.set([c.r, c.g, c.b], i * 3); }
  return washLut;
}
const doseReady = () => !!(dose && dose.info);
const fmtGy = v => (Math.round(v * 100) / 100).toFixed(2);
// absolute dose unit: Gy, unless the RTDOSE is stored in relative units
const DU = () => dose && dose.info && dose.info.units && dose.info.units !== 'GY' ? 'rel.' : 'Gy';
const pctToShown = pct => dose.units === 'rel' ? +pct.toFixed(1) : +(pct / 100 * dose.ref).toFixed(2);
const shownToPct = v => dose.units === 'rel' ? v : v / dose.ref * 100;
const unitLabel = () => dose.units === 'rel' ? '%' : DU();
function levelLabel(pct) { return dose.units === 'rel' ? `${+pct.toFixed(1)}%` : `${fmtGy(pct / 100 * dose.ref)} ${DU()}`; }

// ---------- loading ----------
async function loadDoseFrom(files) {
  try {
    if (!meta) { toast('Load the CT before the dose.', 'error'); return false; }
    if (!files.length) { toast('Choose an RTDOSE file (and its RTPLAN if you have it).', 'error'); return false; }
    log(`Reading ${files.length} dose/plan file(s)…`);
    busy('Loading dose', null, 'Reading the dose grid…'); await paint();
    const paths = [];
    for (const f of files) paths.push(await writeOne(f, 'dose'));
    const info = JSON.parse(py.globals.get('load_dose')(JSON.stringify(paths)));
    log('Dose loaded: ' + JSON.stringify(info));
    dose = {info, ref: (info.rx && info.rx.dose) || info.max, units: 'abs', mode: dose ? dose.mode : 'wash', alpha: 0.45,
            wash: {lo: 30, hi: 100}, iso: ISO_DEFAULT.map(([pct, color]) => ({on: true, pct, color, w: 2})),
            planes: new Map(), isoCache: new Map()};
    if (dose.mode === 'off') dose.mode = 'wash';
    renderDosePanel(); draw(); busyDone();
    const acc = $('accDose'); if (acc) acc.classList.remove('closed');
    const dw = [...(info.warnings || [])];
    if (info.status === 'UNREGISTERED') dw.push(['bad', 'The dose is in a different frame of reference with no registration: it is shown unaligned.']);
    setChecks('dose', dw, busyBatch);
    return true;
  } catch (e) { busyDone(true); reportError('The dose could not be loaded', e); return false; }
}
function removeDose() {
  if (doseReady()) py.globals.get('remove_dose')();
  dose = null; setChecks('dose', [], true); renderDosePanel(); draw();
}
function doseInvalidate() { if (dose) { dose.planes.clear(); dose.isoCache.clear(); } }

// dose on a primary plane (native plane pixels), -1 outside the dose grid
function dosePlane(p, idx) {
  const key = p + '|' + idx;
  let a = dose.planes.get(key);
  if (a) return a;
  const proxy = py.globals.get('dose_plane')(p, idx); const u8 = proxy.toJs(); proxy.destroy();
  a = new Float32Array(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length));
  if (dose.planes.size > 40) dose.planes.clear();
  dose.planes.set(key, a);
  return a;
}

// ---------- drawing (viewer and atlas) ----------
// g: plane geometry {w, h, x0, y0, cw, ch}; sx, sy: canvas px per native px; lw: line-width scale
function drawDose(ctx, p, idx, g, sx, sy, lw, modeOverride) {
  if (!doseReady()) return;
  const mode = modeOverride || dose.mode;
  if (mode === 'off') return;
  const D = dosePlane(p, idx), W = g.w, ref = dose.ref || 1;
  const x0 = Math.max(0, g.x0), y0 = Math.max(0, g.y0), cw = g.cw, ch = g.ch;
  if (mode === 'wash') {
    const lut = getWashLut(), lo = dose.wash.lo / 100 * ref, hi = Math.max(lo + 1e-6, dose.wash.hi / 100 * ref);
    const tmp = drawDose.cv || (drawDose.cv = document.createElement('canvas'));
    tmp.width = cw; tmp.height = ch;
    const tc = tmp.getContext('2d'), im = tc.createImageData(cw, ch), px = im.data, A = Math.round(dose.alpha * 255);
    for (let y = 0; y < ch; y++) {
      const row = (y0 + y) * W + x0;
      for (let x = 0; x < cw; x++) {
        const v = D[row + x];
        if (!(v >= lo)) continue;
        const t = Math.min(255, Math.round((v - lo) / (hi - lo) * 255)) * 3, o = (y * cw + x) * 4;
        px[o] = lut[t]; px[o + 1] = lut[t + 1]; px[o + 2] = lut[t + 2]; px[o + 3] = A;
      }
    }
    tc.putImageData(im, 0, 0);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, cw, ch, (x0 - g.x0) * sx, (y0 - g.y0) * sy, cw * sx, ch * sy);
    ctx.restore();
  } else {
    const levels = dose.iso.filter(l => l.on && l.pct > 0);
    if (!levels.length) return;
    const key = `${p}|${idx}|${x0},${y0},${cw},${ch}|${ref}|${levels.map(l => l.pct).join(',')}`;
    let rings = dose.isoCache.get(key);
    if (!rings) {
      const sub = new Float32Array(cw * ch);
      for (let y = 0; y < ch; y++) sub.set(D.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + cw), y * cw);
      const gen = d3.contours().size([cw, ch]);
      rings = levels.map(l => gen.thresholds([l.pct / 100 * ref])(sub)[0]);
      if (dose.isoCache.size > 60) dose.isoCache.clear();
      dose.isoCache.set(key, rings);
    }
    ctx.save(); ctx.lineJoin = 'round';
    levels.forEach((l, i) => {
      const mp = rings[i]; if (!mp || !mp.coordinates.length) return;
      ctx.strokeStyle = l.color; ctx.lineWidth = ISO_W[l.w] * lw;
      ctx.beginPath();
      for (const poly of mp.coordinates) for (const ring of poly) {
        ring.forEach(([x, y], j) => { const cx = (x + x0 - g.x0) * sx, cy = (y + y0 - g.y0) * sy; j ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
        ctx.closePath();
      }
      ctx.stroke();
    });
    ctx.restore();
  }
}
// key entries for the legend: [{color: '#rrggbb', label}]
function doseLegendItems(modeOverride) {
  if (!doseReady()) return [];
  const mode = modeOverride || dose.mode;
  if (mode === 'iso') return dose.iso.filter(l => l.on && l.pct > 0).sort((a, b) => b.pct - a.pct).map(l => ({color: l.color, label: levelLabel(l.pct)}));
  if (mode === 'wash') {
    const lut = getWashLut(), out = [];
    for (let i = 4; i >= 0; i--) {
      const t = i / 4, pct = dose.wash.lo + t * (dose.wash.hi - dose.wash.lo), j = Math.round(t * 255) * 3;
      out.push({color: '#' + [lut[j], lut[j + 1], lut[j + 2]].map(v => v.toString(16).padStart(2, '0')).join(''), label: levelLabel(pct)});
    }
    return out;
  }
  return [];
}
// small key in the top-right corner of the viewer
function drawDoseKey(ctx, cv, dpr) {
  if (!doseReady() || dose.mode === 'off') return;
  const items = doseLegendItems(); if (!items.length) return;
  const fs = 11 * dpr, lh = 14 * dpr, pad = 6 * dpr;
  ctx.save(); ctx.font = `${fs}px system-ui`;
  const tw = Math.max(...items.map(i => ctx.measureText(i.label).width)) + 22 * dpr;
  const head = dose.mode === 'wash' ? 'Dose' : 'Isodose', bw = Math.max(tw, ctx.measureText(head).width) + 2 * pad;
  const bh = (items.length + 1) * lh + 2 * pad, x = cv.width - bw - 6 * dpr, y = 22 * dpr;
  ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x, y, bw, bh);
  ctx.fillStyle = '#ddd'; ctx.textBaseline = 'middle'; ctx.fillText(head, x + pad, y + pad + lh / 2);
  items.forEach((it, i) => {
    const yy = y + pad + (i + 1.5) * lh;
    if (dose.mode === 'wash') { ctx.fillStyle = it.color; ctx.fillRect(x + pad, yy - 5 * dpr, 14 * dpr, 10 * dpr); }
    else { ctx.strokeStyle = it.color; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.moveTo(x + pad, yy); ctx.lineTo(x + pad + 14 * dpr, yy); ctx.stroke(); }
    ctx.fillStyle = '#eee'; ctx.fillText(it.label, x + pad + 20 * dpr, yy);
  });
  ctx.restore();
}
// dose under the mouse
function doseReadout(e) {
  const el = $('doseRead'); if (!el || !doseReady() || !meta) return;
  const p = radio('plane'), g = planeGeom(p), a = toNativeF(e);
  const x = Math.floor(a.x), y = Math.floor(a.y);
  if (x < 0 || y < 0 || x >= g.w || y >= g.h) { el.textContent = ''; return; }
  const v = dosePlane(p, g.idx)[y * g.w + x];
  el.textContent = v < 0 ? 'Cursor: outside dose grid' : `Cursor: ${fmtGy(v)} ${DU()} (${(v / dose.ref * 100).toFixed(1)}%)`;
}

// ---------- panel ----------
function renderDosePanel() {
  const el = $('dosePanel'); if (!el) return;
  if (!meta) { el.innerHTML = ''; return; }
  const loadRow = `<div class="frow dload"><span class="pick"><button data-for="doseFile">${doseReady() ? 'Replace…' : 'Choose RTDOSE…'}</button><input type="file" id="doseFile" multiple></span>
    <span class="fn"></span><button id="doseLoad" class="${doseReady() ? '' : 'primary'}" style="display:none">Load</button>${doseReady() ? '<button id="doseRm" class="ghost">Remove</button>' : ''}</div>`;
  if (!doseReady()) {
    el.innerHTML = loadRow + '<small>Select the RTDOSE file, and the RTPLAN too if you want the prescription. Shows the total plan dose; per-beam doses are added together.</small>';
  } else {
    const I = dose.info, u = unitLabel(), rx = I.rx && I.rx.dose;
    const warn = I.status === 'UNREGISTERED' ? '<div class="bad">Not linked to the primary (different frame of reference, no REG): shown unregistered.</div>' : '';
    el.innerHTML = `${loadRow}
    <div class="dinfo">${esc(I.sum ? I.sum.toLowerCase() + ' dose' : 'dose')}${I.nFiles > 1 ? ` (${I.nFiles} files summed)` : ''}, max ${fmtGy(I.max)} ${DU()},
      grid ${I.ps[1].toFixed(1)} × ${I.ps[0].toFixed(1)} × ${Math.abs(I.gap).toFixed(1)} mm${rx ? `<br>Prescription ${fmtGy(rx)} Gy${I.rx.fx ? ' in ' + I.rx.fx + ' fractions' : ''} (${esc(I.rx.label || 'RTPLAN')})` : ''}
      ${I.notes.length ? '<br>' + I.notes.map(esc).join(' ') : ''}</div>${warn}
    <div class="drow"><span class="dl">Display</span><span class="seg"><label><input type="radio" name="dMode" value="off" ${dose.mode === 'off' ? 'checked' : ''}>Off</label>
      <label><input type="radio" name="dMode" value="wash" ${dose.mode === 'wash' ? 'checked' : ''}>Colourwash</label>
      <label><input type="radio" name="dMode" value="iso" ${dose.mode === 'iso' ? 'checked' : ''}>Isolines</label></span></div>
    <div class="drow"><span class="dl">Units</span><span class="seg"><label><input type="radio" name="dUnits" value="abs" ${dose.units === 'abs' ? 'checked' : ''}>${DU()}</label>
      <label><input type="radio" name="dUnits" value="rel" ${dose.units === 'rel' ? 'checked' : ''}>% of reference</label></span></div>
    <div class="drow"><span class="dl">Reference</span><input type="number" id="dRef" step="0.01" min="0.01" value="${fmtGy(dose.ref)}"> ${DU()}
      ${rx ? `<button id="dRefRx" title="Use the prescription from the plan">Rx ${fmtGy(rx)}</button>` : ''}<button id="dRefMax" title="Use the maximum dose">Max ${fmtGy(I.max)}</button></div>
    ${dose.mode === 'wash' ? `<div class="drow"><span class="dl">Range (${u})</span><input type="number" id="dLo" step="any" value="${pctToShown(dose.wash.lo)}" title="Lower dose"> to <input type="number" id="dHi" step="any" value="${pctToShown(dose.wash.hi)}" title="Upper dose"></div>
      <div class="drow"><span class="dl">Opacity</span><input type="range" id="dAlpha" min="0.1" max="0.9" step="0.05" value="${dose.alpha}" style="width:120px"></div>` : ''}
    ${dose.mode === 'iso' ? `<table class="diso"><tr><th></th><th>Level (${u})</th><th>Colour</th><th>Line</th></tr>${dose.iso.map((l, i) => `<tr>
      <td><input type="checkbox" class="dOn" data-i="${i}" ${l.on ? 'checked' : ''}></td>
      <td><input type="number" class="dLv" data-i="${i}" step="any" value="${pctToShown(l.pct)}"></td>
      <td><input type="color" class="dCol" data-i="${i}" value="${l.color}"></td>
      <td><select class="dW" data-i="${i}">${[[1, 'Thin'], [2, 'Medium'], [3, 'Thick']].map(([v, t]) => `<option value="${v}" ${l.w === v ? 'selected' : ''}>${t}</option>`).join('')}</select></td></tr>`).join('')}</table>
      <small>Levels are % of the reference dose, so they move with it.</small>` : ''}
    <div class="drow"><button id="dMax">Go to max dose</button> <span id="doseRead"></span></div>`;
  }
  wirePickers(el);
  $('doseFile').addEventListener('change', () => { if ($('doseFile').files.length) loadDoseFrom([...$('doseFile').files]); });
  $('doseLoad').onclick = () => loadDoseFrom([...$('doseFile').files]);
  if (!doseReady()) return;
  $('doseRm').onclick = removeDose;
  const q = s => el.querySelectorAll(s);
  q('input[name=dMode]').forEach(r => r.onchange = e => { dose.mode = e.target.value; renderDosePanel(); draw(); });
  q('input[name=dUnits]').forEach(r => r.onchange = e => { dose.units = e.target.value; renderDosePanel(); draw(); });
  const setRef = v => { if (v > 0) { dose.ref = v; dose.isoCache.clear(); renderDosePanel(); draw(); } };
  $('dRef').onchange = e => setRef(+e.target.value);
  $('dRefMax').onclick = () => setRef(dose.info.max);
  if ($('dRefRx')) $('dRefRx').onclick = () => setRef(dose.info.rx.dose);
  if ($('dLo')) {
    $('dLo').onchange = e => { dose.wash.lo = Math.max(0, shownToPct(+e.target.value)); draw(); };
    $('dHi').onchange = e => { dose.wash.hi = Math.max(dose.wash.lo + 0.1, shownToPct(+e.target.value)); draw(); };
    $('dAlpha').oninput = e => { dose.alpha = +e.target.value; draw(); };
  }
  q('.dOn').forEach(c => c.onchange = e => { dose.iso[+e.target.dataset.i].on = e.target.checked; draw(); });
  q('.dLv').forEach(c => c.onchange = e => { dose.iso[+e.target.dataset.i].pct = Math.max(0.1, shownToPct(+e.target.value)); draw(); });
  q('.dCol').forEach(c => c.oninput = e => { dose.iso[+e.target.dataset.i].color = e.target.value; draw(); });
  q('.dW').forEach(c => c.onchange = e => { dose.iso[+e.target.dataset.i].w = +e.target.value; draw(); });
  $('dMax').onclick = () => {
    const m = dose.info.maxAt;
    pos = {k: Math.round(m.k), r: Math.round(m.r), c: Math.round(m.c)};
    const c = crop || fullCrop();
    if (pos.k < c.k0 || pos.k > c.k1 || pos.r < c.r0 || pos.r > c.r1 || pos.c < c.c0 || pos.c > c.c1) setCrop(fullCrop(), 'Full (dose max was outside crop)');
    clampPos(); syncSlider(); draw();
  };
}
$('cv').addEventListener('mousemove', doseReadout);
