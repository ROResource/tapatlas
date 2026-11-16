// ===================== ROCAG interface wiring =====================
// Layout-only behaviour: dialogs, pickers, side panel sections, full screen, scan list, step indicator.
const ROCAG_URL = 'https://roresource.github.io/rocag/';

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
$('newPat').onclick = () => { if (confirm('Start again with another patient? Unsaved notes and settings for this patient will be lost.')) location.reload(); };

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
  $('newPat').style.display = '';
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
    const st = pri ? '' : s.status === 'UNREGISTERED' ? ' · <span class="bad">not registered to the primary</span>' : ' · <span class="ok">registered</span>';
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
