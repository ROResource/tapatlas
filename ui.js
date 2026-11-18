// ===================== TapAtlas interface wiring =====================
// Layout-only behaviour: dialogs, pickers, side panel sections, full screen, scan list, step indicator.
const TAPATLAS_URL = 'https://roresource.github.io/tapatlas/';

// file pickers: a styled button opens the hidden <input type=file>; the chosen file count/name is shown
function wirePickers(root) {
  root.querySelectorAll('.pick button[data-for]').forEach(b => {
    const inp = $(b.dataset.for); if (!inp || b.dataset.wired) return;
    b.dataset.wired = 1;
    b.onclick = () => inp.click();
    inp.addEventListener('change', () => {
      const fn = inp.closest('.frow') && inp.closest('.frow').querySelector('.fn');
      const n = inp.files.length;
      if (fn) fn.textContent = !n ? '' : n === 1 ? inp.files[0].name : `${n} files`;
    });
  });
}
wirePickers(document);

// ---------- dialogs ----------
const openModal = id => $(id).classList.add('open');
const closeModal = id => $(id).classList.remove('open');
$('filesBtn').onclick = () => openModal('filesDlg');
$('manageScans').onclick = () => openModal('filesDlg');
$('filesClose').onclick = $('filesDone').onclick = () => { closeModal('filesDlg'); if (meta) draw(); };
$('filesDlg').addEventListener('mousedown', e => { if (e.target.id === 'filesDlg') closeModal('filesDlg'); });
$('logBtn').onclick = () => $('logDrawer').classList.toggle('open');
$('logClose').onclick = () => $('logDrawer').classList.remove('open');
$('newPat').onclick = () => {
  if (confirm('Start again with another patient? Notes and settings for this patient will be lost unless you have saved the session.')) { leaving = true; location.reload(); }
};
// warn before closing or reloading the page with a patient loaded (nothing is stored in the browser)
let leaving = false;
window.addEventListener('beforeunload', e => { if (meta && !leaving) { e.preventDefault(); e.returnValue = ''; } });

// ---------- side panel sections ----------
document.querySelectorAll('.acc-h').forEach(h => h.onclick = () => h.parentElement.classList.toggle('closed'));
$('sideBtn').onclick = () => { $('side').classList.toggle('hidden'); };

// ---------- crop menu ----------
$('cropBtn').onclick = e => { e.stopPropagation(); $('cropPop').classList.toggle('open'); };
document.addEventListener('mousedown', e => { if (!$('cropPop').contains(e.target)) $('cropPop').classList.remove('open'); });
['cropAuto', 'cropRois', 'cropReset', 'cropDraw'].forEach(id => $(id).addEventListener('click', () => $('cropPop').classList.remove('open')));

// ---------- full screen ----------
function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('viewer').requestFullscreen().catch(() => toast('Full screen is not available in this browser window.', 'error'));
}
$('fsBtn').onclick = toggleFs;
document.addEventListener('keydown', e => {
  if (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'radio' && e.target.type !== 'checkbox') return;
  if (e.key.toLowerCase() === 'f' && meta && !e.ctrlKey && !e.metaKey) toggleFs();
});
// redraw whenever the image area changes size (side panel, full screen, window)
new ResizeObserver(() => { if (meta) draw(); }).observe($('viewport'));

// ---------- loaded state ----------
function setStep(n) {
  [1, 2, 3].forEach(i => { const li = $('step' + i); li.classList.toggle('on', i === n); li.classList.toggle('done', i < n); });
}
function uiLoaded() {
  $('app').classList.remove('empty');
  setStep(2);
  $('newPat').style.display = ''; $('saveSess').style.display = ''; $('openSess').style.display = '';
  const pid = meta.patient ? meta.patient : '';
  $('patChip').style.display = pid ? '' : 'none';
  $('patChip').textContent = pid;
  $('patChip').title = anonOn ? 'Anonymised patient ID' : 'Patient ID';
  renderScanList(); updateCounts();
  requestAnimationFrame(() => draw());
}

// ---------- scan list (side panel) ----------
const _buildImgSel = buildImgSel;
buildImgSel = function () { _buildImgSel(); renderScanList(); };
function renderScanList() {
  const el = $('scanList'); if (!el || !meta) return;
  const ids = ['pri', ...loadedIds()];
  el.innerHTML = ids.map((id, i) => {
    const pri = id === 'pri', s = secs[id];
    const what = pri ? `Primary ${meta.modality} · ${meta.n} slices` : ($('lab_' + id).textContent || 'Scan');
    const st = pri ? '' : s.status === 'UNREGISTERED' ? ' · <span class="bad">not registered to the primary</span>' : s.deformable ? ' · <span class="mid">registered (rigid part of deformable REG)</span>' : ' · <span class="ok">registered</span>';
    return `<div class="scan ${id === curWhich() ? 'cur' : ''}" data-id="${id}">
      <span class="n" title="Show this scan (key ${i + 1})">${i + 1}</span>
      <input type="text" class="snm" value="${esc(scanName(id))}" title="Name used in the atlas">
      ${pri ? '' : `<button class="ghost icon srm" title="Remove this scan">×</button>`}
      <div class="meta">${esc(what)}${st}</div></div>`;
  }).join('');
  el.querySelectorAll('.scan').forEach(row => {
    const id = row.dataset.id;
    row.querySelector('.n').onclick = () => selectImage(id);
    row.querySelector('.snm').oninput = e => {
      const v = e.target.value;
      if (id === 'pri') { priName = v; $('name_pri').value = v; } else { secs[id].label = v; $('name_' + id).value = v; }
      _buildImgSel(); draw(); renderNotesPanel();
    };
    const rm = row.querySelector('.srm');
    if (rm) rm.onclick = () => { if (confirm(`Remove ${scanName(id)}?`)) removeSecondary(id); };
  });
  $('cntScans').textContent = ids.length;
}
function updateCounts() {
  if (!meta) return;
  $('cntRois').textContent = rois.length ? `${rois.filter(r => r.visible).length} / ${rois.length} shown` : '';
  $('cntDose').textContent = typeof dose !== 'undefined' && dose && dose.info ? (dose.mode === 'off' ? 'hidden' : dose.mode === 'wash' ? 'colourwash' : 'isolines') : '';
}
const _draw = draw;
draw = function (o) { _draw(o); updateCounts(); };

// ---------- atlas dialog: step 3 indicator ----------
$('atlasBtn').onclick = () => { setStep(3); atlasOpen(); };
const _atlasClose = atlasClose;
atlasClose = function () { _atlasClose(); setStep(2); };

// back to the start screen after a failed load
function uiReset() {
  $('app').classList.add('empty'); setStep(1);
  ['newPat', 'saveSess', 'openSess', 'patChip'].forEach(id => $(id).style.display = 'none');
  if ($('atlasDlg')) $('atlasDlg').style.display = 'none';
  renderChecks();
}

// ---------- data checks panel ----------
function renderChecks() {
  const el = $('checksList'); if (!el) return;
  const order = {bad: 0, warn: 1, info: 2};
  const all = Object.values(checks).flat().sort((a, b) => order[a.level] - order[b.level]);
  const n = all.filter(c => c.level !== 'info').length;
  $('cntChecks').textContent = n ? String(n) : '';
  $('cntChecks').className = 'cnt ' + (all.some(c => c.level === 'bad') ? 'bad' : n ? 'mid' : '');
  el.innerHTML = all.length ? all.map(c => `<div class="chk ${c.level}">${esc(c.text)}</div>`).join('')
                            : '<small class="ok">No problems found with the loaded data.</small>';
}
renderChecks();

// ---------- save / open a session (notes and settings only, never image data) ----------
// The file can be reopened after loading the same patient again, in this or another browser.
const SESSION_VERSION = 1;
function sessionState() {
  return {
    app: 'TapAtlas', kind: 'session', version: SESSION_VERSION, saved: new Date().toISOString(),
    fingerprint: {n: meta.n, rows: meta.rows, cols: meta.cols, ps: meta.ps, A: meta.A, modality: meta.modality},
    priName, priWin: {ww: priWin.ww, wl: priWin.wl, sel: priWin.sel}, lineWidth,
    secs: Object.fromEntries(loadedIds().map(id => [id, {label: secs[id].label, ww: secs[id].ww, wl: secs[id].wl, sel: secs[id].sel}])),
    rois: rois.map(r => ({number: r.number, origName: r.origName, name: r.name, color: r.color, visible: r.visible, lw: r.lw})),
    crop, noteSeq, smoothOutlines,
    notes: notes.filter(n => n !== pending).map(n => ({id: n.id, scan: n.scan, home: n.home, pt: n.pt, text: n.text, views: n.views})),
    dose: doseReady() ? {ref: dose.ref, units: dose.units, mode: dose.mode, alpha: dose.alpha, wash: dose.wash, iso: dose.iso} : null,
    atlas: atlas ? JSON.parse(JSON.stringify(atlas)) : null,
  };
}
function saveSession() {
  if (!meta) return;
  try {
    const blob = new Blob([JSON.stringify(sessionState(), null, 1)], {type: 'application/json'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    const t = ((atlas && atlas.title) || scanName('pri') || 'TapAtlas').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'TapAtlas';
    a.download = `${t}_session.json`; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    toast('Session saved (notes, names, colours, windows, dose display and atlas settings; no images). Open it after loading the same patient to carry on.', 'ok', 8000);
  } catch (e) { reportError('The session could not be saved', e); }
}
async function openSession(file) {
  let S;
  try { S = JSON.parse(await file.text()); } catch (e) { toast('That file is not a TapAtlas session file.', 'error'); return; }
  if (!S || S.app !== 'TapAtlas' || S.kind !== 'session') { toast('That file is not a TapAtlas session file.', 'error'); return; }
  if (!meta) { toast('Load the patient first, then open the session file.', 'error'); return; }
  if (S.version > SESSION_VERSION) { toast('This session was saved by a newer version of TapAtlas. Reload the page to update, then try again.', 'error'); return; }
  try {
    const f = S.fingerprint || {};
    const same = f.n === meta.n && f.rows === meta.rows && f.cols === meta.cols && Array.isArray(f.A) && Array.isArray(meta.A) &&
                 f.A.every((r, i) => r.every((v, j) => Math.abs(v - meta.A[i][j]) < 0.05));
    if (!same && !confirm('This session was saved for a different CT (its size or position differs), so notes and boxes would land in the wrong place. Apply it anyway?')) return;
    let nr = 0;
    for (const sr of S.rois || []) {
      const r = rois.find(x => x.number === sr.number && x.origName === sr.origName);
      if (r) { Object.assign(r, {name: sr.name, color: sr.color, visible: sr.visible, lw: sr.lw}); nr++; }
    }
    if (S.lineWidth) lineWidth = S.lineWidth;
    if (S.priName) { priName = S.priName; $('name_pri').value = priName; }
    if (S.priWin) Object.assign(priWin, S.priWin);
    const missing = [];
    for (const [id, v] of Object.entries(S.secs || {})) {
      if (secs[id] && secs[id].loaded) { Object.assign(secs[id], v); $('name_' + id).value = v.label || ''; }
      else missing.push(v.label || id);
    }
    // notes: replace all (and their on-screen boxes)
    for (const el of noteEls.values()) el.remove();
    noteEls.clear(); pending = null; activeNote = null; noteMode = null; closeMkMenu();
    notes = (S.notes || []).filter(n => n && n.pt && n.views && n.home).map(n => ({...n, text: String(n.text || '')}));
    noteSeq = Math.max(S.noteSeq || 1, ...notes.map(n => n.id + 1), 1);
    if (typeof S.smoothOutlines === 'boolean') { smoothOutlines = S.smoothOutlines; $('smooth').checked = smoothOutlines; }
    if (S.crop) setCrop(S.crop, 'From session');
    if (S.dose && doseReady()) { Object.assign(dose, S.dose); doseInvalidate(); }
    if (S.atlas) { atlas = S.atlas; projCache = {key: '', cv: {}}; }
    buildRoiPanel(); buildImgSel(); renderDosePanel(); syncSlider(); draw(); renderNotesPanel();
    toast(`Session opened: ${notes.length} note${notes.length === 1 ? '' : 's'}, ${nr} structure setting${nr === 1 ? '' : 's'}` +
          (missing.length ? `. Not loaded now: ${missing.join(', ')}; their notes come back if the scan is loaded in the same position.` : '.'), missing.length ? 'warn' : 'ok', 9000);
    log('Session opened from ' + file.name);
  } catch (e) { reportError('The session could not be opened', e); }
}
$('saveSess').onclick = saveSession;
$('openSess').onclick = () => $('sessFile').click();
$('sessFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openSession(f); };
