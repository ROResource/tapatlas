// ===================== Import + sort a whole patient folder =====================
// 1) read only the header of every file (first 64 KB; full file for RTSTRUCT/REG), 2) group into
// image series / structure sets / registrations, 3) let the user pick primary, extra scans and the
// structure set, 4) load through the normal primary/secondary path (all REGs are added so chains resolve).
let patScan = null;

$('patBtn').onclick = () => $('patDir').click();
$('patDir').onchange = async e => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  let dlg = $('patDlg');
  if (!dlg) { dlg = document.createElement('div'); dlg.id = 'patDlg'; document.body.appendChild(dlg); }
  busy('Sorting patient folder', 0, `${files.length} files`); await paint();
  try {
    patScan = await scanFolder(files); busyDone(true);
    if (!patScan.list.length) { toast(`No image series found among the ${files.length} files in that folder.`, 'error'); return; }
    dlg.style.display = 'block'; patRender();
  }
  catch (err) { busyDone(true); reportError('The folder could not be read', err); }
};

async function scanFolder(files) {
  const hdr = py.globals.get('header');
  py.FS.mkdirTree('/data');
  const series = {}, structs = [], regs = [], doses = [], plans = [], other = {};
  let skipped = 0;
  const t0 = performance.now();
  const pids = new Map();          // patient ID -> number of files (to catch mixed-patient folders)
  for (let i = 0; i < files.length; i++) {
    const f = files[i], p = `/data/h_${i}`;
    let h;
    try {
      const trunc = f.size > 65536;
      py.FS.writeFile(p, new Uint8Array(await f.slice(0, 65536).arrayBuffer()));
      h = JSON.parse(hdr(p, trunc));
      if (!h.ok && h.need_full) {
        py.FS.writeFile(p, new Uint8Array(await f.arrayBuffer()));
        h = JSON.parse(hdr(p, false));
      }
    } catch (e) { h = {ok: false}; log(`Could not read ${f.webkitRelativePath || f.name}: ${e}`); }
    if (h.ok && h.pid) pids.set(h.pid, (pids.get(h.pid) || 0) + 1);
    if (!h.ok) { skipped++; }
    else if (h.mod === 'RTSTRUCT') structs.push({...h, file: f});
    else if (h.mod === 'REG') regs.push({...h, file: f});
    else if (h.mod === 'RTDOSE') doses.push({...h, file: f});
    else if (h.mod === 'RTPLAN') plans.push({...h, file: f});
    else if (['RTPLAN', 'RTDOSE', 'RTRECORD', 'SR', 'PR', 'KO', 'RTIMAGE'].includes(h.mod) || !h.plane) other[h.mod || '?'] = (other[h.mod || '?'] || 0) + 1;
    else {
      const s = series[h.series] || (series[h.series] = {...h, files: [], key: h.series});
      s.files.push(f);
    }
    if (i % 40 === 39) { busy(null, (i + 1) / files.length, `Checking ${i + 1} of ${files.length} files`); await paint(); }
  }
  const list = Object.values(series).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  // defaults: primary = CT referenced by the newest structure set, else the largest CT, else largest series
  structs.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  let pri = null;
  for (const st of structs) { pri = list.find(s => st.refSeries.includes(s.series) && s.mod === 'CT'); if (pri) break; }
  if (!pri) pri = [...list].filter(s => s.mod === 'CT').sort((a, b) => b.files.length - a.files.length)[0];
  if (!pri) pri = [...list].sort((a, b) => b.files.length - a.files.length)[0];
  const sel = {pri: pri && pri.key, extra: new Set(), rs: null};
  // extras: everything else that looks like a real volume (not scouts), MR first, newest first, max 4
  const cand = list.filter(s => s.key !== sel.pri && s.files.length >= 10)
    .sort((a, b) => (a.mod === 'MR' ? 0 : 1) - (b.mod === 'MR' ? 0 : 1) || (b.date + b.time).localeCompare(a.date + a.time));
  cand.slice(0, 4).forEach(s => sel.extra.add(s.key));
  // patient letters (A, B, ...) when the folder holds more than one patient; IDs themselves are not shown
  const pidLetter = {};
  [...pids.entries()].sort((a, b) => b[1] - a[1]).forEach(([pid], i) => pidLetter[pid] = String.fromCharCode(65 + Math.min(i, 25)));
  const out = {list, structs, regs, doses, plans, other, skipped, nFiles: files.length, sel, pidLetter, nPatients: pids.size};
  out.doseOpts = patDoseOptions(out);
  patDefaultRs(out);
  return out;
}
// dose choices: each plan-sum dose on its own, or all per-beam/other doses summed (grouped by frame of reference)
function patDoseOptions(ps) {
  const opts = [];
  const planOf = d => ps.plans.find(p => p.sop === d.refPlan) || (ps.plans.length === 1 ? ps.plans[0] : null);
  const label = (d, n) => { const pl = planOf(d); return `${pl && pl.label ? pl.label + ': ' : ''}${n}${pl && pl.dose ? ` (Rx ${(+pl.dose).toFixed(2)} Gy${pl.fx ? ' / ' + pl.fx + ' fx' : ''})` : ''}`; };
  for (const d of ps.doses.filter(d => /PLAN/i.test(d.sum)))
    opts.push({label: label(d, 'plan dose'), files: [d.file, ...(planOf(d) ? [planOf(d).file] : [])], FoR: d.FoR, pid: d.pid});
  const rest = ps.doses.filter(d => !/PLAN/i.test(d.sum)), byFoR = {};
  rest.forEach(d => (byFoR[d.FoR] = byFoR[d.FoR] || []).push(d));
  for (const [f, ds] of Object.entries(byFoR))
    opts.push({label: label(ds[0], ds.length > 1 ? `sum of ${ds.length} ${(ds[0].sum || 'dose').toLowerCase()} doses` : `${(ds[0].sum || '').toLowerCase()} dose`),
               files: [...ds.map(d => d.file), ...(planOf(ds[0]) ? [planOf(ds[0]).file] : [])], FoR: f, pid: ds[0].pid});
  return opts;
}
function patDefaultDose(ps) {
  const pri = ps.list.find(s => s.key === ps.sel.pri);
  const i = ps.doseOpts.findIndex(o => pri && o.FoR === pri.FoR);
  ps.sel.dose = i >= 0 ? i : (ps.doseOpts.length ? 0 : null);
}
function patDefaultRs(ps) {
  patDefaultDose(ps);
  const pri = ps.list.find(s => s.key === ps.sel.pri);
  const ok = ps.structs.filter(st => pri && (st.refSeries.includes(pri.series) || st.refFoR.includes(pri.FoR)));
  ps.sel.rs = ok.length ? ps.structs.indexOf(ok[0]) : null;
}
// how a series links to the primary: same frame of reference, via REG file(s), or not at all
function patLink(ps, s) {
  const pri = ps.list.find(x => x.key === ps.sel.pri);
  if (!pri || s.key === pri.key) return {cls: 'ok', txt: ''};
  if (s.FoR && s.FoR === pri.FoR) return {cls: 'ok', txt: 'same frame of reference'};
  // BFS over frames of reference: each REG connects all the FoRs it lists
  const seen = new Set([pri.FoR]), q = [pri.FoR];
  while (q.length) {
    const f = q.shift();
    for (const r of ps.regs) if (r.fors.includes(f)) for (const g of r.fors) if (!seen.has(g)) { seen.add(g); q.push(g); }
  }
  if (seen.has(s.FoR)) {
    const direct = ps.regs.some(r => r.fors.includes(pri.FoR) && r.fors.includes(s.FoR));
    const def = ps.regs.some(r => r.deformable && r.fors.includes(s.FoR));
    return {cls: def ? 'mid' : 'ok', txt: (direct ? 'registered (REG)' : 'registered via another scan') + (def ? ', deformable: rigid part only' : '')};
  }
  return {cls: 'bad', txt: 'no registration found'};
}
const fmtDate = d => d && d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : (d || '');

function patRender() {
  const ps = patScan, dlg = $('patDlg'), showDates = !$('anonChk').checked;
  const priS = ps.list.find(s => s.key === ps.sel.pri);
  const otherTxt = Object.entries(ps.other).map(([k, v]) => `${v} ${k}`).join(', ');
  const multi = ps.nPatients > 1, letter = x => multi && x.pid ? ` <b class="bad">[${ps.pidLetter[x.pid]}]</b>` : '';
  dlg.innerHTML = `<div class="panel">
  <button class="ghost x" id="pX" aria-label="Close">×</button>
  <h3>Patient folder</h3>
  <p class="sub">Check what was found, choose the primary CT, any extra scans, the structure set and the dose, then load.</p>
  <h4>Summary</h4>
  ${ps.nFiles} files: ${ps.list.length} image series, ${ps.structs.length} structure set${ps.structs.length === 1 ? '' : 's'}, ${ps.regs.length} registration${ps.regs.length === 1 ? '' : 's'}${otherTxt ? `, ${otherTxt} (not used yet)` : ''}${ps.skipped ? `, ${ps.skipped} non-DICOM/unreadable skipped` : ''}.
  ${$('anonChk').checked ? '<br><span class="ok">Anonymise on import is on</span>: dates and patient details are hidden here and removed as files are loaded.' : ''}
  ${multi ? `<div class="pwarn">This folder holds data for <b>${ps.nPatients} different patients</b> (different patient IDs, marked [A], [B] … below). Choose items for one patient only.</div>` : ''}
  <h4>Image series</h4>
  <table><tr><th>Primary</th><th>Extra scan</th><th>Modality</th><th>Description</th>${showDates ? '<th>Date</th>' : ''}<th>Images</th><th>Plane</th><th>Pixel / slice</th><th>Link to primary</th></tr>
  ${ps.list.map((s, i) => {
    const l = patLink(ps, s), isPri = s.key === ps.sel.pri;
    return `<tr class="${s.files.length < 10 ? 'dim' : ''}">
      <td><input type="radio" name="pPri" data-i="${i}" ${isPri ? 'checked' : ''}></td>
      <td><input type="checkbox" class="pEx" data-i="${i}" ${ps.sel.extra.has(s.key) && !isPri ? 'checked' : ''} ${isPri ? 'disabled' : ''}></td>
      <td>${esc(s.mod)}</td><td>${esc(s.desc || '(no description)')}${letter(s)}</td>${showDates ? `<td>${fmtDate(s.date)}</td>` : ''}
      <td>${s.files.length}</td><td>${esc(s.plane)}</td><td>${s.ps ? s.ps.toFixed(2) : '?'} / ${s.thk ? s.thk.toFixed(1) : '?'} mm</td>
      <td class="${l.cls}">${isPri ? '<b>primary</b>' : l.txt}</td></tr>`;
  }).join('')}</table>
  <small>Up to 4 extra scans. Series with fewer than 10 images (scouts, localisers) are greyed out.</small>
  <h4>Structure set</h4>
  <select id="pRs"><option value="">None</option>${ps.structs.map((st, i) => {
    const pri = ps.list.find(s => s.key === ps.sel.pri), fits = pri && (st.refSeries.includes(pri.series) || st.refFoR.includes(pri.FoR));
    return `<option value="${i}" ${ps.sel.rs === i ? 'selected' : ''}>${multi && st.pid ? `[${ps.pidLetter[st.pid]}] ` : ''}${esc(st.label || '(no label)')}: ${st.nROI} structures${showDates && st.date ? ', ' + fmtDate(st.date) : ''}${fits ? '' : ' (not drawn on this primary)'}</option>`;
  }).join('')}</select>
  <h4>Dose</h4>
  ${ps.doseOpts.length ? `<select id="pDose"><option value="">None</option>${ps.doseOpts.map((o, i) => `<option value="${i}" ${ps.sel.dose === i ? 'selected' : ''}>${multi && o.pid ? `[${ps.pidLetter[o.pid]}] ` : ''}${esc(o.label)}${priS && o.FoR !== priS.FoR ? ' (other frame of reference)' : ''}</option>`).join('')}</select>
    <small style="margin-left:8px">${ps.doses.length} RTDOSE file${ps.doses.length === 1 ? '' : 's'}, ${ps.plans.length} RTPLAN${ps.plans.length === 1 ? '' : 's'} (prescription is read from the plan).</small>` : 'No RTDOSE files found.'}
  <h4>Registrations</h4>
  ${ps.regs.length ? `All ${ps.regs.length} REG file${ps.regs.length > 1 ? 's are' : ' is'} loaded; scans registered to each other are chained back to the primary automatically.` : 'None found: only scans sharing the primary\'s frame of reference will line up.'}
  <div class="pfoot"><button id="pLoad" class="primary">Load selected</button> <button id="pClose">Cancel</button> <span id="pMsg" class="mid"></span></div></div>`;
  dlg.querySelectorAll('input[name=pPri]').forEach(r => r.onchange = e => {
    const s = ps.list[+e.target.dataset.i]; ps.sel.pri = s.key; ps.sel.extra.delete(s.key); patDefaultRs(ps); patRender();
  });
  dlg.querySelectorAll('.pEx').forEach(c => c.onchange = e => {
    const s = ps.list[+e.target.dataset.i];
    if (e.target.checked) {
      if (ps.sel.extra.size >= 4) { e.target.checked = false; $('pMsg').textContent = 'Maximum 4 extra scans.'; return; }
      ps.sel.extra.add(s.key);
    } else ps.sel.extra.delete(s.key);
  });
  $('pRs').onchange = e => ps.sel.rs = e.target.value === '' ? null : +e.target.value;
  if ($('pDose')) $('pDose').onchange = e => ps.sel.dose = e.target.value === '' ? null : +e.target.value;
  $('pClose').onclick = $('pX').onclick = () => dlg.style.display = 'none';
  $('pLoad').onclick = patLoad;
}

async function patLoad() {
  const ps = patScan, dlg = $('patDlg');
  const pri = ps.list.find(s => s.key === ps.sel.pri);
  if (!pri) { $('pMsg').textContent = 'Choose a primary.'; return; }
  const extras = ps.list.filter(s => ps.sel.extra.has(s.key) && s.key !== pri.key);
  const rsSel = ps.sel.rs != null ? ps.structs[ps.sel.rs] : null;
  const doseSel = ps.sel.dose != null ? ps.doseOpts[ps.sel.dose] : null;
  // different patients selected together?
  const chosen = [pri, ...extras, rsSel, doseSel].filter(x => x && x.pid);
  if (new Set(chosen.map(x => x.pid)).size > 1 &&
      !confirm('The selected items belong to different patients (their patient IDs differ). Load them together anyway?')) return;
  dlg.style.display = 'none';
  busyBatch = true;
  const failed = [];
  try {
    if (!(await loadPrimaryFrom(pri.files, rsSel ? rsSel.file : null))) return;
    $('name_pri').value = priName = pri.desc ? `${pri.mod} ${pri.desc}`.slice(0, 40) : pri.mod;
    // every REG goes in, so chains through other scans resolve; a bad REG is skipped, not fatal
    let nReg = 0;
    for (let i = 0; i < ps.regs.length; i++) {
      try {
        const p = await writeOne(ps.regs[i].file, 'xreg');
        py.globals.get('add_reg')('x' + (i + 1), p); nReg++;
      } catch (e) { log(`REG ${ps.regs[i].file.name} skipped: ${e}`); failed.push(`registration file ${ps.regs[i].file.name}: ${errText(e)}`); }
    }
    if (nReg) log(`Added ${nReg} registration file(s) from the folder.`);
    let nOk = 0;
    for (let i = 0; i < extras.length; i++) {
      if (await loadSecondaryFrom(SLOT_IDS[i], extras[i].files, null)) nOk++;
      else failed.push(`scan ${extras[i].mod} ${extras[i].desc || ''}`.trim());
    }
    let dTxt = '';
    if (doseSel) { if (await loadDoseFrom(doseSel.files)) dTxt = ' + dose'; else failed.push('dose'); }
    setChecks('folder', failed.map(f => ['bad', `Not loaded: ${f}${/[.)]$/.test(f) ? '' : '.'}`]), true);
    current = 'pri'; buildImgSel(); draw(); renderNotesPanel();
    log(`Patient folder loaded: primary + ${nOk} of ${extras.length} extra scan(s)${dTxt}${failed.length ? `; ${failed.length} item(s) failed` : ''}.`);
    const nChecks = Object.values(checks).flat().filter(c => c.level !== 'info' && !dismissedChecks.has(c.text)).length;
    const msg = `Loaded ${scanName('pri')}${nOk ? ` + ${nOk} scan${nOk > 1 ? 's' : ''}` : ''}${dTxt}${rois.length ? `, ${rois.length} structure${rois.length > 1 ? 's' : ''}` : ''}.`
      + (failed.length ? ` ${failed.length} item${failed.length > 1 ? 's' : ''} could not be loaded.` : '')
      + (nChecks ? ` ${nChecks} thing${nChecks > 1 ? 's' : ''} to check: see Checks in the side panel.` : '');
    toast(msg, failed.length || nChecks ? 'warn' : 'ok', failed.length || nChecks ? 12000 : 0);
    if (nChecks && $('accChecks')) $('accChecks').classList.remove('closed');
  } catch (e) {
    reportError('Loading the patient folder stopped', e);
  } finally { busyBatch = false; busyDone(true); }
}
