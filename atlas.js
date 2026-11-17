// ===================== Atlas PDF export =====================
// Builds a navigable PDF: title page (+contents), optional legend, then one slice per page.
// Uses globals from the main script (meta, rois, secs, notes, crop, py, ...).
const APLANES = ['ax', 'sag', 'cor'];
const PNAME = {ax: 'Axial', sag: 'Sagittal', cor: 'Coronal'};
let atlas = null;            // config, persisted between openings
let thumbImgs = {};          // plane -> canvas with the base image for the VOI editor
let voiDrag = null;
// every page is A4 landscape; image area = page minus margins/header/footer
const PG = {W: 297, H: 210, M: 5, HEAD: 17, FOOT: 15};
const IMG_ASPECT = (PG.H - PG.HEAD - PG.FOOT) / (PG.W - 2 * PG.M);   // max height/width that fills the page
let projCache = {key: '', cv: {}};

// ---------- config ----------
function atlasSync() {
  const c = {...(crop || fullCrop())};
  if (!atlas) {
    const gap = Math.abs(meta.sliceGap) || 1;
    atlas = {
      title: '', creator: '',
      voi: {ax: {...c}, sag: {...c}, cor: {...c}}, edit: 'ax', fresh: true,
      planeOn: {ax: true, sag: true, cor: true},
      // default ~3 mm between pages to keep the PDF manageable; set to 1 for every slice
      step: {ax: Math.max(1, Math.round(3 / gap)), sag: Math.max(1, Math.round(3 / meta.ps[1])), cor: Math.max(1, Math.round(3 / meta.ps[0]))},
      scans: [], roiOn: {}, notesOn: true,
      legend: {on: false, onlyDescribed: false, desc: {}},
      quality: 1200,
    };
  }
  // scans: primary, extra CT windows, then loaded secondaries (keep existing settings)
  const old = Object.fromEntries(atlas.scans.map(s => [s.key, s]));
  const ctW = priWin.ww, ctL = priWin.wl;
  const list = [old.pri || {key: 'pri', base: 'pri', kind: 'pri', include: true, planes: {ax: true, sag: true, cor: true}, ww: ctW, wl: ctL}];
  atlas.scans.filter(s => s.kind === 'win').forEach(s => list.push(s));
  for (const id of loadedIds())
    list.push(old[id] || {key: id, base: id, kind: 'sec', include: true, planes: {ax: true, sag: true, cor: true}, ww: secs[id].ww, wl: secs[id].wl});
  atlas.scans = list;
  // structures: default = currently visible
  rois.forEach(r => { if (!(r.number in atlas.roiOn)) atlas.roiOn[r.number] = r.visible; });
  if (atlas.fresh) { atlas.fresh = false; fitAspect('sag', atlas.voi.sag); fitAspect('cor', atlas.voi.cor); }
}
// sagittal/coronal boxes: limit the superior-inferior extent so the image fills a landscape page.
// mode: 't' keep bottom, 'b' keep top, otherwise centre on the selected structures (or the box)
function fitAspect(p, v, mode) {
  if (p === 'ax') return v;
  const gap = Math.abs(meta.sliceGap) || 1, W = p === 'sag' ? 'r' : 'c', psW = p === 'sag' ? meta.ps[0] : meta.ps[1];
  if (!mode) {
    // default: widen the box (up to the full scan) so the selected structures + margin fit in height
    let lo = Infinity, hi = -Infinity;
    for (const r of rois) if (atlas.roiOn[r.number] && r.ks.length) { lo = Math.min(lo, r.ks[0]); hi = Math.max(hi, r.ks[r.ks.length - 1]); }
    if (isFinite(lo)) {
      const m = Math.round((+$('cropMargin').value || 0) / gap);
      const needK = Math.min(v.k1, hi + m) - Math.max(v.k0, lo - m) + 1;
      const needW = Math.ceil(needK * gap / IMG_ASPECT / psW), haveW = v[W + '1'] - v[W + '0'] + 1;
      const full = (W === 'r' ? meta.rows : meta.cols);
      if (needW > haveW) {
        const w = Math.min(full, needW), mid = (v[W + '0'] + v[W + '1']) / 2;
        v[W + '0'] = Math.max(0, Math.min(full - w, Math.round(mid - w / 2))); v[W + '1'] = v[W + '0'] + w - 1;
      }
    }
  }
  const wMm = (v[W + '1'] - v[W + '0'] + 1) * psW;
  const maxK = Math.max(4, Math.floor(wMm * IMG_ASPECT / gap));
  if (v.k1 - v.k0 + 1 <= maxK) return v;
  if (mode === 't') v.k1 = v.k0 + maxK - 1;
  else if (mode === 'b') v.k0 = v.k1 - maxK + 1;
  else if (mode === 'keep') { const mid = (v.k0 + v.k1) / 2; v.k0 = Math.max(0, Math.round(mid - maxK / 2)); v.k1 = Math.min(meta.n - 1, v.k0 + maxK - 1); }
  else {
    let lo = Infinity, hi = -Infinity;
    for (const r of rois) if (atlas.roiOn[r.number] && r.ks.length) { lo = Math.min(lo, r.ks[0]); hi = Math.max(hi, r.ks[r.ks.length - 1]); }
    let mid = isFinite(lo) ? (lo + hi) / 2 : (v.k0 + v.k1) / 2;
    mid = Math.max(v.k0 + maxK / 2, Math.min(v.k1 - maxK / 2, mid));   // stay inside the current range
    v.k0 = Math.max(0, Math.round(mid - maxK / 2)); v.k1 = Math.min(meta.n - 1, v.k0 + maxK - 1);
  }
  return v;
}
// box around one structure (+ margin in mm); sagittal/coronal widened so its whole height fits the page
function voiForRoi(p, r, mm) {
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const k of r.ks) for (const poly of r.slices[k]) for (let j = 0; j < poly.length; j += 2) {
    c0 = Math.min(c0, poly[j]); c1 = Math.max(c1, poly[j]); r0 = Math.min(r0, poly[j + 1]); r1 = Math.max(r1, poly[j + 1]);
  }
  const gap = Math.abs(meta.sliceGap) || 1, mc = mm / meta.ps[1], mr = mm / meta.ps[0], mk = mm / gap;
  const cl = (v, hi) => Math.max(0, Math.min(hi, v));
  const v = {c0: cl(Math.floor(c0 - mc), meta.cols - 1), c1: cl(Math.ceil(c1 + mc), meta.cols - 1),
             r0: cl(Math.floor(r0 - mr), meta.rows - 1), r1: cl(Math.ceil(r1 + mr), meta.rows - 1),
             k0: cl(Math.floor(r.ks[0] - mk), meta.n - 1), k1: cl(Math.ceil(r.ks[r.ks.length - 1] + mk), meta.n - 1)};
  if (p !== 'ax') {
    const W = p === 'sag' ? 'r' : 'c', psW = p === 'sag' ? meta.ps[0] : meta.ps[1], full = p === 'sag' ? meta.rows : meta.cols;
    const needW = Math.min(full, Math.ceil((v.k1 - v.k0 + 1) * gap / IMG_ASPECT / psW)), haveW = v[W + '1'] - v[W + '0'] + 1;
    if (needW > haveW) {
      const mid = (v[W + '0'] + v[W + '1']) / 2;
      v[W + '0'] = Math.max(0, Math.min(full - needW, Math.round(mid - needW / 2))); v[W + '1'] = v[W + '0'] + needW - 1;
    }
    fitAspect(p, v, 'keep');
  }
  return v;
}
const atlasName = s => s.kind === 'win' ? s.name : scanName(s.key);
const atlasDoseMode = () => !doseReady() ? 'off' : dose.mode === 'off' ? 'iso' : dose.mode;
const pageHasDose = s => !!(s.dose && doseReady());
function setAtlasName(s, v) {
  if (s.kind === 'win') s.name = v;
  else if (s.key === 'pri') { priName = v; $('name_pri').value = v; }
  else { secs[s.key].label = v; $('name_' + s.key).value = v; }
}
// slices of the edited plane that carry a note on any included scan (always included as pages)
function noteSlices(p) {
  if (!atlas.notesOn) return [];
  const v = atlas.voi[p], bases = new Set(atlas.scans.filter(s => s.include && s.planes[p]).map(s => s.base));
  const [lo, hi] = p === 'ax' ? [v.k0, v.k1] : p === 'sag' ? [v.c0, v.c1] : [v.r0, v.r1];
  return [...new Set(notes.filter(n => n.views[p] && n.views[p].on && bases.has(n.scan) && (n.text || '').trim())
    .map(n => noteIdx(n, p)).filter(i => i >= lo && i <= hi))];
}
function sliceList(p) {
  const v = atlas.voi[p], st = Math.max(1, atlas.step[p] | 0), out = new Set();
  if (p === 'ax') for (let k = v.k1; k >= v.k0; k -= st) out.add(k);
  else if (p === 'sag') for (let c = v.c0; c <= v.c1; c += st) out.add(c);
  else for (let r = v.r0; r <= v.r1; r += st) out.add(r);
  noteSlices(p).forEach(i => out.add(i));
  // axial: superior -> inferior; sagittal: patient right -> left; coronal: anterior -> posterior
  return [...out].sort((a, b) => p === 'ax' ? b - a : a - b);
}
function spacingMm(p) {
  const gap = Math.abs(meta.sliceGap) || 1;
  return (atlas.step[p] || 1) * (p === 'ax' ? gap : p === 'sag' ? meta.ps[1] : meta.ps[0]);
}
// same geometry as the viewer's planeGeom, but for an arbitrary VOI
function geomVoi(p, v) {
  const {n, rows, cols, ps} = meta, gap = Math.abs(meta.sliceGap) || 1;
  const yk0 = (n - 1) - v.k1, yk1 = (n - 1) - v.k0;
  let g;
  if (p === 'ax')       g = {w: cols, h: rows, x0: v.c0, x1: v.c1, y0: v.r0, y1: v.r1, psx: ps[1], psy: ps[0]};
  else if (p === 'sag') g = {w: rows, h: n, x0: v.r0, x1: v.r1, y0: yk0, y1: yk1, psx: ps[0], psy: gap};
  else                  g = {w: cols, h: n, x0: v.c0, x1: v.c1, y0: yk0, y1: yk1, psx: ps[1], psy: gap};
  g.cw = g.x1 - g.x0 + 1; g.ch = g.y1 - g.y0 + 1; g.mmW = g.cw * g.psx; g.mmH = g.ch * g.psy;
  return g;
}

// ---------- dialog ----------
function atlasOpen() {
  if (!meta) return;
  atlasSync();
  let dlg = $('atlasDlg');
  if (!dlg) { dlg = document.createElement('div'); dlg.id = 'atlasDlg'; document.body.appendChild(dlg); }
  dlg.style.display = 'block';
  atlasRender();
}
function atlasClose() {
  $('atlasDlg').style.display = 'none';
  buildImgSel(); buildRoiPanel(); draw(); renderNotesPanel();
}
$('atlasBtn').onclick = atlasOpen;

function atlasRender() {
  const A = atlas, dlg = $('atlasDlg');
  const incRois = rois.filter(r => A.roiOn[r.number]);
  dlg.innerHTML = `<div class="panel">
  <button class="ghost x" id="aX" aria-label="Close">×</button>
  <h3>Create atlas</h3>
  <p class="sub">Work down the steps, then build a PDF or PowerPoint at the bottom. Settings are kept if you close this and come back.</p>
  <h4>Title</h4>
  <div class="frow"><span class="fl">Atlas title</span><input type="text" id="aTitle" style="width:420px" value="${esc(A.title)}" placeholder="e.g. Prostate + pelvic nodes CTV atlas"></div>
  <div class="frow"><span class="fl">Created by <small>(optional)</small></span><input type="text" id="aCreator" style="width:260px" value="${esc(A.creator)}"></div>

  <h4>Area and slices</h4>
  <p class="hint">Each plane has its own box. Choose the plane to edit, then drag inside a box to move it or drag its edges to resize it, on any of the three views.
  Shading shows the full extent of the selected structures. Sagittal and coronal boxes are limited in height so the image fills a landscape A4 page; widen the box to allow more height.</p>
  <table style="margin-top:6px"><tr><th>Edit</th><th>Plane</th><th>Every Nth slice</th><th>Spacing</th><th>Pages per scan</th><th></th></tr>
  ${APLANES.map(p => `<tr>
    <td><input type="radio" name="voiEdit" value="${p}" ${A.edit === p ? 'checked' : ''}></td><td>${PNAME[p]}</td>
    <td><input type="number" class="aStep" data-p="${p}" min="1" max="50" value="${A.step[p]}"></td>
    <td id="aSp_${p}">${spacingMm(p).toFixed(1)} mm</td><td id="aPg_${p}">${sliceList(p).length}</td><td id="aNs_${p}" style="color:#ffd400"></td></tr>`).join('')}
  </table>
  <button id="aVoiReset">Reset this box to the current crop</button> <button id="aVoiCopy">Copy this box to all planes</button>
  <div style="margin-top:4px">Fit box to a structure: <select id="aVoiRoi"><option value="">Choose structure…</option>${rois.filter(r => r.ks.length).map(r => `<option value="${r.number}" ${A.voiRoi == r.number ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    &plusmn; <input type="number" id="aVoiMargin" min="0" max="200" value="${A.voiMargin ?? 15}"> mm
    <button id="aVoiFit">Fit this box</button> <button id="aVoiFitAll">Fit all three boxes</button>
    <small style="color:#999">Sagittal/coronal boxes are widened if needed so the structure's full height fits the page.</small></div>
  <div class="thumbs">${APLANES.map(p => `<div><canvas id="aTh_${p}"></canvas><br>${PNAME[p]}</div>`).join('')}</div>

  <h4>Scans</h4>
  <table><tr><th>Include</th><th>Name in atlas</th><th>Type</th><th>W</th><th>L</th><th title="Overlay the dose as shown in the viewer">Dose</th>${APLANES.map(p => `<th><label title="All scans"><input type="checkbox" class="aPlaneAll" data-p="${p}" ${A.scans.every(s => s.planes[p]) ? 'checked' : ''}> ${PNAME[p]}</label></th>`).join('')}<th></th></tr>
  ${A.scans.map((s, i) => `<tr>
    <td><input type="checkbox" class="aScan" data-i="${i}" ${s.include ? 'checked' : ''}></td>
    <td><input type="text" class="aScanName" data-i="${i}" value="${esc(atlasName(s))}" style="width:200px"></td>
    <td>${s.kind === 'pri' ? 'Primary CT' : s.kind === 'win' ? (s.dose ? 'CT with dose' : 'CT, other window') : (secs[s.key].status === 'UNREGISTERED' ? '<span style="color:#f88">unregistered</span>' : 'registered scan')}</td>
    <td><input type="number" class="aWW" data-i="${i}" value="${s.ww}"></td><td><input type="number" class="aWL" data-i="${i}" value="${s.wl}"></td>
    <td><input type="checkbox" class="aDose" data-i="${i}" ${s.dose && doseReady() ? 'checked' : ''} ${doseReady() ? '' : 'disabled'}></td>
    ${APLANES.map(p => `<td><input type="checkbox" class="aSP" data-i="${i}" data-p="${p}" ${s.planes[p] ? 'checked' : ''}></td>`).join('')}
    <td>${s.kind === 'win' ? `<button class="aRmWin" data-i="${i}">Remove</button>` : ''}</td></tr>`).join('')}
  </table>
  Add the CT in another window: <select id="aWinPreset"><option value="Lung window|1600|-600">Lung 1600/-600</option><option value="Bone window|2000|300">Bone 2000/300</option><option value="Mediastinal window|350|40">Mediastinal 350/40</option><option value="Custom window|400|40">Custom</option></select>
  <button id="aAddWin">+ Add CT window</button>
  &nbsp; <button id="aAddDose" ${doseReady() ? '' : 'disabled'} title="A separate copy of the CT with the dose and contours, in addition to the CT with contours">+ Add CT with dose</button>
  ${doseReady() ? `<div style="color:#999;margin-top:4px">Dose is drawn as set in the viewer: ${atlasDoseMode() === 'wash' ? 'colourwash' : 'isolines'}, reference ${fmtGy(dose.ref)} Gy, levels in ${dose.units === 'rel' ? '%' : 'Gy'}.${dose.mode === 'off' ? ' (Dose display is off in the viewer, so pages use the isolines.)' : ''}</div>` : '<div style="color:#777;margin-top:4px">No dose loaded.</div>'}

  <h4>Structures</h4>
  <button id="aRoiAll">All</button><button id="aRoiNone">None</button><button id="aRoiVis">Match viewer</button>
  <div class="roiGrid" style="margin-top:4px">${rois.map(r => `<label><input type="checkbox" class="aRoi" data-n="${r.number}" ${A.roiOn[r.number] ? 'checked' : ''}>
    <span class="sw" style="background:rgb(${r.color})"></span>${esc(r.name)}</label>`).join('')}</div>

  <h4>Notes</h4>
  <label><input type="checkbox" id="aNotes" ${A.notesOn ? 'checked' : ''}> Include notes (${notes.length} in total)</label>

  <h4>Legend</h4>
  <label><input type="checkbox" id="aLeg" ${A.legend.on ? 'checked' : ''}> Add a legend page describing the structures</label>
  <div id="aLegBox" style="display:${A.legend.on ? 'block' : 'none'};margin-top:6px">
    <div id="aLegMsg" style="margin-bottom:6px;font-size:12px"></div>
    <label><input type="checkbox" id="aLegOnly" ${A.legend.onlyDescribed ? 'checked' : ''}> Only list structures that have a description</label>
    <table>${incRois.map(r => `<tr><td style="vertical-align:top;white-space:nowrap"><span class="sw" style="background:rgb(${r.color})"></span>${esc(r.name)}</td>
      <td><textarea class="aDesc ${(A.legend.desc[r.number] || '').trim() ? '' : 'empty'}" data-n="${r.number}" placeholder="Description, e.g. boundaries / guideline reference">${esc(A.legend.desc[r.number] || '')}</textarea></td></tr>`).join('')}</table>
  </div>

  <h4>Output</h4>
  <div class="frow"><span class="fl">Image resolution</span><select id="aQ">${[800, 1000, 1200, 1600, 2200].map(q => `<option ${A.quality === q ? 'selected' : ''}>${q}</option>`).join('')}</select> <small>px wide</small></div>
  <p class="hint">The CT itself is only ~300–500 px across the crop, so above ~1200 px only the contour lines and note text get sharper.</p>
  <div class="foot">
    <span id="aSummary"></span>
    <button id="aBuild" class="primary">Build PDF</button>
    <button id="aBuildPpt" class="primary">Build PowerPoint</button>
    <select id="aPptLayout" title="PowerPoint slide size"><option value="16x9" ${(A.pptLayout || '16x9') === '16x9' ? 'selected' : ''}>Slides 16:9</option><option value="A4" ${A.pptLayout === 'A4' ? 'selected' : ''}>Slides A4</option></select>
    <button id="aClose">Close</button>
    <progress id="aProg" value="0" max="1" style="display:none"></progress> <span id="aProgTxt"></span>
  </div></div>`;

  const q = s => dlg.querySelectorAll(s);
  $('aTitle').oninput = e => A.title = e.target.value;
  $('aCreator').oninput = e => A.creator = e.target.value;
  q('input[name=voiEdit]').forEach(x => x.onchange = e => { A.edit = e.target.value; refreshThumbImgs(); });
  q('.aPlaneAll').forEach(x => x.onchange = e => { A.scans.forEach(s => s.planes[e.target.dataset.p] = e.target.checked); atlasRender(); });
  q('.aStep').forEach(x => x.oninput = e => { A.step[e.target.dataset.p] = Math.max(1, +e.target.value | 0); atlasCounts(); });
  $('aVoiReset').onclick = () => { A.voi[A.edit] = fitAspect(A.edit, {...(crop || fullCrop())}); refreshThumbImgs(); atlasCounts(); };
  $('aVoiRoi').onchange = e => A.voiRoi = e.target.value;
  $('aVoiMargin').oninput = e => A.voiMargin = +e.target.value;
  const fitRoi = planes => {
    const r = rois.find(x => x.number == A.voiRoi);
    if (!r) { $('aVoiRoi').focus(); return; }
    planes.forEach(p => A.voi[p] = voiForRoi(p, r, +(A.voiMargin ?? 15)));
    refreshThumbImgs(); atlasCounts();
  };
  $('aVoiFit').onclick = () => fitRoi([A.edit]);
  $('aVoiFitAll').onclick = () => fitRoi(APLANES);
  $('aVoiCopy').onclick = () => { const v = A.voi[A.edit]; APLANES.forEach(p => A.voi[p] = fitAspect(p, {...v})); atlasCounts(); };
  q('.aScan').forEach(x => x.onchange = e => { A.scans[+e.target.dataset.i].include = e.target.checked; atlasSummary(); });
  q('.aScanName').forEach(x => x.oninput = e => setAtlasName(A.scans[+e.target.dataset.i], e.target.value));
  q('.aWW').forEach(x => x.oninput = e => A.scans[+e.target.dataset.i].ww = +e.target.value);
  q('.aWL').forEach(x => x.oninput = e => A.scans[+e.target.dataset.i].wl = +e.target.value);
  q('.aSP').forEach(x => x.onchange = e => { A.scans[+e.target.dataset.i].planes[e.target.dataset.p] = e.target.checked; atlasRender(); });
  q('.aDose').forEach(x => x.onchange = e => { A.scans[+e.target.dataset.i].dose = e.target.checked; });
  $('aAddDose').onclick = () => {
    const pri = A.scans[0], pos = A.scans.findIndex(s => s.kind === 'sec');
    const n = A.scans.filter(s => s.kind === 'win' && s.dose).length + 1;
    A.scans.splice(pos < 0 ? A.scans.length : pos, 0, {key: 'w' + Date.now(), base: 'pri', kind: 'win', name: `${scanName('pri')} + dose${n > 1 ? ' ' + n : ''}`,
      include: true, planes: {...pri.planes}, ww: pri.ww, wl: pri.wl, dose: true});
    atlasRender();
  };
  q('.aRmWin').forEach(x => x.onclick = e => { A.scans.splice(+e.target.dataset.i, 1); atlasRender(); });
  $('aAddWin').onclick = () => {
    const [name, ww, wl] = $('aWinPreset').value.split('|');
    const n = A.scans.filter(s => s.kind === 'win').length + 1;
    const pos = A.scans.findIndex(s => s.kind === 'sec');
    const s = {key: 'w' + Date.now(), base: 'pri', kind: 'win', name: `${scanName('pri')} ${name.toLowerCase()}${n > 1 ? ' ' + n : ''}`,
               include: true, planes: {...A.scans[0].planes}, ww: +ww, wl: +wl};
    A.scans.splice(pos < 0 ? A.scans.length : pos, 0, s); atlasRender();
  };
  const setRois = f => { rois.forEach(r => A.roiOn[r.number] = f(r)); atlasRender(); };
  $('aRoiAll').onclick = () => setRois(() => true); $('aRoiNone').onclick = () => setRois(() => false); $('aRoiVis').onclick = () => setRois(r => r.visible);
  q('.aRoi').forEach(x => x.onchange = e => { A.roiOn[+e.target.dataset.n] = e.target.checked; atlasRender(); });  // re-renders thumbs + legend
  $('aNotes').onchange = e => { A.notesOn = e.target.checked; atlasCounts(); };
  $('aLeg').onchange = e => { A.legend.on = e.target.checked; $('aLegBox').style.display = A.legend.on ? 'block' : 'none'; legendMsg(); atlasSummary(); };
  $('aLegOnly').onchange = e => { A.legend.onlyDescribed = e.target.checked; };
  q('.aDesc').forEach(x => x.oninput = e => { A.legend.desc[+e.target.dataset.n] = e.target.value; e.target.classList.toggle('empty', !e.target.value.trim()); legendMsg(); });
  $('aQ').onchange = e => { A.quality = +e.target.value; atlasSummary(); };
  $('aClose').onclick = $('aX').onclick = () => atlasClose();
  $('aBuild').onclick = buildAtlas;
  $('aBuildPpt').onclick = buildPptx;
  $('aPptLayout').onchange = e => A.pptLayout = e.target.value;
  legendMsg(); initThumbs(); refreshThumbImgs(); atlasCounts();
}
function legendMsg() {
  const el = $('aLegMsg'); if (!el) return;
  const inc = rois.filter(r => atlas.roiOn[r.number]);
  const missing = inc.filter(r => !(atlas.legend.desc[r.number] || '').trim()).length;
  el.textContent = missing ? `Please fill in descriptions: ${missing} of ${inc.length} included structures have none yet (highlighted).` : 'All included structures have a description.';
  el.style.color = missing ? 'var(--warn)' : 'var(--ok)';
}
function atlasCounts() {
  APLANES.forEach(p => {
    $('aSp_' + p).textContent = spacingMm(p).toFixed(1) + ' mm'; $('aPg_' + p).textContent = sliceList(p).length;
    const k = noteSlices(p).length; $('aNs_' + p).textContent = k ? `incl. ${k} annotated slice${k > 1 ? 's' : ''}` : '';
  });
  drawThumbs(); atlasSummary();
}
function atlasPlan() {
  const scans = atlas.scans.filter(s => s.include);
  const sections = [];
  for (const s of scans) for (const p of APLANES)
    if (s.planes[p]) sections.push({s, p, idxs: sliceList(p)});
  return sections;
}
function atlasSummary() {
  const el = $('aSummary'); if (!el) return;
  const secs_ = atlasPlan(), pages = secs_.reduce((a, s) => a + s.idxs.length, 0);
  const mb = pages * 0.14 * Math.pow(atlas.quality / 1600, 1.6);
  el.textContent = `${secs_.length} sections, ${pages} image pages (+ title${atlas.legend.on ? ' + legend' : ''}). Estimated size ≈ ${mb < 1000 ? mb.toFixed(0) + ' MB' : (mb / 1000).toFixed(1) + ' GB'} (PDF; PowerPoint similar).`;
}

// ---------- VOI editor (three thumbnails, box of the plane being edited) ----------
function thumbGeom(p) {
  const {n, rows, cols, ps} = meta, gap = Math.abs(meta.sliceGap) || 1;
  if (p === 'ax') return {w: cols, h: rows, mmW: cols * ps[1], mmH: rows * ps[0], X: 'c', Y: 'r', flip: false};
  if (p === 'sag') return {w: rows, h: n, mmW: rows * ps[0], mmH: n * gap, X: 'r', Y: 'k', flip: true};
  return {w: cols, h: n, mmW: cols * ps[1], mmH: n * gap, X: 'c', Y: 'k', flip: true};
}
const AXMAX = () => ({c: meta.cols - 1, r: meta.rows - 1, k: meta.n - 1});
function initThumbs() {
  for (const p of APLANES) {
    const cv = $('aTh_' + p), t = thumbGeom(p), s = Math.min(320 / t.mmW, 320 / t.mmH);
    cv.style.width = Math.round(t.mmW * s) + 'px'; cv.style.height = Math.round(t.mmH * s) + 'px';
    cv.width = Math.round(t.mmW * s); cv.height = Math.round(t.mmH * s);
    cv.onmousedown = e => voiDown(e, p);
    cv.onmousemove = e => { if (!voiDrag) cv.style.cursor = cursorFor(hitVoi(e, p)); };
  }
}
function refreshThumbImgs() {     // base images through the centre of the box being edited
  const v = atlas.voi[atlas.edit], {ww, wl} = priWin;
  const mid = {ax: Math.round((v.k0 + v.k1) / 2), sag: Math.round((v.c0 + v.c1) / 2), cor: Math.round((v.r0 + v.r1) / 2)};
  for (const p of APLANES) {
    const t = thumbGeom(p);
    const proxy = py.globals.get('plane_rgba')(p, mid[p], ww, wl, 'pri'); const buf = proxy.toJs(); proxy.destroy();
    const c = thumbImgs[p] || (thumbImgs[p] = document.createElement('canvas'));
    c.width = t.w; c.height = t.h;
    c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), t.w, t.h), 0, 0);
  }
  drawThumbs();
}
function boxEdges(p, v) {          // box edges in native thumbnail coordinates
  const t = thumbGeom(p), n = meta.n;
  const x0 = v[t.X + '0'], x1 = v[t.X + '1'] + 1;
  const [y0, y1] = t.flip ? [n - (v.k1 + 1), n - v.k0] : [v[t.Y + '0'], v[t.Y + '1'] + 1];
  return {x0, x1, y0, y1};
}
// full extent of each selected structure projected onto each view (translucent fill)
function projections() {
  const sel = rois.filter(r => atlas.roiOn[r.number] && r.ks.length);
  const key = sel.map(r => r.number + ':' + r.color).join('|');
  if (projCache.key === key) return projCache.cv;
  const n = meta.n, out = {};
  for (const p of APLANES) {
    const t = thumbGeom(p), cv = document.createElement('canvas'); cv.width = t.w; cv.height = t.h;
    const ctx = cv.getContext('2d'), tmp = document.createElement('canvas'); tmp.width = t.w; tmp.height = t.h;
    const tc = tmp.getContext('2d');
    for (const r of sel) {
      tc.clearRect(0, 0, t.w, t.h); tc.fillStyle = `rgb(${r.color})`;
      for (const k of r.ks) for (const poly of r.slices[k]) {
        if (p === 'ax') {
          tc.beginPath(); tc.moveTo(poly[0] + .5, poly[1] + .5);
          for (let j = 2; j < poly.length; j += 2) tc.lineTo(poly[j] + .5, poly[j + 1] + .5);
          tc.closePath(); tc.fill();
        } else {
          let lo = Infinity, hi = -Infinity, o = p === 'sag' ? 1 : 0;   // sag: rows (y), cor: cols (x)
          for (let j = o; j < poly.length; j += 2) { lo = Math.min(lo, poly[j]); hi = Math.max(hi, poly[j]); }
          tc.fillRect(lo, (n - 1) - k, hi - lo + 1, 1);
        }
      }
      ctx.globalAlpha = 0.45; ctx.drawImage(tmp, 0, 0); ctx.globalAlpha = 1;
    }
    out[p] = cv;
  }
  projCache = {key, cv: out};
  return out;
}
function drawThumbs() {
  const proj = projections();
  for (const p of APLANES) {
    const cv = $('aTh_' + p); if (!cv || !thumbImgs[p]) continue;
    const t = thumbGeom(p), ctx = cv.getContext('2d'), kx = cv.width / t.w, ky = cv.height / t.h;
    ctx.drawImage(thumbImgs[p], 0, 0, cv.width, cv.height);
    if (proj[p]) ctx.drawImage(proj[p], 0, 0, cv.width, cv.height);
    const b = boxEdges(p, atlas.voi[atlas.edit]);
    const X0 = b.x0 * kx, X1 = b.x1 * kx, Y0 = b.y0 * ky, Y1 = b.y1 * ky;
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(0, 0, cv.width, Y0); ctx.fillRect(0, Y1, cv.width, cv.height - Y1);
    ctx.fillRect(0, Y0, X0, Y1 - Y0); ctx.fillRect(X1, Y0, cv.width - X1, Y1 - Y0);
    ctx.strokeStyle = '#0ff'; ctx.lineWidth = 2; ctx.strokeRect(X0, Y0, X1 - X0, Y1 - Y0);
    // where the pages of the edited plane cut this view
    const ep = atlas.edit;
    if (ep !== p) {
      ctx.strokeStyle = 'rgba(255,212,0,.35)'; ctx.lineWidth = 1;
      const idxs = sliceList(ep);
      for (const i of idxs) {
        ctx.beginPath();
        if (ep === 'ax') { const y = ((meta.n - 1 - i) + .5) * ky; ctx.moveTo(X0, y); ctx.lineTo(X1, y); }
        else if (ep === 'sag') { const x = (i + .5) * kx; if (p === 'ax' || p === 'cor') { ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); } }
        else { if (p === 'ax') { const y = (i + .5) * ky; ctx.moveTo(X0, y); ctx.lineTo(X1, y); } else if (p === 'sag') { const x = (i + .5) * kx; ctx.moveTo(x, Y0); ctx.lineTo(x, Y1); } }
        ctx.stroke();
      }
    }
  }
}
function hitVoi(e, p) {
  const cv = $('aTh_' + p), r = cv.getBoundingClientRect(), t = thumbGeom(p);
  const mx = e.clientX - r.left, my = e.clientY - r.top, kx = r.width / t.w, ky = r.height / t.h;
  const b = boxEdges(p, atlas.voi[atlas.edit]), tol = 7;
  const X0 = b.x0 * kx, X1 = b.x1 * kx, Y0 = b.y0 * ky, Y1 = b.y1 * ky;
  const inY = my > Y0 - tol && my < Y1 + tol, inX = mx > X0 - tol && mx < X1 + tol;
  const h = {l: inY && Math.abs(mx - X0) < tol, r: inY && Math.abs(mx - X1) < tol, t: inX && Math.abs(my - Y0) < tol, b: inX && Math.abs(my - Y1) < tol};
  h.move = !h.l && !h.r && !h.t && !h.b && mx > X0 && mx < X1 && my > Y0 && my < Y1;
  return h;
}
function cursorFor(h) {
  if ((h.l && h.t) || (h.r && h.b)) return 'nwse-resize';
  if ((h.r && h.t) || (h.l && h.b)) return 'nesw-resize';
  if (h.l || h.r) return 'ew-resize';
  if (h.t || h.b) return 'ns-resize';
  return h.move ? 'move' : 'default';
}
function voiDown(e, p) {
  const h = hitVoi(e, p);
  if (!h.l && !h.r && !h.t && !h.b && !h.move) return;
  e.preventDefault();
  voiDrag = {p, h, x: e.clientX, y: e.clientY, start: {...atlas.voi[atlas.edit]}};
}
window.addEventListener('mousemove', e => {
  if (!voiDrag) return;
  const {p, h, start} = voiDrag, t = thumbGeom(p), cv = $('aTh_' + p), r = cv.getBoundingClientRect();
  const dX = Math.round((e.clientX - voiDrag.x) * t.w / r.width);
  let dY = Math.round((e.clientY - voiDrag.y) * t.h / r.height);
  if (t.flip) dY = -dY;                         // display y runs opposite to slice index
  const v = {...start}, mx = AXMAX();
  const clamp = (a, x) => Math.max(0, Math.min(mx[a], x));
  if (h.move) {
    for (const [a, d] of [[t.X, dX], [t.Y, dY]]) {
      const lo = start[a + '0'], hi = start[a + '1'];
      const dd = Math.max(-lo, Math.min(mx[a] - hi, d));
      v[a + '0'] = lo + dd; v[a + '1'] = hi + dd;
    }
  } else {
    if (h.l) v[t.X + '0'] = clamp(t.X, Math.min(start[t.X + '1'] - 4, start[t.X + '0'] + dX));
    if (h.r) v[t.X + '1'] = clamp(t.X, Math.max(start[t.X + '0'] + 4, start[t.X + '1'] + dX));
    // top edge of the display = low row (ax) or high slice (sag/cor)
    const top = t.flip ? '1' : '0', bot = t.flip ? '0' : '1';
    if (h.t) v[t.Y + top] = clamp(t.Y, t.flip ? Math.max(start.k0 + 4, start.k1 + dY) : Math.min(start[t.Y + '1'] - 4, start[t.Y + '0'] + dY));
    if (h.b) v[t.Y + bot] = clamp(t.Y, t.flip ? Math.min(start.k1 - 4, start.k0 + dY) : Math.max(start[t.Y + '0'] + 4, start[t.Y + '1'] + dY));
  }
  if (atlas.edit !== 'ax' && t.Y === 'k') fitAspect(atlas.edit, v, h.t ? 't' : h.b ? 'b' : 'keep');
  else if (atlas.edit !== 'ax') fitAspect(atlas.edit, v, 'keep');
  atlas.voi[atlas.edit] = v;
  atlasCounts();
});
window.addEventListener('mouseup', () => { if (voiDrag) { voiDrag = null; refreshThumbImgs(); } });

// ---------- page rendering ----------
const ROI_DRAWN = new Set();
// layout of a note box in output pixels (shared by the PDF raster and the PowerPoint shapes)
function noteLayout(ctx, n, p, g, sx, sy, W, H) {
  const v = n.views[p], ref = v.fs ? v : (Object.values(n.views).find(x => x.fs) || {});
  const fs = (ref.fs || g.cw / 60) * sx, k = fs / 12;
  const padX = 6 * k, padY = 3 * k, lh = fs * 1.35;
  ctx.font = `${fs}px system-ui, sans-serif`;
  const maxText = 248 * k;
  const lines = [];
  for (const para of (n.text || '').split('\n')) {
    let cur = '';
    for (const w of para.split(/(\s+)/)) {
      const t = cur + w;
      if (ctx.measureText(t.trimEnd()).width > maxText && cur.trim()) { lines.push(cur.trimEnd()); cur = w.trimStart(); }
      else cur = t;
    }
    lines.push(cur.trimEnd());
  }
  const tw = Math.max(24 * k, ...lines.map(l => ctx.measureText(l).width));
  const bw = tw + 2 * padX, bh = lines.length * lh + 2 * padY;
  let bx = (v.box.x - g.x0) * sx, by = (v.box.y - g.y0) * sy;
  bx = Math.max(0, Math.min(W - bw, bx)); by = Math.max(0, Math.min(H - bh, by));
  const T = {X: x => (x - g.x0) * sx, Y: y => (y - g.y0) * sy, sx, sy}, box = {l: bx, t: by, w: bw, h: bh};
  const mk = noteMarkerGeom(n, p, T, box);
  return {fs, k, padX, padY, lh, lines, bx, by, bw, bh, T, box, mk};
}
function drawNoteOnCanvas(ctx, n, p, g, sx, sy, W, H) {
  const {fs, k, padX, padY, lh, lines, bx, by, bw, bh, T, box} = noteLayout(ctx, n, p, g, sx, sy, W, H);
  drawNoteMarker(ctx, n, p, T, box, k, false);
  ctx.font = `${fs}px system-ui, sans-serif`; ctx.lineWidth = 1.5 * k;
  ctx.fillStyle = 'rgba(10,10,10,.82)'; ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = '#ffd400'; ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + padX, by + padY + i * lh + (lh - fs) / 2));
}
function notesOn(s, p, idx) {
  if (!atlas.notesOn) return [];
  return notes.filter(n => noteShown(n, p, idx, s.base) && (n.text || '').trim());
}
// returns {canvas, present: [rois on this slice]}
function renderAtlasImage(s, p, idx, W, H, opts) {
  const v = atlas.voi[p], g = geomVoi(p, v);
  const which = s.kind === 'sec' ? s.key : 'pri';
  const proxy = py.globals.get('plane_rgba')(p, idx, s.ww, s.wl, which); const buf = proxy.toJs(); proxy.destroy();
  off.width = g.w; off.height = g.h;
  off.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), g.w, g.h), 0, 0);
  const cv = renderAtlasImage.cv || (renderAtlasImage.cv = document.createElement('canvas'));
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(off, g.x0, g.y0, g.cw, g.ch, 0, 0, W, H);
  const sx = W / g.cw, sy = H / g.ch, X = x => (x - g.x0 + .5) * sx, Y = y => (y - g.y0 + .5) * sy;
  if (pageHasDose(s) && !(opts && opts.noDose)) drawDose(ctx, p, idx, g, sx, sy, W / 760, atlasDoseMode());
  ctx.lineJoin = 'round';
  const present = [];
  const gIdx = {...g, idx};
  for (const r of rois) {
    if (!atlas.roiOn[r.number]) continue;
    ctx.strokeStyle = `rgb(${r.color})`; ctx.lineWidth = Math.max(1, (r.lw ?? lineWidth) * W / 760);
    if (p === 'ax') {
      const cs = r.slices[idx]; if (!cs) continue;
      present.push(r);
      for (const c of cs) {
        ctx.beginPath(); ctx.moveTo(X(c[0]), Y(c[1]));
        for (let j = 2; j < c.length; j += 2) ctx.lineTo(X(c[j]), Y(c[j + 1]));
        ctx.closePath(); ctx.stroke();
      }
    } else {
      const o = reslicedOutline(r, p, idx, gIdx); if (!o) continue;
      present.push(r);
      ctx.beginPath();
      for (const poly of o.mp.coordinates) for (const ring of poly) {
        ring.forEach(([x, y], j) => { const cx = (x - g.x0) * sx, cy = (y + o.yoff - g.y0) * sy; j ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
        ctx.closePath();
      }
      ctx.stroke();
    }
  }
  if (!opts || !opts.vectorNotes) for (const n of notesOn(s, p, idx)) drawNoteOnCanvas(ctx, n, p, g, sx, sy, W, H);
  if (opts && opts.noLabels) return {cv, present, g, sx, sy};
  // orientation labels
  const fs = Math.round(W / 70);
  ctx.font = `${fs}px system-ui, sans-serif`; ctx.fillStyle = '#ff0'; ctx.textBaseline = 'middle';
  const lab = p === 'ax' ? ['R', 'L', 'A', 'P'] : p === 'sag' ? ['A', 'P', 'S', 'I'] : ['R', 'L', 'S', 'I'];
  ctx.textAlign = 'left'; ctx.fillText(lab[0], fs * .5, H / 2);
  ctx.textAlign = 'right'; ctx.fillText(lab[1], W - fs * .5, H / 2);
  ctx.textAlign = 'center'; ctx.fillText(lab[2], W / 2, fs); ctx.fillText(lab[3], W / 2, H - fs);
  ctx.textAlign = 'left';
  return {cv, present, g, sx, sy};
}
const canvasJpeg = cv => new Promise(res => cv.toBlob(b => b.arrayBuffer().then(a => res(new Uint8Array(a))), 'image/jpeg', 0.9));
function slicePosLabel(p, idx) {
  const A = meta.A;
  if (!A) return '';
  if (p === 'ax') return `z ${(A[2][3] + idx * A[2][2]).toFixed(1)} mm`;
  if (p === 'sag') return `x ${(A[0][3] + idx * A[0][0]).toFixed(1)} mm`;
  return `y ${(A[1][3] + idx * A[1][1]).toFixed(1)} mm`;
}

// ---------- title page backdrop: representative axial slice, blurred and faded into the background ----------
function titleBackdrop(pxW, pxH) {
  const pri = atlas.scans.find(s => s.key === 'pri');
  const v = atlas.voi.ax, g = geomVoi('ax', v);
  let lo = Infinity, hi = -Infinity;
  for (const r of rois) if (atlas.roiOn[r.number] && r.ks.length) { lo = Math.min(lo, r.ks[0]); hi = Math.max(hi, r.ks[r.ks.length - 1]); }
  let k = isFinite(lo) ? Math.round((lo + hi) / 2) : Math.round((v.k0 + v.k1) / 2);
  k = Math.max(v.k0, Math.min(v.k1, k));
  const ih = Math.round(pxH * 1.05), iw = Math.round(ih * g.mmW / g.mmH);
  const {cv} = renderAtlasImage(pri, 'ax', k, iw, ih, {vectorNotes: true, noLabels: true, noDose: true});
  const out = document.createElement('canvas'); out.width = pxW; out.height = pxH;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, pxW, pxH);
  ctx.filter = `blur(${Math.round(pxW / 500)}px) brightness(0.7)`;
  ctx.drawImage(cv, pxW - iw * 0.92, (pxH - ih) / 2, iw, ih);
  ctx.filter = 'none';
  let gr = ctx.createLinearGradient(0, 0, pxW, 0);
  gr.addColorStop(0, 'rgba(17,17,17,1)'); gr.addColorStop(0.33, 'rgba(17,17,17,0.97)');
  gr.addColorStop(0.6, 'rgba(17,17,17,0.45)'); gr.addColorStop(1, 'rgba(17,17,17,0.2)');
  ctx.fillStyle = gr; ctx.fillRect(0, 0, pxW, pxH);
  for (const [y0, y1] of [[0, pxH * 0.18], [pxH, pxH * 0.82]]) {
    gr = ctx.createLinearGradient(0, y0, 0, y1);
    gr.addColorStop(0, 'rgba(17,17,17,1)'); gr.addColorStop(1, 'rgba(17,17,17,0)');
    ctx.fillStyle = gr; ctx.fillRect(0, Math.min(y0, y1), pxW, Math.abs(y1 - y0));
  }
  return out;
}


// ---------- navigation helpers ----------
// page of the same slice in another section, or the nearest slice it has
function pageNear(sec, idx, pageOf) {
  const exact = pageOf[`${sec.s.key}|${sec.p}|${idx}`];
  if (exact != null) return exact;
  let best = null, bd = Infinity;
  for (const i of sec.idxs) { const d = Math.abs(i - idx); if (d < bd) { bd = d; best = i; } }
  return best == null ? null : pageOf[`${sec.s.key}|${sec.p}|${best}`];
}
// the same scan with/without dose in this plane (e.g. "CT" <-> "CT + dose")
function doseTwin(sec, sections) {
  const want = !pageHasDose(sec.s);
  const c = sections.filter(x => x.p === sec.p && x !== sec && x.s.base === sec.s.base && pageHasDose(x.s) === want);
  if (!c.length) return null;
  const sameWin = c.filter(x => x.s.ww === sec.s.ww && x.s.wl === sec.s.wl);
  const pick = (sameWin.length ? sameWin : c);
  return pick.find(x => x.s.kind === 'pri') || pick.find(x => x.s.kind !== 'win' || x.s.dose) || pick[0];
}
// ---------- PDF ----------
async function buildAtlas() {
  const A = atlas;
  const sections = atlasPlan();
  if (!sections.length) { $('aProgTxt').textContent = 'Nothing selected.'; return; }
  const {jsPDF} = window.jspdf;
  const doc = new jsPDF({unit: 'mm', format: 'a4', orientation: 'landscape', compress: true});
  const title = A.title.trim() || 'Contouring atlas';
  const incRois = rois.filter(r => A.roiOn[r.number]);
  const legendRois = incRois.filter(r => !A.legend.onlyDescribed || (A.legend.desc[r.number] || '').trim());
  const BG = [17, 17, 17], FG = [230, 230, 230], DIM = [150, 150, 150], ACC = [255, 212, 0];

  // ---- layout of legend pages (pre-measured so page numbers are known up front) ----
  const legendPages = [];
  if (A.legend.on && legendRois.length) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    let page = [], y = 30;
    for (const r of legendRois) {
      const lines = doc.splitTextToSize((A.legend.desc[r.number] || '').trim() || '-', 195);
      const h = Math.max(1, lines.length) * 4.6 + 4;
      if (y + h > 198) { legendPages.push(page); page = []; y = 30; }
      page.push({r, lines, y}); y += h;
    }
    legendPages.push(page);
  }
  // ---- page numbering ----
  let pg = 2;
  const legendFirst = legendPages.length ? pg : null; pg += legendPages.length;
  const pageOf = {};
  for (const sec of sections) {
    sec.first = pg;
    for (const i of sec.idxs) pageOf[`${sec.s.key}|${sec.p}|${i}`] = pg++;
    sec.last = pg - 1;
  }
  const total = pg - 1;
  const notePages = [];
  for (const sec of sections) for (const i of sec.idxs) if (notesOn(sec.s, sec.p, i).length) notePages.push(pageOf[`${sec.s.key}|${sec.p}|${i}`]);
  notePages.sort((a, b) => a - b);
  const secOf = (key, p) => sections.find(x => x.s.key === key && x.p === p);

  const bg = (w, h) => { doc.setFillColor(...BG); doc.rect(0, 0, w, h, 'F'); };
  // button: returns its width; link if a target page is given and it's not the current one
  const btn = (x, y, label, target, active, alignRight) => {
    doc.setFontSize(8); doc.setFont('helvetica', active ? 'bold' : 'normal');
    const w = doc.getTextWidth(label) + 5, h = 5.6, bx = alignRight ? x - w : x;
    const enabled = target != null;
    doc.setFillColor(...(active ? ACC : enabled ? [55, 55, 55] : [32, 32, 32]));
    doc.roundedRect(bx, y, w, h, 1.2, 1.2, 'F');
    doc.setTextColor(...(active ? [0, 0, 0] : enabled ? FG : [90, 90, 90]));
    doc.text(label, bx + 2.5, y + 3.9);
    if (enabled && !active) doc.link(bx, y, w, h, {pageNumber: target});
    return w;
  };

  // ---- title page (landscape; contents flow into a second column) ----
  const backdrop = await canvasJpeg(titleBackdrop(1600, Math.round(1600 * PG.H / PG.W)));
  {
    const W = PG.W, H = PG.H; bg(W, H);
    doc.addImage(backdrop, 'JPEG', 0, 0, W, H, 'title_bg', 'NONE');
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(26);
    const tl = doc.splitTextToSize(title, 250);
    doc.text(tl, 20, 30);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(12); doc.setTextColor(...DIM);
    let y = 30 + tl.length * 11;
    const meta_ = [A.creator.trim() ? 'Created by ' + A.creator.trim() : null,
                   new Date().toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'})].filter(Boolean);
    doc.text(meta_.join('   |   '), 20, y); y += 12;
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Contents', 20, y); y += 8;
    doc.setFontSize(10.5); doc.setFont('helvetica', 'normal');
    const top = y, bottom = H - 26, colW = 120, cols = [20, 20 + colW + 15];
    let col = 0;
    const need = h => { if (y + h > bottom && col === 0) { col = 1; y = top; } };
    const row = (label, page, indent) => {
      need(6.2); const x = cols[col];
      doc.setTextColor(...FG); doc.text(label, x + (indent || 0), y);
      doc.setTextColor(...ACC); doc.text('p. ' + page, x + colW, y, {align: 'right'});
      doc.link(x, y - 4, colW, 5.5, {pageNumber: page}); y += 6.2;
    };
    if (legendFirst) row('Legend', legendFirst);
    let lastScan = null;
    for (const sec of sections) {
      if (sec.s.key !== lastScan) {
        need(14); y += 2; doc.setFont('helvetica', 'bold'); doc.setTextColor(...FG); doc.text(atlasName(sec.s), cols[col], y); y += 6; doc.setFont('helvetica', 'normal');
        lastScan = sec.s.key;
      }
      row(`${PNAME[sec.p]} (${sec.idxs.length} pages, every ${spacingMm(sec.p).toFixed(1)} mm${noteSlices(sec.p).length ? ' + annotated slices' : ''})`, sec.first, 6);
    }
    doc.setFontSize(9); doc.setTextColor(...DIM);
    const nNotes = notePages.length;
    doc.text(`${incRois.length} structures, ${nNotes} annotated slice${nNotes === 1 ? '' : 's'}, ${total} pages.  Navigation: each page links to the same slice on the other scans, the other planes,`, 20, H - 16);
    doc.text('the previous/next slice and, where present, the previous/next annotated slice.', 20, H - 11.5);
    // attribution
    doc.setFontSize(8); doc.setFont('helvetica', 'normal'); doc.setTextColor(...DIM);
    const wm1 = 'Created with ', wm2 = 'TapAtlas';
    doc.setFont('helvetica', 'bold'); const w2 = doc.getTextWidth(wm2); doc.setFont('helvetica', 'normal'); const w1 = doc.getTextWidth(wm1);
    const wx = W - 14 - w1 - w2;
    doc.text(wm1, wx, 12); doc.setFont('helvetica', 'bold'); doc.setTextColor(...ACC); doc.text(wm2, wx + w1, 12);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(6.5); doc.setTextColor(...DIM);
    doc.text('The Radiotherapy Contour Atlas Generator', W - 14, 15.5, {align: 'right'});
    doc.link(wx - 1, 8.5, W - 14 - wx + 1, 8.5, {url: TAPATLAS_URL});
  }
  // ---- legend pages ----
  legendPages.forEach((items, li) => {
    doc.addPage('a4', 'landscape'); bg(PG.W, PG.H);
    doc.setTextColor(...FG); doc.setFont('helvetica', 'bold'); doc.setFontSize(16);
    doc.text('Legend' + (legendPages.length > 1 ? ` (${li + 1}/${legendPages.length})` : ''), 20, 20);
    btn(PG.W - 20, 12, 'Contents', 1, false, true);
    for (const it of items) {
      doc.setFillColor(...it.r.color); doc.rect(20, it.y - 3.2, 4, 4, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...FG);
      doc.text(doc.splitTextToSize(it.r.name, 50), 27, it.y);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(200, 200, 200);
      doc.text(it.lines, 82, it.y);
    }
  });

  // ---- image pages ----
  $('aProg').style.display = ''; $('aProg').max = total; $('aBuild').disabled = $('aBuildPpt').disabled = true;
  const t0 = performance.now();
  try {
    for (const sec of sections) {
      const {s, p, idxs} = sec, g = geomVoi(p, A.voi[p]);
      // A4 landscape throughout
      const {W: PW, H: PH, M, HEAD, FOOT} = PG, land = true;
      const sc = Math.min((PW - 2 * M) / g.mmW, (PH - HEAD - FOOT) / g.mmH);
      const iw = g.mmW * sc, ih = g.mmH * sc, ix = (PW - iw) / 2, iy = HEAD + (PH - HEAD - FOOT - ih) / 2;
      const Wpx = A.quality, Hpx = Math.max(1, Math.round(A.quality * g.mmH / g.mmW));
      const others = sections.filter(x => x.p === p && x.s.key !== s.key);
      for (let j = 0; j < idxs.length; j++) {
        const idx = idxs[j], here = pageOf[`${s.key}|${p}|${idx}`];
        doc.addPage('a4', land ? 'landscape' : 'portrait'); bg(PW, PH);
        const {cv, present} = renderAtlasImage(s, p, idx, Wpx, Hpx);
        doc.addImage(await canvasJpeg(cv), 'JPEG', ix, iy, iw, ih, 'im' + here, 'NONE');
        // header line 1
        doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.setTextColor(...FG);
        doc.text(doc.splitTextToSize(title, PW * 0.45)[0], M, 6.5);
        doc.setFont('helvetica', 'normal'); doc.setTextColor(...ACC);
        doc.text(`${atlasName(s)}  |  ${PNAME[p]} ${j + 1}/${idxs.length}  |  ${slicePosLabel(p, idx)}`, PW - M, 6.5, {align: 'right'});
        // header line 2: same slice on other scans | other planes of this scan
        let x = M;
        for (const t of [sec, ...others].sort((a, b) => A.scans.indexOf(a.s) - A.scans.indexOf(b.s)))
          x += btn(x, 9, atlasName(t.s), t === sec ? here : pageNear(t, idx, pageOf), t.s.key === s.key) + 1.5;
        const twin = doseTwin(sec, sections);
        if (twin) { x += 2; x += btn(x, 9, pageHasDose(s) ? 'Hide dose' : 'Show dose', pageNear(twin, idx, pageOf), false) + 1.5; }
        let xr = PW - M;
        for (const q of [...APLANES].reverse()) {
          const os = secOf(s.key, q); if (!os) continue;
          const target = q === p ? here : os.first + Math.floor((os.last - os.first) / 2);
          xr -= btn(xr, 9, PNAME[q], target, q === p, true) + 1.5;
        }
        // footer: structure key, then navigation
        const fy = PH - FOOT + 2;
        doc.setFontSize(7.5); doc.setFont('helvetica', 'normal');
        let kx = M;
        // dose key goes on the right, structures fill the rest of the line
        let dxr = PW - M;
        if (pageHasDose(s)) {
          const mode = atlasDoseMode(), items = doseLegendItems(mode);
          for (const it of [...items].reverse()) {
            const w = doc.getTextWidth(it.label) + 5; dxr -= w;
            const c = unhex(it.color); doc.setFillColor(...c);
            if (mode === 'wash') doc.rect(dxr, fy, 3, 3, 'F'); else doc.rect(dxr, fy + 1.1, 3.4, 0.8, 'F');
            doc.setTextColor(...FG); doc.text(it.label, dxr + 4, fy + 2.6); dxr -= 2;
          }
          const lab = mode === 'wash' ? 'Dose:' : 'Isodose:'; dxr -= doc.getTextWidth(lab) + 1;
          doc.setTextColor(...DIM); doc.text(lab, dxr, fy + 2.6); dxr -= 4;
        }
        for (const r of present) {
          const w = doc.getTextWidth(r.name) + 6;
          if (kx + w > dxr) { doc.setTextColor(...DIM); doc.text('...', kx, fy + 2.8); break; }
          doc.setFillColor(...r.color); doc.rect(kx, fy, 3, 3, 'F');
          doc.setTextColor(...FG); doc.text(r.name, kx + 4, fy + 2.6); kx += w + 2;
        }
        const ny = PH - 7.5;
        let bx = M;
        bx += btn(bx, ny, 'Contents', 1, false) + 1.5;
        if (legendFirst) bx += btn(bx, ny, 'Legend', legendFirst, false) + 1.5;
        bx += 3;
        bx += btn(bx, ny, '< Prev slice', j > 0 ? here - 1 : null, false) + 1.5;
        bx += btn(bx, ny, 'Next slice >', j < idxs.length - 1 ? here + 1 : null, false) + 1.5;
        if (notePages.length) {
          bx += 3;
          const prev = [...notePages].reverse().find(q => q < here), next = notePages.find(q => q > here);
          bx += btn(bx, ny, '< Prev note', prev ?? null, false) + 1.5;
          bx += btn(bx, ny, 'Next note >', next ?? null, false) + 1.5;
        }
        doc.setFontSize(8); doc.setTextColor(...DIM); doc.text(`p. ${here} / ${total}`, PW - M, ny + 3.9, {align: 'right'});
        $('aProg').value = here;
        if (here % 5 === 0) {
          const el = (performance.now() - t0) / 1000, rate = (here - 1) / el;
          $('aProgTxt').textContent = `page ${here} / ${total}, ~${Math.max(0, Math.round((total - here) / rate))} s left`;
          await new Promise(r => setTimeout(r));
        }
      }
    }
    $('aProgTxt').textContent = 'Writing PDF…';
    await new Promise(r => setTimeout(r));
    const fname = (title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'atlas') + '.pdf';
    doc.save(fname);
    $('aProgTxt').textContent = `Done: ${total} pages in ${((performance.now() - t0) / 1000).toFixed(0)} s, saved as ${fname}`;
    log(`Atlas built: ${total} pages, ${notePages.length} annotated, ${fname}`);
  } catch (e) {
    $('aProgTxt').textContent = 'ERROR: ' + e; log('ERROR building atlas: ' + e); console.error(e);
  } finally { $('aBuild').disabled = $('aBuildPpt').disabled = false; }
}

// ---------- PowerPoint ----------
// Same structure as the PDF. Images carry the scan + contours; notes are native PowerPoint shapes
// (dot, leader line, text box) so they stay editable, and their text is also put in the speaker notes.
const PPT_LAYOUTS = {'16x9': {W: 13.333, H: 7.5}, 'A4': {W: 11.69, H: 8.27}};
async function buildPptx() {
  const A = atlas;
  const sections = atlasPlan();
  if (!sections.length) { $('aProgTxt').textContent = 'Nothing selected.'; return; }
  const L = PPT_LAYOUTS[A.pptLayout || '16x9'];
  const pptx = new PptxGenJS();
  pptx.defineLayout({name: 'ATLAS', width: L.W, height: L.H}); pptx.layout = 'ATLAS';
  const title = A.title.trim() || 'Contouring atlas';
  pptx.title = title; if (A.creator.trim()) pptx.author = A.creator.trim();
  const incRois = rois.filter(r => A.roiOn[r.number]);
  const legendRois = incRois.filter(r => !A.legend.onlyDescribed || (A.legend.desc[r.number] || '').trim());
  const hexc = c => c.map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const BG = '111111', FG = 'E6E6E6', DIM = '969696', ACC = 'FFD400', FONT = 'Arial';
  const M = 0.15, HEAD = 0.62, FOOT = 0.55;

  // page numbering (legend: up to 10 structures per slide)
  const PER_LEG = 10, legendSlides = [];
  if (A.legend.on) for (let i = 0; i < legendRois.length; i += PER_LEG) legendSlides.push(legendRois.slice(i, i + PER_LEG));
  let pg = 2;
  const legendFirst = legendSlides.length ? pg : null; pg += legendSlides.length;
  const pageOf = {};
  for (const sec of sections) { sec.first = pg; for (const i of sec.idxs) pageOf[`${sec.s.key}|${sec.p}|${i}`] = pg++; sec.last = pg - 1; }
  const total = pg - 1;
  const notePages = [];
  for (const sec of sections) for (const i of sec.idxs) if (notesOn(sec.s, sec.p, i).length) notePages.push(pageOf[`${sec.s.key}|${sec.p}|${i}`]);
  notePages.sort((a, b) => a - b);
  const secOf = (key, p) => sections.find(x => x.s.key === key && x.p === p);
  const tw = (s, pt) => s.length * pt * 0.0078 + 0.22;      // rough Arial width (in) for button sizing
  const btn = (slide, x, y, label, target, active, alignRight) => {
    const w = tw(label, 9), bx = alignRight ? x - w : x, enabled = target != null;
    const o = {x: bx, y, w, h: 0.26, fontFace: FONT, fontSize: 9, bold: !!active, align: 'center', valign: 'middle', margin: 0,
               shape: pptx.ShapeType.roundRect, rectRadius: 0.05,
               fill: {color: active ? ACC : enabled ? '373737' : '202020'}, color: active ? '000000' : enabled ? FG : '5A5A5A'};
    if (enabled && !active) o.hyperlink = {slide: target, tooltip: label};
    slide.addText(label, o);
    return w;
  };
  const dataUrl = cv => cv.toDataURL('image/jpeg', 0.9).replace(/^data:/, '');

  $('aProg').style.display = ''; $('aProg').max = total; $('aBuild').disabled = $('aBuildPpt').disabled = true;
  const t0 = performance.now();
  try {
    // ---- title slide ----
    {
      const s = pptx.addSlide(); s.background = {color: BG};
      s.addImage({data: dataUrl(titleBackdrop(1600, Math.round(1600 * L.H / L.W))), x: 0, y: 0, w: L.W, h: L.H});
      s.addText(title, {x: 0.6, y: 0.5, w: L.W * 0.62, h: 1.1, fontFace: FONT, fontSize: 32, bold: true, color: FG, valign: 'top', margin: 0, fit: 'shrink'});
      const sub = [A.creator.trim() ? 'Created by ' + A.creator.trim() : null,
                   new Date().toLocaleDateString(undefined, {year: 'numeric', month: 'long', day: 'numeric'})].filter(Boolean).join('   |   ');
      s.addText(sub, {x: 0.6, y: 1.6, w: L.W * 0.6, h: 0.35, fontFace: FONT, fontSize: 13, color: DIM, margin: 0});
      s.addText('Contents', {x: 0.6, y: 2.15, w: 4, h: 0.35, fontFace: FONT, fontSize: 16, bold: true, color: FG, margin: 0});
      const rows = [];
      const link = (label, page, indent, bold) => rows.push({text: label, page, indent, bold});
      if (legendFirst) link('Legend', legendFirst, 0);
      let last = null;
      for (const sec of sections) {
        if (sec.s.key !== last) { rows.push({text: atlasName(sec.s), head: true}); last = sec.s.key; }
        link(`${PNAME[sec.p]} (${sec.idxs.length} slides)`, sec.first, 0.25);
      }
      let y = 2.6; const lh = 0.27, colW = 4.4; let x = 0.6;
      for (const r of rows) {
        if (y > L.H - 0.9) { y = 2.6; x += colW + 0.4; }
        if (r.head) { s.addText(r.text, {x, y, w: colW, h: lh, fontFace: FONT, fontSize: 11, bold: true, color: FG, margin: 0}); }
        else {
          s.addText(r.text, {x: x + r.indent, y, w: colW - r.indent - 0.7, h: lh, fontFace: FONT, fontSize: 11, color: FG, margin: 0, hyperlink: {slide: r.page}});
          s.addText('p. ' + r.page, {x: x + colW - 0.7, y, w: 0.7, h: lh, fontFace: FONT, fontSize: 11, color: ACC, align: 'right', margin: 0, hyperlink: {slide: r.page}});
        }
        y += lh;
      }
      s.addText(`${incRois.length} structures, ${notePages.length} annotated slides, ${total} slides. Buttons work in slide-show mode.`,
        {x: 0.6, y: L.H - 0.55, w: L.W - 1.2, h: 0.3, fontFace: FONT, fontSize: 9, color: DIM, margin: 0});
      s.addText([{text: 'Created with ', options: {color: DIM}}, {text: 'TapAtlas', options: {color: ACC, bold: true, hyperlink: {url: TAPATLAS_URL, tooltip: 'The Radiotherapy Contour Atlas Generator'}}},
                 {text: '\nThe Radiotherapy Contour Atlas Generator', options: {color: DIM, fontSize: 7}}],
        {x: L.W - 3.6, y: 0.25, w: 3.3, h: 0.45, fontFace: FONT, fontSize: 9, align: 'right', valign: 'top', margin: 0});
    }
    // ---- legend slides ----
    legendSlides.forEach((items, li) => {
      const s = pptx.addSlide(); s.background = {color: BG};
      s.addText('Legend' + (legendSlides.length > 1 ? ` (${li + 1}/${legendSlides.length})` : ''), {x: 0.6, y: 0.35, w: 6, h: 0.5, fontFace: FONT, fontSize: 22, bold: true, color: FG, margin: 0});
      btn(s, L.W - 0.6, 0.45, 'Contents', 1, false, true);
      const rowH = (L.H - 1.4) / PER_LEG;
      items.forEach((r, i) => {
        const y = 1.1 + i * rowH;
        s.addShape(pptx.ShapeType.rect, {x: 0.6, y: y + 0.06, w: 0.18, h: 0.18, fill: {color: hexc(r.color)}, line: {color: hexc(r.color)}});
        s.addText(r.name, {x: 0.9, y, w: 2.4, h: rowH, fontFace: FONT, fontSize: 12, bold: true, color: FG, valign: 'top', margin: 0});
        s.addText((A.legend.desc[r.number] || '').trim() || '-', {x: 3.4, y, w: L.W - 4.0, h: rowH, fontFace: FONT, fontSize: 11, color: 'C8C8C8', valign: 'top', margin: 0, fit: 'shrink'});
      });
    });
    // ---- image slides ----
    const mctx = document.createElement('canvas').getContext('2d');
    for (const sec of sections) {
      const {s: scan, p, idxs} = sec, g = geomVoi(p, A.voi[p]);
      const sc = Math.min((L.W - 2 * M) / g.mmW, (L.H - HEAD - FOOT) / g.mmH);
      const iw = g.mmW * sc, ih = g.mmH * sc, ix = (L.W - iw) / 2, iy = HEAD + (L.H - HEAD - FOOT - ih) / 2;
      const Wpx = A.quality, Hpx = Math.max(1, Math.round(A.quality * g.mmH / g.mmW)), in_px = iw / Wpx;
      const others = sections.filter(x => x.p === p && x.s.key !== scan.key);
      for (let j = 0; j < idxs.length; j++) {
        const idx = idxs[j], here = pageOf[`${scan.key}|${p}|${idx}`];
        const s = pptx.addSlide(); s.background = {color: BG};
        const r = renderAtlasImage(scan, p, idx, Wpx, Hpx, {vectorNotes: true});
        s.addImage({data: dataUrl(r.cv), x: ix, y: iy, w: iw, h: ih});
        // notes as editable shapes
        const ns = notesOn(scan, p, idx);
        for (const n of ns) {
          const o = noteLayout(mctx, n, p, r.g, r.sx, r.sy, Wpx, Hpx);
          const X = v => ix + v * in_px, Y = v => iy + v * in_px, m = o.mk;
          pptMarker(s, pptx, m, X, Y, in_px, o.k, ACC);
          const pt = o.fs * in_px * 72;
          s.addText(n.text, {x: X(o.bx), y: Y(o.by), w: o.bw * in_px * 1.15, h: o.bh * in_px, fontFace: FONT, fontSize: Math.max(6, Math.round(pt * 10) / 10),
            color: 'FFFFFF', fill: {color: '0A0A0A', transparency: 18}, line: {color: ACC, width: 1}, valign: 'top',
            margin: Math.max(1, o.padX * in_px * 72 * 0.8), lineSpacingMultiple: 1.15});
        }
        if (ns.length) s.addNotes(ns.map(n => n.text).join('\n\n'));
        // header
        s.addText(title, {x: M, y: 0.06, w: L.W * 0.45, h: 0.24, fontFace: FONT, fontSize: 11, bold: true, color: FG, margin: 0});
        s.addText(`${atlasName(scan)}  |  ${PNAME[p]} ${j + 1}/${idxs.length}  |  ${slicePosLabel(p, idx)}`,
          {x: L.W * 0.45, y: 0.06, w: L.W * 0.55 - M, h: 0.24, fontFace: FONT, fontSize: 11, color: ACC, align: 'right', margin: 0});
        let x = M;
        for (const t of [sec, ...others].sort((a, b) => A.scans.indexOf(a.s) - A.scans.indexOf(b.s)))
          x += btn(s, x, 0.33, atlasName(t.s), t === sec ? here : pageNear(t, idx, pageOf), t.s.key === scan.key) + 0.06;
        const twin = doseTwin(sec, sections);
        if (twin) { x += 0.08; x += btn(s, x, 0.33, pageHasDose(scan) ? 'Hide dose' : 'Show dose', pageNear(twin, idx, pageOf), false) + 0.06; }
        let xr = L.W - M;
        for (const q of [...APLANES].reverse()) {
          const os = secOf(scan.key, q); if (!os) continue;
          xr -= btn(s, xr, 0.33, PNAME[q], q === p ? here : os.first + Math.floor((os.last - os.first) / 2), q === p, true) + 0.06;
        }
        // footer: structure key (+ dose key on the right) + navigation
        const dItems = pageHasDose(scan) ? doseLegendItems(atlasDoseMode()) : [];
        const dW = dItems.length ? Math.min(L.W * 0.45, 0.75 + dItems.reduce((a, it) => a + tw(it.label, 8) + 0.12, 0)) : 0;
        if (r.present.length) {
          const avail = L.W - 2 * M - dW - 0.3, shown = [];
          let used = 0;
          for (const ro of r.present) { const w = (ro.name.length + 6) * 8 * 0.0072; if (used + w > avail) break; shown.push(ro); used += w; }
          const runs = shown.flatMap(ro => [{text: '\u25A0 ', options: {color: hexc(ro.color)}}, {text: ro.name + '    ', options: {color: FG}}]);
          if (shown.length < r.present.length) runs.push({text: '\u2026', options: {color: DIM}});
          s.addText(runs, {x: M, y: L.H - FOOT + 0.02, w: L.W - 2 * M - dW, h: 0.2, fontFace: FONT, fontSize: 8, margin: 0});
        }
        if (dItems.length) {
          const wash = atlasDoseMode() === 'wash';
          s.addText([{text: (wash ? 'Dose: ' : 'Isodose: '), options: {color: DIM}},
                     ...dItems.flatMap(it => [{text: wash ? '\u25A0 ' : '\u2014 ', options: {color: it.color.slice(1).toUpperCase(), bold: true}}, {text: it.label + '  ', options: {color: FG}}])],
            {x: L.W - M - dW, y: L.H - FOOT + 0.02, w: dW, h: 0.2, fontFace: FONT, fontSize: 8, margin: 0, align: 'right'});
        }
        const ny = L.H - 0.3;
        let bx = M;
        bx += btn(s, bx, ny, 'Contents', 1, false) + 0.06;
        if (legendFirst) bx += btn(s, bx, ny, 'Legend', legendFirst, false) + 0.06;
        bx += 0.12;
        bx += btn(s, bx, ny, '< Prev slice', j > 0 ? here - 1 : null, false) + 0.06;
        bx += btn(s, bx, ny, 'Next slice >', j < idxs.length - 1 ? here + 1 : null, false) + 0.06;
        if (notePages.length) {
          bx += 0.12;
          const prev = [...notePages].reverse().find(q => q < here), next = notePages.find(q => q > here);
          bx += btn(s, bx, ny, '< Prev note', prev ?? null, false) + 0.06;
          bx += btn(s, bx, ny, 'Next note >', next ?? null, false) + 0.06;
        }
        s.addText(`${here} / ${total}`, {x: L.W - M - 1.2, y: ny, w: 1.2, h: 0.26, fontFace: FONT, fontSize: 9, color: DIM, align: 'right', valign: 'middle', margin: 0});
        $('aProg').value = here;
        if (here % 5 === 0) {
          const el = (performance.now() - t0) / 1000, rate = (here - 1) / el;
          $('aProgTxt').textContent = `slide ${here} / ${total}, ~${Math.max(0, Math.round((total - here) / rate))} s left`;
          await new Promise(r => setTimeout(r));
        }
      }
    }
    $('aProgTxt').textContent = 'Writing PowerPoint…';
    await new Promise(r => setTimeout(r));
    const fname = (title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'atlas') + '.pptx';
    await pptx.writeFile({fileName: fname, compression: true});
    $('aProgTxt').textContent = `Done: ${total} slides in ${((performance.now() - t0) / 1000).toFixed(0)} s, saved as ${fname}`;
    log(`Atlas PowerPoint built: ${total} slides, ${fname}`);
  } catch (e) {
    $('aProgTxt').textContent = 'ERROR: ' + e; log('ERROR building PowerPoint: ' + e); console.error(e);
  } finally { $('aBuild').disabled = $('aBuildPpt').disabled = false; }
}

// a note marker as native PowerPoint shapes (m: noteMarkerGeom in output px; X/Y: px -> inches)
function pptMarker(s, pptx, m, X, Y, in_px, k, ACC) {
  const lineShape = (x1, y1, x2, y2, opt) => {
    const dx = x2 - x1, dy = y2 - y1;
    if (Math.hypot(dx, dy) < 1) return;
    const flipV = (dx >= 0) !== (dy >= 0);
    // PowerPoint draws the line top-left -> bottom-right (bottom-left -> top-right when flipped)
    const endX = Math.max(x1, x2), endIs2 = dx !== 0 ? x2 === endX : (flipV ? y2 < y1 : y2 > y1);
    const o = {x: X(Math.min(x1, x2)), y: Y(Math.min(y1, y2)), w: Math.abs(dx) * in_px, h: Math.abs(dy) * in_px, flipV, line: {color: ACC, width: 1.25}};
    if (opt && opt.arrowAt1) o.line[endIs2 ? 'beginArrowType' : 'endArrowType'] = 'triangle';
    s.addShape(pptx.ShapeType.line, o);
  };
  if (m.line) lineShape(m.sx, m.sy, m.bx, m.by, {arrowAt1: m.type === 'arrow'});
  if (m.type === 'ellipse') {
    s.addShape(pptx.ShapeType.ellipse, {x: X(m.ax - m.rx), y: Y(m.ay - m.ry), w: 2 * m.rx * in_px, h: 2 * m.ry * in_px,
      fill: {color: 'FFFFFF', transparency: 100}, line: {color: ACC, width: 1.75}});
  } else if (m.type === 'free' && m.pts && m.pts.length > 1) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of m.pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    const pts = m.pts.map(([x, y], j) => j ? {x: (x - x0) * in_px, y: (y - y0) * in_px} : {x: (x - x0) * in_px, y: (y - y0) * in_px, moveTo: true});
    if (m.closed) pts.push({close: true});
    s.addShape(pptx.ShapeType.custGeom, {x: X(x0), y: Y(y0), w: Math.max(0.01, (x1 - x0) * in_px), h: Math.max(0.01, (y1 - y0) * in_px), points: pts,
      fill: {color: 'FFFFFF', transparency: 100}, line: {color: ACC, width: 1.75}});
  } else if (m.type === 'dot' || (m.type === 'arrow' && !m.line)) {
    const rr = 4 * k * in_px;
    s.addShape(pptx.ShapeType.ellipse, {x: X(m.ax) - rr, y: Y(m.ay) - rr, w: 2 * rr, h: 2 * rr, fill: {color: ACC}, line: {color: '000000', width: 0.75}});
  }
}
