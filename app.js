const PY = String.raw`
import os, gc, json, hashlib, numpy as np, pydicom
from collections import deque, Counter

class UserError(Exception):
    """A problem with the input data, explained in plain language (shown to the user as is)."""

# ---------------- anonymisation (applied in memory as each file is read) ----------------
ANON = {'on': False, 'salt': ''}
def set_anon(on, salt):
    ANON['on'] = bool(on); ANON['salt'] = str(salt)

# UIDs that identify a DICOM class/syntax rather than an instance: never remapped
CLASS_UIDS = {'SOPClassUID', 'ReferencedSOPClassUID', 'MediaStorageSOPClassUID', 'TransferSyntaxUID',
              'ImplementationClassUID', 'RelatedGeneralSOPClassUID', 'OriginalSpecializedSOPClassUID',
              'CodingSchemeUID', 'ContextGroupExtensionCreatorUID', 'PrivateInformationCreatorUID',
              'ReferencedSOPClassUIDInFile', 'ReferencedTransferSyntaxUIDInFile', 'SOPClassesInStudy',
              'ReferencedRelatedGeneralSOPClassUIDInFile', 'InstanceCreatorUID', 'MappingResourceUID',
              'ContextUID', 'CodingSchemeRegistry'}
# removed outright (DICOM PS3.15 basic profile, the identifying parts relevant to RT data)
PHI_REMOVE = ['PatientAddress', 'PatientTelephoneNumbers', 'OtherPatientIDs', 'OtherPatientNames',
              'OtherPatientIDsSequence', 'PatientBirthName', 'PatientMotherBirthName', 'PatientComments',
              'MedicalRecordLocator', 'MilitaryRank', 'BranchOfService', 'EthnicGroup', 'Occupation',
              'AdditionalPatientHistory', 'PatientInsurancePlanCodeSequence', 'IssuerOfPatientID',
              'InstitutionName', 'InstitutionAddress', 'InstitutionalDepartmentName', 'InstitutionCodeSequence',
              'StationName', 'DeviceSerialNumber', 'AccessionNumber', 'StudyID', 'AdmissionID',
              'RequestAttributesSequence', 'ReferencedPatientSequence', 'ReferringPhysicianAddress',
              'ReferringPhysicianTelephoneNumbers', 'ReferringPhysicianIdentificationSequence',
              'PhysiciansOfRecordIdentificationSequence', 'PerformingPhysicianIdentificationSequence',
              'OperatorIdentificationSequence', 'PerformedProcedureStepID', 'ScheduledProcedureStepID',
              'RequestedProcedureID', 'PatientAge', 'PatientWeight', 'PatientSize', 'PatientBirthTime',
              'ResponsibleOrganization', 'ResponsiblePerson', 'PatientState', 'CurrentPatientLocation',
              'PatientReligiousPreference', 'RegionOfResidence', 'CountryOfResidence']
_uid_map = {}
def anon_uid(u):
    u = str(u)
    if u not in _uid_map:
        h = hashlib.sha256((ANON['salt'] + '|' + u).encode()).hexdigest()
        _uid_map[u] = '2.25.' + str(int(h[:30], 16))      # deterministic: same input -> same UID
    return _uid_map[u]

def anonymise(ds):
    """De-identify in place: remove identifying tags, blank names/dates, remap instance UIDs consistently
    (so references between CT, MR, RTSTRUCT and REG still match). Burned-in pixel text is not removed."""
    if not ANON['on']:
        return ds
    pid = str(getattr(ds, 'PatientID', ''))
    ds.remove_private_tags()
    for kw in PHI_REMOVE:
        if kw in ds:
            delattr(ds, kw)
    def cb(d, el):
        if el.value in (None, '') or el.keyword == 'PixelData':
            return
        if el.VR == 'UI' and el.keyword not in CLASS_UIDS:
            el.value = [anon_uid(v) for v in el.value] if el.VM > 1 else anon_uid(el.value)
        elif el.VR == 'PN':
            el.value = ''
        elif el.VR in ('DA', 'DT', 'TM'):
            el.value = ''
    ds.walk(cb)
    if hasattr(ds, 'file_meta') and 'MediaStorageSOPInstanceUID' in ds.file_meta:
        ds.file_meta.MediaStorageSOPInstanceUID = anon_uid(ds.file_meta.MediaStorageSOPInstanceUID)
    ds.PatientName = 'ANON'
    ds.PatientID = 'ANON-' + hashlib.sha256((ANON['salt'] + '|' + pid).encode()).hexdigest()[:8].upper()
    ds.PatientIdentityRemoved = 'YES'
    ds.DeidentificationMethod = 'Basic profile; UIDs remapped; dates removed'
    return ds

def fix_meta(d):
    """Files without a proper DICOM header (e.g. some Monaco/TPS exports) lack the Transfer Syntax UID.
    Infer it from how the file was actually parsed so pixel data can be decoded."""
    try:
        fm = getattr(d, 'file_meta', None)
        if fm is None:
            d.file_meta = fm = pydicom.dataset.FileMetaDataset()
        if 'TransferSyntaxUID' not in fm:
            enc = getattr(d, 'original_encoding', None)
            imp, little = (enc if enc and enc[0] is not None else (getattr(d, 'is_implicit_VR', True), getattr(d, 'is_little_endian', True)))
            if imp is None: imp = True
            if little is None: little = True
            fm.TransferSyntaxUID = (pydicom.uid.ImplicitVRLittleEndian if imp else
                                    pydicom.uid.ExplicitVRLittleEndian if little else pydicom.uid.ExplicitVRBigEndian)
    except Exception:
        pass
    return d

def dcmread_any(path, **kw):
    return fix_meta(pydicom.dcmread(path, force=True, **kw))

def read_dcm(path, **kw):
    return anonymise(dcmread_any(path, **kw))

# ---------------- quick header read for sorting a whole patient folder ----------------
def _plane_of(iop):
    try:
        v = np.array(iop, float); n = np.abs(np.cross(v[:3], v[3:]))
        ax = ['sagittal', 'coronal', 'axial'][int(np.argmax(n))]
        return ax if n.max() > 0.985 else ax + ' oblique'
    except Exception:
        return ''

def header(path, truncated=False):
    """Summarise one file without pixel data. Returns need_full if the (truncated) read ran out."""
    try:
        d = dcmread_any(path, stop_before_pixels=True)
        mod = str(getattr(d, 'Modality', ''))
        if not mod and 'SOPClassUID' not in d:
            return json.dumps(dict(ok=False))
        if truncated and mod in ('RTSTRUCT', 'REG', 'RTPLAN'):
            return json.dumps(dict(ok=False, need_full=True))
        o = dict(ok=True, mod=mod, series=str(getattr(d, 'SeriesInstanceUID', '')), desc=str(getattr(d, 'SeriesDescription', '')),
                 FoR=str(getattr(d, 'FrameOfReferenceUID', '')), date=str(getattr(d, 'SeriesDate', '') or getattr(d, 'StudyDate', '')),
                 time=str(getattr(d, 'SeriesTime', '') or ''), study=str(getattr(d, 'StudyInstanceUID', '')),
                 pid=str(getattr(d, 'PatientID', '')), sop=str(getattr(d, 'SOPInstanceUID', '')))
        if mod == 'RTSTRUCT':
            o['refFoR'] = [str(f.FrameOfReferenceUID) for f in getattr(d, 'ReferencedFrameOfReferenceSequence', [])]
            refs = []
            for f in getattr(d, 'ReferencedFrameOfReferenceSequence', []):
                for st in getattr(f, 'RTReferencedStudySequence', []):
                    for se in getattr(st, 'RTReferencedSeriesSequence', []):
                        refs.append(str(se.SeriesInstanceUID))
            o['refSeries'] = refs
            o['label'] = str(getattr(d, 'StructureSetLabel', '') or getattr(d, 'StructureSetName', ''))
            o['nROI'] = len(getattr(d, 'StructureSetROISequence', []))
            o['date'] = str(getattr(d, 'StructureSetDate', '') or o['date'])
        elif mod == 'REG':
            f = [str(getattr(d, 'FrameOfReferenceUID', ''))]
            for it in getattr(d, 'RegistrationSequence', []):
                f.append(str(it.FrameOfReferenceUID))
            for it in getattr(d, 'DeformableRegistrationSequence', []):
                f.append(str(it.SourceFrameOfReferenceUID))
            o['fors'] = sorted(set(x for x in f if x))
            o['deformable'] = 'DeformableRegistrationSequence' in d
        elif mod == 'RTDOSE':
            o['sum'] = str(getattr(d, 'DoseSummationType', ''))
            try: o['refPlan'] = str(d.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID)
            except Exception: o['refPlan'] = ''
        elif mod == 'RTPLAN':
            o.update(_plan_rx(d))
        elif 'ImageOrientationPatient' in d:
            o['plane'] = _plane_of(d.ImageOrientationPatient)
            o['rows'] = int(getattr(d, 'Rows', 0)); o['cols'] = int(getattr(d, 'Columns', 0))
            o['ps'] = float(d.PixelSpacing[0]) if 'PixelSpacing' in d else 0
            o['thk'] = float(getattr(d, 'SliceThickness', 0) or 0)
        return json.dumps(o)
    except Exception as e:
        return json.dumps(dict(ok=False, need_full=bool(truncated), err=str(e)[:100]))
    finally:
        try: os.remove(path)
        except Exception: pass

def read_reg(path):
    try:
        reg = read_dcm(path)
    except Exception:
        raise UserError('The registration file could not be read as DICOM.')
    finally:
        try: os.remove(path)
        except Exception: pass
    if str(getattr(reg, 'Modality', '')) != 'REG':
        raise UserError(f'The file chosen as the registration is not a REG file (it is {getattr(reg, "Modality", "") or "unknown"}).')
    try:
        parse_reg(reg)
    except Exception as e:
        raise UserError('The registration file could not be interpreted: its matrices are missing or malformed.')
    return reg

def add_reg(key, path):
    """Register an extra REG file (not tied to a scan slot); re-resolves all secondaries."""
    REGS[key] = read_reg(path)
    return json.dumps(resolve_all() if P is not None else {})

def resolve_json():
    return json.dumps(resolve_all() if P is not None else {})

P = None          # primary series
SEC = {}          # secondary id -> series (+ T, Ainv, cache, invert)
REGS = {}         # secondary id -> REG dataset loaded with that slot
ING, OTHER, FACTOR, SKIP = {}, {}, {}, {}
NON_IMAGE = {'RTSTRUCT', 'REG', 'RTPLAN', 'RTDOSE', 'RTRECORD', 'SR', 'PR', 'KO'}
VOXEL_BUDGET = 80_000_000      # max voxels kept per secondary (stored float16 -> ~160 MB)

def ingest_begin(tag, nfiles, downsample):
    """Start streaming a series in. Files are read one at a time and deleted immediately."""
    global P
    if tag == 'pri':
        P = None; SEC.clear(); REGS.clear()
    else:
        SEC.pop(tag, None); REGS.pop(tag, None)
    ING[tag], OTHER[tag], SKIP[tag] = [], [], Counter()
    FACTOR[tag] = dict(n=nfiles, down=bool(downsample), f=None)
    gc.collect()

def _ts_name(d):
    try:
        u = d.file_meta.TransferSyntaxUID
        return getattr(u, 'name', '') or str(u)
    except Exception:
        return 'unknown encoding'

def ingest(tag, path):
    try:
        d = dcmread_any(path)
    except Exception:
        SKIP[tag]['unreadable'] += 1
        os.remove(path); return 'unreadable'
    os.remove(path)
    mod = str(getattr(d, 'Modality', ''))
    if 'PixelData' not in d or mod in NON_IMAGE:
        if mod in ('REG', 'RTSTRUCT'):
            OTHER[tag].append(anonymise(d))
        return mod or 'other'
    if int(getattr(d, 'NumberOfFrames', 1) or 1) > 1:
        SKIP[tag]['multiframe'] += 1
        return 'multiframe-skipped'
    if not all(k in d for k in ('PixelSpacing', 'ImagePositionPatient', 'ImageOrientationPatient')):
        SKIP[tag]['nogeom'] += 1
        return 'no-geometry'
    fc = FACTOR[tag]
    if fc['f'] is None:
        f = 1
        if fc['down'] and P is not None:
            sps = min(float(x) for x in d.PixelSpacing)
            f = max(1, int(np.floor(min(P['ps']) / sps + 1e-6)))     # no finer than the primary grid
            while fc['n'] * (int(d.Rows) // f) * (int(d.Columns) // f) > VOXEL_BUDGET:
                f += 1
        fc['f'] = f
    f = fc['f']
    try:
        arr = d.pixel_array
    except Exception:
        SKIP[tag]['undecodable:' + _ts_name(d)] += 1
        return 'undecodable'
    if arr.ndim != 2:
        SKIP[tag]['multiframe'] += 1
        return 'multiframe-skipped'
    slope = float(getattr(d, 'RescaleSlope', 1) or 1); icpt = float(getattr(d, 'RescaleIntercept', 0) or 0)
    arr = arr.astype(np.float32) * slope + icpt
    if f > 1:
        r, c = (arr.shape[0] // f) * f, (arr.shape[1] // f) * f
        arr = arr[:r, :c].reshape(r // f, f, c // f, f).mean(axis=(1, 3), dtype=np.float32)
    if tag == 'pri':
        if slope.is_integer() and icpt.is_integer() and arr.min() >= -32768 and arr.max() <= 32767:
            arr = arr.astype(np.int16)        # CT HU: half the memory of float32
    elif np.abs(arr).max() < 60000:
        arr = arr.astype(np.float16)          # display only needs ~8 bits; quarter of float64, half of float32
    del d.PixelData
    if hasattr(d, '_pixel_array'):
        d._pixel_array = None
    anonymise(d)
    ING[tag].append((d, arr))
    return mod

def _skip_text(c):
    """Plain-language reasons for images that could not be used."""
    out = []
    for k, v in c.items():
        if k == 'unreadable':
            out.append(f'{v} file(s) are not DICOM or could not be read')
        elif k == 'multiframe':
            out.append(f'{v} file(s) are multi-frame (enhanced) images, which are not supported yet: export them as classic single-frame images')
        elif k == 'nogeom':
            out.append(f'{v} image(s) have no position/orientation (e.g. screenshots or secondary captures)')
        elif k.startswith('undecodable:'):
            out.append(f'{v} image(s) are compressed ({k.split(":", 1)[1]}), which TapAtlas cannot decode: '
                       'export them uncompressed (Implicit or Explicit VR Little Endian)')
    return out

def _mv(d, k):
    v = getattr(d, k, None)
    if v is None:
        return ''
    return str(list(v)) if hasattr(v, '__len__') and not isinstance(v, (str, bytes)) else str(v)

# fields that separate several stacks stored in one series (echoes, phases, b-values, ...)
STACK_FIELDS = ['EchoNumbers', 'TemporalPositionIdentifier', 'TemporalPositionIndex', 'TriggerTime',
                'DiffusionBValue', 'ImageType', 'AcquisitionNumber', 'SeriesNumber']

def build_series(tag):
    """Pick the largest image series, keep one consistent stack, sort along slice normal,
    build volume + voxel->patient affine. Problems are reported in info['warnings']."""
    items = ING.pop(tag, [])
    f = FACTOR[tag]['f'] or 1
    skipped = _skip_text(SKIP.get(tag, {}))
    warnings = []
    if not items:
        raise UserError('No usable image slices were found. ' + ('; '.join(skipped) + '.' if skipped else
                        'Check that you chose the image files (not only the structure set, plan or dose).'))
    for t in skipped:
        warnings.append(['warn', 'Left out: ' + t + '.'])
    groups = {}
    for d, a in items:
        groups.setdefault(str(getattr(d, 'SeriesInstanceUID', '')), []).append((d, a))
    items = None
    sel = max(groups.values(), key=len)
    nseries = len(groups)
    if nseries > 1:
        other = sum(len(g) for g in groups.values()) - len(sel)
        desc = str(getattr(sel[0][0], 'SeriesDescription', '') or 'no description')
        warnings.append(['warn', f'The files contained {nseries} image series: used the largest ({desc}, {len(sel)} images); '
                                 f'{other} image(s) from the other series were ignored.'])
    groups = None
    # one geometry: same matrix size, orientation and pixel spacing
    def gkey(t):
        d, a = t
        return (a.shape, tuple(round(float(x), 3) for x in d.ImageOrientationPatient), tuple(round(float(x), 4) for x in d.PixelSpacing))
    gc_ = Counter(gkey(t) for t in sel)
    if len(gc_) > 1:
        best = gc_.most_common(1)[0][0]
        n0 = len(sel); sel = [t for t in sel if gkey(t) == best]
        warnings.append(['warn', f'{n0 - len(sel)} image(s) with a different matrix size, orientation or pixel spacing '
                                 f'were left out (kept {len(sel)}).'])
    gc.collect()
    iop = np.array(sel[0][0].ImageOrientationPatient, float)
    row, col = iop[:3], iop[3:]
    normal = np.cross(row, col)
    # stack slices from inferior to superior (feet-first and other reversed orientations), so sagittal and
    # coronal views always have the head at the top; row/column directions are kept as acquired
    if np.argmax(np.abs(normal)) == 2 and normal[2] < 0:
        normal = -normal
    zpos = lambda t: round(float(np.dot(normal, np.array(t[0].ImagePositionPatient, float))), 2)
    # several images at the same position: several stacks in one series (echoes, phases, repeats)
    cnt = Counter(zpos(t) for t in sel)
    if max(cnt.values()) > 1:
        n0, chosen = len(sel), None
        for fld in STACK_FIELDS:
            sub = {}
            for t in sel:
                sub.setdefault(_mv(t[0], fld), []).append(t)
            if len(sub) < 2:
                continue
            if all(max(Counter(zpos(t) for t in g).values()) == 1 for g in sub.values()):
                key, g = max(sub.items(), key=lambda kv: len(kv[1]))
                if len(g) >= 2:
                    chosen = (fld, key, g, len(sub)); break
        if chosen is None:
            raise UserError(f'This series has {max(cnt.values())} images at the same slice position (e.g. several echoes, '
                            'phases or repeated scans stored together) and they could not be separated. '
                            'Export a single volume from the planning system or PACS.')
        fld, key, sel, ng = chosen
        warnings.append(['warn', f'This series holds {ng} stacks of images at the same positions (separated by {fld}). '
                                 f'Used {fld} = {key or "(blank)"} ({len(sel)} of {n0} images).'])
    sel.sort(key=lambda t: float(np.dot(normal, np.array(t[0].ImagePositionPatient, float))))
    sl = [t[0] for t in sel]
    d0 = sl[0]             # first slice AFTER sorting (files arrive in arbitrary order)
    dts = {t[1].dtype for t in sel}
    dtype = dts.pop() if len(dts) == 1 else np.float32
    vol = np.empty((len(sel),) + sel[0][1].shape, dtype)
    for i in range(len(sel)):
        vol[i] = sel[i][1]; sel[i] = None
    sel = None; gc.collect()
    ps0 = [float(x) for x in d0.PixelSpacing]
    ps = [ps0[0] * f, ps0[1] * f]
    pos = np.array([float(np.dot(normal, np.array(d.ImagePositionPatient, float))) for d in sl])
    gap = float(np.median(np.diff(pos))) if len(pos) > 1 else float(getattr(d0, 'SliceThickness', 1) or 1)
    if not gap > 1e-3:
        raise UserError('The slice positions of this series could not be worked out (zero spacing between slices).')
    uneven = None
    if len(pos) > 2:
        dd = np.diff(pos)
        if dd.max() > 1.5 * gap or dd.min() < 0.5 * gap:
            big = int(np.sum(dd > 1.5 * gap))
            uneven = (float(dd.min()), float(dd.max()), big)
    A = np.eye(4)          # (col, row, slice, 1) -> patient mm
    A[:3, 0] = row * ps[1]
    A[:3, 1] = col * ps[0]
    A[:3, 2] = normal * gap
    # block-averaged pixel centre sits (f-1)/2 original pixels in from the original first pixel
    A[:3, 3] = np.array(d0.ImagePositionPatient, float) + row * ps0[1] * (f - 1) / 2 + col * ps0[0] * (f - 1) / 2
    pids = sorted({str(getattr(d, 'PatientID', '')) for d in sl} - {''})
    if len(pids) > 1:
        warnings.append(['bad', f'The images in this series carry {len(pids)} different patient IDs.'])
    info = dict(modality=str(d0.Modality), n=len(sl), rows=int(vol.shape[1]), cols=int(vol.shape[2]),
                originalRowsCols=[int(d0.Rows), int(d0.Columns)], downsample=f, ps=ps,
                sliceGap=round(gap, 3), patient=str(getattr(d0, 'PatientID', '')),
                series=str(getattr(d0, 'SeriesDescription', '')),
                FoR=str(getattr(d0, 'FrameOfReferenceUID', '')),
                seriesInFolder=nseries, memoryMB=round(vol.nbytes / 1e6),
                range=[float(np.nanmin(vol)), float(np.nanmax(vol))],
                dirs=dict(row=np.round(row, 4).tolist(), col=np.round(col, 4).tolist(), normal=np.round(normal, 4).tolist()),
                warnings=warnings)
    return dict(slices=sl, vol=vol, row=row, col=col, normal=normal, ps=ps, pos=pos, gap=gap, A=A, info=info, uneven=uneven)

def _same_patient(info, label):
    """Warning if this object's patient ID differs from the primary's (IDs are compared after anonymisation,
    which maps the same ID to the same value)."""
    if P is None:
        return []
    a, b = str(P['info'].get('patient', '')), str(info.get('patient', ''))
    if a and b and a != b:
        return [['bad', f'{label} has a different patient ID from the primary CT. Check that it belongs to this patient.']]
    return []

def load(rs_path):
    global P
    rs = None
    if rs_path:                       # check the structure set before replacing anything
        try:
            rs = read_dcm(rs_path)
        except Exception:
            raise UserError('The structure set file could not be read as DICOM.')
        finally:
            try: os.remove(rs_path)
            except Exception: pass
        if str(getattr(rs, 'Modality', '')) != 'RTSTRUCT':
            raise UserError(f'The file chosen as the structure set is not an RTSTRUCT (it is {getattr(rs, "Modality", "") or "unknown"}).')
    P = build_series('pri')
    W = P['info']['warnings']
    if P['uneven']:
        lo, hi, big = P['uneven']
        W.append(['bad', f'Uneven slice spacing in the primary ({lo:.2f} to {hi:.2f} mm, usually {P["gap"]:.2f} mm'
                         + (f'; {big} gap(s) look like missing slices' if big else '') +
                         '). Axial slices are correct, but sagittal/coronal views, registered scans and dose are placed '
                         'assuming even spacing, so they are distorted near the gaps.'])
    sl, ps, row, col, normal, pos = P['slices'], P['ps'], P['row'], P['col'], P['normal'], P['pos']
    uid_to_idx = {d.SOPInstanceUID: i for i, d in enumerate(sl)}
    out = []
    if rs is None:
        rs = next((d for d in OTHER.get('pri', []) if d.Modality == 'RTSTRUCT'), None)
    if rs is not None:
        if 'StructureSetROISequence' not in rs:
            raise UserError('The structure set contains no structures (StructureSetROISequence is missing).')
        ref_for = [str(getattr(f, 'FrameOfReferenceUID', '')) for f in getattr(rs, 'ReferencedFrameOfReferenceSequence', [])]
        if ref_for and P['info']['FoR'] and P['info']['FoR'] not in ref_for:
            W.append(['bad', 'The structure set was drawn on a different frame of reference from this CT. '
                             'Contours are placed by position only and may not line up.'])
        W.extend(_same_patient(dict(patient=str(getattr(rs, 'PatientID', ''))), 'The structure set'))
        names = {r.ROINumber: r.ROIName for r in rs.StructureSetROISequence}
        tol = abs(P['gap']) / 2 or 1.0
        unmatched, unmatched_rois = 0, set()
        for rc in getattr(rs, 'ROIContourSequence', []):
            num = rc.ReferencedROINumber
            try: color = [int(c) for c in rc.ROIDisplayColor][:3]
            except Exception: color = [255, 255, 0]
            if len(color) != 3: color = [255, 255, 0]
            per_slice, npts = {}, 0
            for c in getattr(rc, 'ContourSequence', []):
                try:
                    pts = np.array(c.ContourData, float).reshape(-1, 3)
                except Exception:
                    unmatched += 1; unmatched_rois.add(num); continue
                if len(pts) < 2:
                    continue
                npts += len(pts)
                idx = None
                if 'ContourImageSequence' in c and len(c.ContourImageSequence):
                    idx = uid_to_idx.get(c.ContourImageSequence[0].ReferencedSOPInstanceUID)
                if idx is None:
                    z = float(np.dot(normal, pts[0]))
                    j = int(np.argmin(np.abs(pos - z)))
                    if abs(pos[j] - z) <= tol + 1e-3:
                        idx = j
                if idx is None:
                    unmatched += 1; unmatched_rois.add(num)
                    continue
                ipp = np.array(sl[idx].ImagePositionPatient, float)
                rel = pts - ipp
                x = rel @ row / ps[1]
                y = rel @ col / ps[0]
                per_slice.setdefault(idx, []).append(np.column_stack([x, y]).ravel().round(2).tolist())
            out.append(dict(number=int(num), name=str(names.get(num, f'ROI {num}')), color=color,
                            nContours=sum(len(v) for v in per_slice.values()), nPoints=npts, slices=per_slice))
        P['info']['unmatchedContours'] = unmatched
        if unmatched:
            nm = sorted(str(names.get(n, f'ROI {n}')) for n in unmatched_rois)
            W.append(['warn', f'{unmatched} contour(s) in {len(nm)} structure(s) do not lie on a slice of this CT and are not shown: '
                              + ', '.join(nm[:8]) + (' …' if len(nm) > 8 else '') + '.'])
    P['info']['A'] = np.round(P['A'], 5).tolist()     # voxel -> patient, for slice positions in the atlas
    P['info'].update(scan_window(P))
    return json.dumps(dict(info=P['info'], rois=out))

# ---------------- registration ----------------
def matrix_seq(seq):
    M = np.eye(4)
    for m in seq:
        M = np.array(m.FrameOfReferenceTransformationMatrix, float).reshape(4, 4) @ M
    return M

def parse_reg(reg):
    """Return {FoR UID: 4x4 matrix mapping that FoR into the REG's registered FoR}, notes."""
    mats, notes = {}, []
    target = str(getattr(reg, 'FrameOfReferenceUID', ''))
    if 'RegistrationSequence' in reg:
        for it in reg.RegistrationSequence:
            M = np.eye(4)
            for mr in getattr(it, 'MatrixRegistrationSequence', []):
                M = matrix_seq(mr.MatrixSequence) @ M
            mats[str(it.FrameOfReferenceUID)] = M
    if 'DeformableRegistrationSequence' in reg:
        notes.append('Deformable REG: only the rigid pre/post-deformation matrices are applied; the deformation grid is ignored.')
        for it in reg.DeformableRegistrationSequence:
            M = np.eye(4)
            if 'PreDeformationMatrixRegistrationSequence' in it:
                M = np.array(it.PreDeformationMatrixRegistrationSequence[0].FrameOfReferenceTransformationMatrix, float).reshape(4, 4) @ M
            if 'PostDeformationMatrixRegistrationSequence' in it:
                M = np.array(it.PostDeformationMatrixRegistrationSequence[0].FrameOfReferenceTransformationMatrix, float).reshape(4, 4) @ M
            mats[str(it.SourceFrameOfReferenceUID)] = M
    mats.setdefault(target, np.eye(4))
    return mats, notes

def for_label(f):
    if P is not None and f == P['info']['FoR']:
        return 'PRIMARY (' + (P['info']['series'] or P['info']['modality']) + ')'
    for sid, s in SEC.items():
        if s['info']['FoR'] == f:
            return sid + ' (' + (s['info']['series'] or s['info']['modality']) + ')'
    return 'unloaded FoR …' + f[-8:]

def resolve_all():
    """Chain every loaded REG into a graph of frames of reference and find primary -> secondary for each slot."""
    edges = {}     # FoR a -> list of (FoR b, matrix a->b, via)
    notes_by_reg, deformable = {}, set()
    for rid, reg in REGS.items():
        mats, notes = parse_reg(reg)
        notes_by_reg[rid] = notes
        if 'DeformableRegistrationSequence' in reg:
            deformable.add(rid)
        for a, Ma in mats.items():
            for b, Mb in mats.items():
                if a != b:
                    edges.setdefault(a, []).append((b, np.linalg.inv(Mb) @ Ma, rid))
    fP = P['info']['FoR']
    out = {}
    for sid, S in SEC.items():
        fS = S['info']['FoR']
        notes = list(notes_by_reg.get(sid, []))
        T, path, used = None, [], set()
        if fS == fP:
            T = np.eye(4); notes.append('Same frame of reference as primary: identity.')
        else:
            prev = {fP: None}; q = deque([fP])
            while q:
                a = q.popleft()
                if a == fS: break
                for b, M, rid in edges.get(a, []):
                    if b not in prev:
                        prev[b] = (a, M, rid); q.append(b)
            if fS in prev:
                chain, node = [], fS            # walk back from the secondary to the primary
                while prev[node] is not None:
                    a, M, rid = prev[node]
                    chain.append(M); used.add(rid); path.append(f'{for_label(a)} -> {for_label(node)} via REG loaded with {rid}')
                    node = a
                path.reverse()
                T = np.eye(4)
                for M in reversed(chain):       # apply the primary-side step first
                    T = M @ T
                notes.append('Registration path: ' + ' ; '.join(path))
        status = 'registered'
        if T is None:
            T = np.eye(4); status = 'UNREGISTERED'
            notes.append('WARNING: no registration links this scan to the primary (load its REG, or the REG of an intermediate scan). Shown with identity.')
        if S.get('invert'):
            T = np.linalg.inv(T); notes.append('Matrix inverted (debug option).')
        if not np.allclose(T, S.get('T', np.full((4, 4), np.nan))):
            S['cache'] = {}
        S['T'] = T
        out[sid] = dict(status=status, notes=notes, deformable=bool(used & deformable), primaryToSecondary=np.round(T, 4).tolist())
    return out

def scan_window(S):
    """Default display window: the one stored in the images (WindowWidth/Center, as acquired/exported),
    else soft tissue for CT, else a percentile window."""
    dw = dl = None
    sl = S['slices']
    for d in (sl[len(sl) // 2], sl[0]):
        try:
            w, c = d.WindowWidth, d.WindowCenter
            w = float(w[0] if isinstance(w, (list, tuple)) or hasattr(w, '__len__') and not isinstance(w, str) else w)
            c = float(c[0] if isinstance(c, (list, tuple)) or hasattr(c, '__len__') and not isinstance(c, str) else c)
            if w > 1:
                dw, dl = w, c; break
        except Exception:
            pass
    if dw is not None:
        src = 'dicom'
        ww, wl = dw, dl
    else:
        v = S['vol'][::max(1, S['vol'].shape[0] // 20)].astype(np.float32)
        lo, hi = np.nanpercentile(v, [1, 99.5])
        src = 'auto'
        ww, wl = float(hi - lo), float((hi + lo) / 2)
    dflt = dict(ww=round(ww, 1), wl=round(wl, 1), src=src)
    if S['info']['modality'] == 'CT' and src != 'dicom':
        ww, wl = 400.0, 40.0
    return dict(autoW=round(ww, 1), autoL=round(wl, 1), winDefault=dflt)

def load_secondary(tag, reg_path, invert):
    reg = read_reg(reg_path) if reg_path else None
    if reg is None:   # fall back to a REG sitting in the secondary folder
        regs = [d for d in OTHER.get(tag, []) if getattr(d, 'Modality', '') == 'REG']
        reg = regs[0] if regs else None
    S = build_series(tag)
    S['Ainv'] = np.linalg.inv(S['A'])
    d = np.diff(S['pos'])
    S['uniform'] = bool(len(d) == 0 or (d.max() - d.min()) < 0.05 * abs(S['gap']))
    if not S['uniform']:
        S['info']['note'] = f'Uneven slice spacing ({d.min():.2f}-{d.max():.2f} mm): using per-slice positions.'
        if S['uneven'] and S['uneven'][2]:
            S['info']['warnings'].append(['warn', f'{S["uneven"][2]} gap(s) between slices look like missing slices '
                                                  f'(up to {S["uneven"][1]:.1f} mm): the image is interpolated across them.'])
    S['info']['warnings'].extend(_same_patient(S['info'], 'This scan'))
    S['invert'] = bool(invert)
    S['cache'] = {}
    SEC[tag] = S
    if reg is not None:
        REGS[tag] = reg
    info = dict(S['info'], hasREG=reg is not None, **scan_window(S))
    return json.dumps(dict(info=info, all=resolve_all()))

def set_invert(tag, invert):
    SEC[tag]['invert'] = bool(invert)
    return json.dumps(resolve_all())

def remove_secondary(tag):
    SEC.pop(tag, None); REGS.pop(tag, None); gc.collect()
    return json.dumps(resolve_all())

# ---------------- crop ----------------
def _label_largest(m):
    """Largest 4-connected component of a small 2D bool array (pure python BFS)."""
    h, w = m.shape
    lab = np.zeros((h, w), np.int32); best, best_n, cur = 0, 0, 0
    for y0 in range(h):
        for x0 in range(w):
            if m[y0, x0] and not lab[y0, x0]:
                cur += 1; n = 0; q = deque([(y0, x0)]); lab[y0, x0] = cur
                while q:
                    y, x = q.popleft(); n += 1
                    for yy, xx in ((y-1, x), (y+1, x), (y, x-1), (y, x+1)):
                        if 0 <= yy < h and 0 <= xx < w and m[yy, xx] and not lab[yy, xx]:
                            lab[yy, xx] = cur; q.append((yy, xx))
                if n > best_n: best, best_n = cur, n
    return lab == best

def auto_crop(margin_mm):
    """Bounding box of the patient's body (largest connected blob, so the couch is excluded)."""
    v = P['vol']; n, rows, cols = v.shape
    step = max(1, n // 40)
    sub = v[::step].astype(np.float32)
    thr = -400.0 if P['info']['modality'] == 'CT' else float(np.percentile(sub, 99)) * 0.1
    frac = (sub > thr).mean(axis=0)                   # how often each (row, col) is inside the body
    f = 4
    r4, c4 = rows // f, cols // f
    m = frac[:r4 * f, :c4 * f].reshape(r4, f, c4, f).max(axis=(1, 3)) > 0.05
    # open slightly so thin couch/body contacts break apart
    er = m & np.roll(m, 1, 0) & np.roll(m, -1, 0) & np.roll(m, 1, 1) & np.roll(m, -1, 1)
    body = _label_largest(er)
    ys, xs = np.nonzero(body)
    if not len(ys):
        return json.dumps(dict(c0=0, c1=cols - 1, r0=0, r1=rows - 1, k0=0, k1=n - 1))
    mr, mc = margin_mm / P['ps'][0], margin_mm / P['ps'][1]
    r0 = max(0, int(ys.min() * f - f - mr)); r1 = min(rows - 1, int((ys.max() + 1) * f + f + mr))
    c0 = max(0, int(xs.min() * f - f - mc)); c1 = min(cols - 1, int((xs.max() + 1) * f + f + mc))
    # z: slices where the body is present at all
    zs = np.nonzero((v[:, r0:r1 + 1:4, c0:c1 + 1:4] > thr).mean(axis=(1, 2)) > 0.01)[0]
    k0, k1 = (int(zs.min()), int(zs.max())) if len(zs) else (0, n - 1)
    return json.dumps(dict(c0=c0, c1=c1, r0=r0, r1=r1, k0=k0, k1=k1))

# ---------------- planes ----------------
_grid = {}
def plane_shape(view):
    n, rows, cols = P['vol'].shape
    return {'ax': (rows, cols), 'sag': (n, rows), 'cor': (n, cols)}[view]

def sec_plane(sid, view, i):
    """Resample a secondary onto a primary plane (trilinear, NaN outside).
    ax: (rows, cols) at slice i; sag: (n, rows) at column i; cor: (n, cols) at row i.
    Sag/cor are returned superior-at-top (slice order flipped)."""
    S = SEC[sid]; cache = S['cache']
    i = int(i); key = (view, i)
    if key in cache:
        return cache[key]
    h, w = plane_shape(view)
    gk = (view, h, w)
    if gk not in _grid:
        yy, xx = np.mgrid[0:h, 0:w]
        _grid[gk] = (yy.ravel().astype(np.float64), xx.ravel().astype(np.float64))
    yy, xx = _grid[gk]
    one = np.ones_like(xx)
    n = P['vol'].shape[0]
    Ap = P['A'].copy()
    if view == 'ax':
        Ap[:3, 3] = np.array(P['slices'][i].ImagePositionPatient, float)
        pts = np.stack([xx, yy, 0 * one, one])
    elif view == 'sag':
        pts = np.stack([i * one, xx, (n - 1) - yy, one])
    else:
        pts = np.stack([xx, i * one, (n - 1) - yy, one])
    pat = S['T'] @ Ap @ pts                        # primary voxel -> secondary patient mm
    c, r = (S['Ainv'] @ pat)[:2]
    # slice index from each slice's actual position (handles uneven spacing / missing slices)
    z = S['normal'] @ pat[:3]
    vol = S['vol']; nk, nr, nc = vol.shape
    if S['uniform']:
        k = (z - S['pos'][0]) / S['gap']
    else:
        k = np.interp(z, S['pos'], np.arange(nk, dtype=np.float64), left=-1.0, right=nk + 1.0)
    c0, r0, k0 = np.floor(c).astype(int), np.floor(r).astype(int), np.floor(k).astype(int)
    fc, fr, fk = c - c0, r - r0, k - k0
    if nk == 1:
        k0[:] = 0; fk[:] = 0
    ok = (c0 >= 0) & (c0 < nc - 1) & (r0 >= 0) & (r0 < nr - 1) & (k0 >= 0) & (k0 < max(nk - 1, 1))
    c0, r0, k0 = np.clip(c0, 0, nc - 2), np.clip(r0, 0, nr - 2), np.clip(k0, 0, max(nk - 2, 0))
    k1 = np.minimum(k0 + 1, nk - 1)
    def g(kk, rr_, cc_): return vol[kk, rr_, cc_].astype(np.float32)
    val = ((g(k0, r0, c0) * (1 - fc) + g(k0, r0, c0 + 1) * fc) * (1 - fr) +
           (g(k0, r0 + 1, c0) * (1 - fc) + g(k0, r0 + 1, c0 + 1) * fc) * fr) * (1 - fk) + \
          ((g(k1, r0, c0) * (1 - fc) + g(k1, r0, c0 + 1) * fc) * (1 - fr) +
           (g(k1, r0 + 1, c0) * (1 - fc) + g(k1, r0 + 1, c0 + 1) * fc) * fr) * fk
    out = np.where(ok, val, np.nan).reshape(h, w).astype(np.float32)
    if len(cache) > 40:
        cache.clear()
    cache[key] = out
    return out

def pri_plane(view, i):
    v = P['vol']; i = int(i)
    if view == 'ax':
        return v[i]
    if view == 'sag':
        return v[::-1, :, i]
    return v[::-1, i, :]

def plane_rgba(view, i, ww, wl, which):
    a = pri_plane(view, i) if which == 'pri' else sec_plane(which, view, i)
    lo = wl - ww / 2
    g = np.clip((np.nan_to_num(np.asarray(a, np.float32), nan=-1e9) - lo) / max(ww, 1e-6) * 255, 0, 255).astype(np.uint8)
    rgba = np.empty(g.shape + (4,), np.uint8)
    rgba[..., 0] = g; rgba[..., 1] = g; rgba[..., 2] = g; rgba[..., 3] = 255
    if which != 'pri':   # tint area outside the secondary dark blue so coverage is visible
        m = np.isnan(a); rgba[m, 0] = 0; rgba[m, 1] = 0; rgba[m, 2] = 40
    return np.frombuffer(rgba.tobytes(), np.uint8)

# ---------------- dose (RTDOSE) ----------------
# The dose grid is held like a secondary scan (key 'dose') so it is resampled onto the primary planes with
# the same trilinear code, and follows the same registration chain if it is in another frame of reference.
def _plan_rx(d):
    rx = None
    for dr in getattr(d, 'DoseReferenceSequence', []):
        v = dr.get('TargetPrescriptionDose', None)
        if v not in (None, ''):
            rx = max(rx or 0.0, float(v))
    fx = None
    for fg in getattr(d, 'FractionGroupSequence', []):
        try: fx = int(fg.NumberOfFractionsPlanned)
        except Exception: pass
    return dict(dose=rx, fx=fx, label=str(getattr(d, 'RTPlanLabel', '') or ''))

def load_dose(paths_json):
    paths = json.loads(paths_json)
    doses, plans, notes = [], [], []
    for p in paths:
        try:
            d = read_dcm(p)
        except Exception:
            notes.append('A file could not be read and was skipped.'); continue
        finally:
            try: os.remove(p)
            except Exception: pass
        mod = str(getattr(d, 'Modality', ''))
        if mod == 'RTDOSE' and 'PixelData' in d:
            doses.append(d)
        elif mod == 'RTPLAN':
            plans.append(d)
    if not doses:
        raise UserError('No RTDOSE file with dose data was found among the files chosen.')
    def geo(d):
        return (int(d.Rows), int(d.Columns), int(getattr(d, 'NumberOfFrames', 1) or 1),
                tuple(round(float(x), 3) for x in d.ImagePositionPatient), tuple(round(float(x), 4) for x in d.PixelSpacing))
    plan_type = [d for d in doses if str(getattr(d, 'DoseSummationType', '')).upper() in ('PLAN', 'MULTI_PLAN')]
    if plan_type:
        use = [plan_type[0]]
        if len(plan_type) > 1:
            notes.append(f'{len(plan_type)} plan doses found: using the first one.')
    else:
        # e.g. one file per beam: sum the ones sharing the first file's grid
        g0 = geo(doses[0]); use = [d for d in doses if geo(d) == g0]
        if len(use) > 1:
            notes.append(f'No plan-sum dose: summed {len(use)} {str(getattr(use[0], "DoseSummationType", "")).lower() or "dose"} files on the same grid.')
        if len(use) < len(doses):
            notes.append(f'{len(doses) - len(use)} dose file(s) on a different grid were ignored.')
    d0 = use[0]
    arr = None
    for d in use:
        try:
            a = fix_meta(d).pixel_array.astype(np.float32) * float(getattr(d, 'DoseGridScaling', 1) or 1)
        except Exception:
            raise UserError(f'The dose grid could not be decoded ({_ts_name(d)}). Export the RTDOSE uncompressed.')
        if a.ndim == 2:
            a = a[None]
        arr = a if arr is None else arr + a
        del d.PixelData
    iop = np.array(d0.ImageOrientationPatient, float)
    row, col = iop[:3], iop[3:]
    normal = np.cross(row, col)
    ps = [float(x) for x in d0.PixelSpacing]
    ipp = np.array(d0.ImagePositionPatient, float)
    z0 = float(normal @ ipp)
    offs = np.array([float(x) for x in getattr(d0, 'GridFrameOffsetVector', [0.0] * arr.shape[0])], float)
    if len(offs) != arr.shape[0]:
        offs = np.arange(arr.shape[0], dtype=float) * float(getattr(d0, 'SliceThickness', 1) or 1)
    # relative offsets start at 0; absolute ones are the frame positions themselves
    pos = offs if (abs(offs[0]) > 1e-6 and abs(offs[0] - z0) < 1e-3) else z0 + offs
    order = np.argsort(pos); pos = pos[order]; arr = np.ascontiguousarray(arr[order])
    gap = float(np.median(np.diff(pos))) if len(pos) > 1 else 1.0
    A = np.eye(4)
    A[:3, 0] = row * ps[1]; A[:3, 1] = col * ps[0]; A[:3, 2] = normal * gap
    A[:3, 3] = ipp + normal * (pos[0] - z0)
    dd = np.diff(pos)
    S = dict(vol=arr, A=A, Ainv=np.linalg.inv(A), normal=normal, pos=pos, gap=gap,
             uniform=bool(len(dd) == 0 or (dd.max() - dd.min()) < 0.05 * abs(gap)), cache={}, invert=False,
             info=dict(modality='RTDOSE', series='Dose', FoR=str(getattr(d0, 'FrameOfReferenceUID', ''))))
    SEC['dose'] = S
    res = resolve_all().get('dose', {})
    # hottest point, in primary voxel coordinates (for "jump to max")
    k, r, c = np.unravel_index(int(np.argmax(arr)), arr.shape)
    pat = np.linalg.inv(S['T']) @ (A @ np.array([c, r, k, 1.0]))
    vox = np.linalg.inv(P['A']) @ pat
    kk = float(np.interp(P['normal'] @ pat[:3], P['pos'], np.arange(len(P['pos']), dtype=float)))
    # prescription: the plan this dose refers to, else the only plan given
    rx = None
    ref = ''
    try: ref = str(d0.ReferencedRTPlanSequence[0].ReferencedSOPInstanceUID)
    except Exception: pass
    pl = [p for p in plans if str(getattr(p, 'SOPInstanceUID', '')) == ref] or (plans if len(plans) == 1 else [])
    if pl:
        rx = _plan_rx(pl[0])
    W = []
    units = str(getattr(d0, 'DoseUnits', 'GY') or 'GY').upper()
    if units != 'GY':
        W.append(['warn', f'The dose grid is in {units.lower()} units, not Gy: values are shown as relative dose and the '
                          'plan prescription is not used as the reference.'])
        rx = None
    dtype_ = str(getattr(d0, 'DoseType', '') or '').upper()
    if dtype_ == 'ERROR':
        W.append(['warn', 'This RTDOSE is an error/difference dose (DoseType ERROR), not a plan dose.'])
    if not float(arr.max()) > 0:
        W.append(['warn', 'The dose grid is empty (maximum dose is 0).'])
    if plans and not pl:
        W.append(['warn', 'The RTPLAN given does not match this dose, so no prescription was read.'])
    W.extend(_same_patient(dict(patient=str(getattr(d0, 'PatientID', ''))), 'The dose'))
    info = dict(max=float(arr.max()), units=units, type=str(getattr(d0, 'DoseType', '')), warnings=W,
                sum=str(getattr(d0, 'DoseSummationType', '')), nFiles=len(use), dims=list(arr.shape),
                ps=ps, gap=round(gap, 3), status=res.get('status', ''), regNotes=res.get('notes', []), notes=notes,
                maxAt=dict(c=float(vox[0]), r=float(vox[1]), k=kk), rx=rx, memoryMB=round(arr.nbytes / 1e6))
    gc.collect()
    return json.dumps(info)

def dose_plane(view, i):
    a = sec_plane('dose', view, i)
    return np.frombuffer(np.nan_to_num(a, nan=-1.0).astype(np.float32).tobytes(), np.uint8)

def remove_dose():
    SEC.pop('dose', None); gc.collect()
    return 'ok'
`;
const $ = id => document.getElementById(id);
const log = m => { $('log').textContent += '\n' + m; $('log').scrollTop = 1e9; };
// ---------- errors: plain-language message on screen, full details in the technical log ----------
function errText(e) {
  let s = String((e && e.message) || e || 'Unknown error');
  if (/Traceback|PythonError/.test(s)) { const ls = s.trim().split('\n').filter(l => l.trim()); s = ls[ls.length - 1].trim(); }
  if (/^(\w+\.)*UserError: /.test(s)) return s.replace(/^(\w+\.)*UserError: /, '');
  if (/MemoryError|out of memory|Array buffer allocation failed|Cannot allocate|memory access out of bounds|RangeError: (Invalid array length|Array buffer)/i.test(s))
    return 'The browser ran out of memory. Close other tabs, load fewer or smaller extra scans, or use a lower atlas resolution, then try again.';
  if (/Unable to decompress|missing dependencies|pixel data handler|No available image handler/i.test(s))
    return 'These images are compressed in a format TapAtlas cannot decode. Export them uncompressed (Implicit or Explicit VR Little Endian) and try again.';
  const m = s.match(/^(\w*(Error|Exception)): (.*)$/);
  return m ? `${m[3]} (${m[1]}; details in the Log)` : s;
}
function reportError(what, e) {
  log(`ERROR ${what}: ` + ((e && e.message) || e));
  console.error(e);
  toast(`${what}. ${errText(e)}`, 'error');
}
// ---------- data checks (warnings about the loaded data, shown in the side panel) ----------
// scope: 'pri' | 's1'..'s4' | 'dose' | 'reg' | 'folder'; level: 'bad' | 'warn' | 'info'
const checks = {};
function setChecks(scope, list, quiet) {
  const prev = (checks[scope] || []).map(c => c.text).join('|');
  checks[scope] = (list || []).map(([level, text]) => ({level, text}));
  if (typeof renderChecks === 'function') renderChecks();
  const fresh = checks[scope].filter(c => c.level !== 'info');
  if (!quiet && fresh.length && fresh.map(c => c.text).join('|') !== prev) {
    toast(`${fresh.length} thing${fresh.length > 1 ? 's' : ''} to check: see Checks in the side panel.`, 'warn');
    const acc = $('accChecks'); if (acc) acc.classList.remove('closed');
  }
}
function clearChecks() { for (const k of Object.keys(checks)) delete checks[k]; if (typeof renderChecks === 'function') renderChecks(); }
// ---------- orientation labels from the image direction cosines (patient LPS: +x left, +y posterior, +z head) ----------
function dirLetters(v) {
  const L = [['R', 'L'], ['A', 'P'], ['I', 'S']], ax = [0, 1, 2].sort((a, b) => Math.abs(v[b]) - Math.abs(v[a]));
  let s = L[ax[0]][v[ax[0]] > 0 ? 1 : 0];
  if (Math.abs(v[ax[1]]) > 0.25) s += L[ax[1]][v[ax[1]] > 0 ? 1 : 0];     // oblique: second letter
  return s;
}
// [left, right, top, bottom] edge labels of plane p as displayed
function planeLabels(p) {
  const d = meta && meta.dirs;
  if (!d) return p === 'ax' ? ['R', 'L', 'A', 'P'] : p === 'sag' ? ['A', 'P', 'S', 'I'] : ['R', 'L', 'S', 'I'];
  const neg = v => v.map(x => -x), {row, col, normal} = d;
  if (p === 'ax') return [dirLetters(neg(row)), dirLetters(row), dirLetters(neg(col)), dirLetters(col)];
  if (p === 'sag') return [dirLetters(neg(col)), dirLetters(col), dirLetters(normal), dirLetters(neg(normal))];
  return [dirLetters(neg(row)), dirLetters(row), dirLetters(normal), dirLetters(neg(normal))];
}
// ---------- minimal progress overlay + toasts ----------
let busyBatch = false;
function busy(title, frac, txt) {
  $('busy').classList.add('open');
  if (title != null) $('busyTitle').textContent = title;
  const bar = $('busyBar').parentElement;
  bar.classList.toggle('ind', frac == null);
  $('busyBar').style.width = frac == null ? '' : Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
  $('busyTxt').textContent = txt || '';
}
function busyDone(force) { if (!busyBatch || force) $('busy').classList.remove('open'); }
const paint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r)));
// errors stay until closed; other messages fade
function toast(msg, kind, ms) {
  const t = document.createElement('div'); t.className = 'toast ' + (kind || '');
  const tx = document.createElement('span'); tx.textContent = msg; t.appendChild(tx);
  const x = document.createElement('button'); x.className = 'ghost tx'; x.textContent = '×'; x.title = 'Dismiss'; x.setAttribute('aria-label', 'Dismiss');
  x.onclick = () => t.remove(); t.appendChild(x);
  $('toasts').appendChild(t);
  while ($('toasts').children.length > 5) $('toasts').firstChild.remove();
  if (kind !== 'error') setTimeout(() => t.remove(), ms || (kind === 'warn' ? 8000 : 4500));
}
let py, meta = null, rois = [];
let pos = {k: 0, r: 0, c: 0};          // cursor in primary voxel indices (slice, row, col)
let crop = null;                        // {c0,c1,r0,r1,k0,k1} inclusive, primary voxel indices
let lineWidth = 1.5, current = 'pri';
const off = document.createElement('canvas');   // native-resolution plane image (atlas rendering)
const viewImg = {cv: document.createElement('canvas'), key: ''};   // viewer's plane image cache
let imgGen = 0;                         // bumped when scans/registrations change
const SLOT_IDS = ['s1', 's2', 's3', 's4'];
let priName = 'CT';
const scanName = id => id === 'pri' ? (priName || 'CT') : (secs[id] && secs[id].label) || id;
const secs = {};                         // id -> {shown, loaded, label, ww, wl, status}

(async () => {
  try {
    $('engineTxt').textContent = 'Loading the Python engine…';
    // everything is served from this site (vendor/): no third-party code is fetched at run time
    const base = new URL('vendor/pyodide/', location.href).href;
    py = await loadPyodide({indexURL: base});
    $('engineTxt').textContent = 'Installing DICOM tools…';
    log('Pyodide ' + py.version + ' loaded. Installing numpy + pydicom…');
    await py.loadPackage(['numpy', base + 'pydicom-3.0.2-py3-none-any.whl']);
    await py.runPythonAsync(PY);
    log('pydicom ' + py.runPython('pydicom.__version__') + ' ready. Import a patient folder, or choose CT + RTSTRUCT and Load primary.');
    $('go').disabled = false; $('patBtn').disabled = false; $('filesBtn').disabled = false;
    $('engine').textContent = 'Ready'; $('engine').title = 'DICOM engine ready. Files are processed on this computer and never uploaded.'; $('engine').classList.add('ready');
    $('engineRow').style.display = 'none';
  } catch (e) {
    reportError('The DICOM engine failed to load', e);
    $('engineTxt').textContent = 'The DICOM engine failed to load. Reload the page; if it keeps failing, try an up-to-date Chrome, Edge or Firefox.';
    $('engineBar').style.display = 'none'; $('engine').textContent = 'Engine error'; $('engine').classList.add('err');
  }
})();

// Stream files into Python one at a time (each is parsed then deleted) to keep memory low
async function ingestFiles(files, tag, downsample, label) {
  py.globals.get('ingest_begin')(tag, files.length, downsample);
  const ing = py.globals.get('ingest');
  py.FS.mkdirTree('/data');
  const counts = {};
  for (let i = 0; i < files.length; i++) {
    const p = `/data/${tag}_${i}`;
    py.FS.writeFile(p, new Uint8Array(await files[i].arrayBuffer()));
    const m = ing(tag, p);
    counts[m] = (counts[m] || 0) + 1;
    if (i % 20 === 19 || i === files.length - 1) { busy(null, (i + 1) / files.length, `${label || 'Reading'}: ${i + 1} of ${files.length} files`); await paint(); }
  }
  log('  files by type: ' + JSON.stringify(counts));
}
async function writeOne(file, tag) {
  if (!file) return '';
  const p = `/data/${tag}${Date.now()}`;
  py.FS.mkdirTree('/data');
  py.FS.writeFile(p, new Uint8Array(await file.arrayBuffer()));
  return p;
}
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
const unhex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// ---------- primary ----------
// anonymisation: decided when the primary is loaded and then used for every scan, REG and RTSTRUCT
function anonSalt() {
  let s = localStorage.getItem('rtAtlasSalt');
  if (!s) { s = Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); localStorage.setItem('rtAtlasSalt', s); }
  return s;
}
let anonOn = true;
async function loadPrimaryFrom(ctFiles, rsFile) {
  let started = false;
  try {
    if (!ctFiles.length) { toast('Choose the CT images first.', 'error'); return false; }
    busy('Loading planning CT', 0, '');
    started = true;
    anonOn = $('anonChk').checked;
    py.globals.get('set_anon')(anonOn, anonSalt());
    $('anonInfo').textContent = anonOn ? 'Data in this session is anonymised as it is read (names, IDs, dates removed; UIDs remapped).' : 'Not anonymised.';
    const t = performance.now();
    log(`Reading ${ctFiles.length} primary files…`);
    await ingestFiles(ctFiles, 'pri', false, 'Reading CT');
    busy('Loading planning CT', null, rsFile ? 'Building volume and structures…' : 'Building volume…'); await paint();
    const rsPath = await writeOne(rsFile, 'rs');
    const res = JSON.parse(py.globals.get('load')(rsPath));
    meta = res.info;
    rois = res.rois.map(r => ({...r, origName: r.name, visible: true, lw: lineWidth,
      ks: Object.keys(r.slices).map(Number).sort((a, b) => a - b)}));
    log(`Primary parsed in ${((performance.now()-t)/1000).toFixed(1)} s\n` + JSON.stringify({...meta, dirs: meta.dirs, warnings: undefined}));
    clearChecks();
    pos = {k: Math.floor(meta.n / 2), r: Math.floor(meta.rows / 2), c: Math.floor(meta.cols / 2)};
    // planning CT opens in soft tissue (as before); other primaries use the window stored in the images
    priWin = meta.modality === 'CT' ? {ww: 400, wl: 40, mod: 'CT', def: meta.winDefault, sel: 'p:400,40'}
                                    : {ww: meta.autoW, wl: meta.autoL, mod: meta.modality, def: meta.winDefault, sel: 'def'};
    crop = null; current = 'pri';
    notes = []; pruneNoteEls(); noteMode = null; activeNote = null; closeMkMenu(); renderNotesPanel();
    if (typeof dose !== 'undefined' && dose) { py.globals.get('remove_dose')(); dose = null; }
    imgGen++; if (typeof renderDosePanel === 'function') renderDosePanel();
    if (typeof atlas !== 'undefined') atlas = null;
    initSlots();
    buildRoiPanel();
    ['cropAuto', 'cropDraw', 'cropReset', 'addSec', 'atlasBtn'].forEach(id => $(id).disabled = false);
    $('cropRois').disabled = !rois.length;
    cropAuto();                       // CTs come in with a lot of air/couch: crop by default
    if (typeof uiLoaded === 'function') uiLoaded();
    setChecks('pri', meta.warnings, busyBatch);
    busyDone();
    return true;
  } catch (e) {
    busyDone(true);
    reportError('The CT could not be loaded', e);
    // the engine has already discarded the previous patient: return to the start screen rather than
    // leave a viewer showing data that no longer exists
    if (started) resetSession();
    return false;
  }
}
// back to the welcome screen with nothing loaded (after a failed load)
function resetSession() {
  meta = null; rois = []; crop = null; current = 'pri'; atlas = null;
  notes = []; pending = null; noteMode = null; activeNote = null; freeDraw = null; pruneNoteEls(); closeMkMenu();
  if (typeof dose !== 'undefined') dose = null;
  for (const id of SLOT_IDS) secs[id] = {shown: false, loaded: false, label: '', ww: 0, wl: 0, status: ''};
  viewImg.key = ''; imgGen++;
  clearChecks();
  ['cropAuto', 'cropDraw', 'cropReset', 'cropRois', 'addSec', 'atlasBtn'].forEach(id => $(id).disabled = true);
  $('rois').innerHTML = ''; renderNotesPanel(); if (typeof renderDosePanel === 'function') renderDosePanel();
  $('notesLayer').innerHTML = ''; noteEls.clear();
  if (typeof uiReset === 'function') uiReset();
}
$('go').onclick = () => loadPrimaryFrom([...$('ctDir').files, ...$('ctFiles').files], $('rs').files[0]);

// ---------- secondary slots ----------
function initSlots() {
  $('secSlots').innerHTML = SLOT_IDS.map((id, n) => `
    <fieldset class="sec" id="slot_${id}" style="display:none"><legend>Scan ${n + 2} <b id="lab_${id}"></b></legend>
      <div class="frow"><span class="fl">Images</span>
        <span class="pick"><button data-for="dir_${id}">Choose folder…</button><input type="file" id="dir_${id}" webkitdirectory multiple></span><small>or</small>
        <span class="pick"><button data-for="files_${id}">Choose files…</button><input type="file" id="files_${id}" multiple><span class="fn" id="fn_dir_${id}"></span></span></div>
      <div class="frow"><span class="fl">Registration</span>
        <span class="pick"><button data-for="reg_${id}">Choose REG…</button><input type="file" id="reg_${id}"><span class="fn" id="fn_reg_${id}"></span></span>
        <label title="Debug option: apply the registration the other way round"><input type="checkbox" id="inv_${id}"> <small>invert</small></label></div>
      <div class="frow" id="nmw_${id}" style="display:none"><span class="fl">Display name</span><input type="text" id="name_${id}" class="scanName"></div>
      <div class="frow"><span class="fl"></span><button id="load_${id}" class="primary">Load scan</button><button id="rm_${id}">Remove</button><span class="status" id="st_${id}"></span></div>
    </fieldset>`).join('');
  if (typeof wirePickers === 'function') wirePickers($('secSlots'));
  SLOT_IDS.forEach(id => {
    secs[id] = {shown: false, loaded: false, label: '', ww: 0, wl: 0, status: ''};
    $('load_' + id).onclick = () => loadSecondary(id);
    $('rm_' + id).onclick = () => removeSecondary(id);
    $('name_' + id).oninput = e => { secs[id].label = e.target.value; buildImgSel(); draw(); renderNotesPanel(); };
    $('inv_' + id).onchange = e => { if (secs[id].loaded) applyResolve(JSON.parse(py.globals.get('set_invert')(id, e.target.checked))); };
  });
  showSlot('s1');
  buildImgSel();
}
function showSlot(id) { secs[id].shown = true; $('slot_' + id).style.display = ''; $('addSec').disabled = SLOT_IDS.every(i => secs[i].shown); }
$('addSec').onclick = () => { const id = SLOT_IDS.find(i => !secs[i].shown); if (id) showSlot(id); };

async function loadSecondary(id) {
  return loadSecondaryFrom(id, [...$('dir_' + id).files, ...$('files_' + id).files], $('reg_' + id).files[0]);
}
async function loadSecondaryFrom(id, files, regFile) {
  try {
    if (!files.length) { toast('Choose the images for this scan first.', 'error'); return false; }
    busy(`Loading scan ${SLOT_IDS.indexOf(id) + 2}`, 0, '');
    showSlot(id);
    secs[id].loaded = false; if (current === id) current = 'pri'; buildImgSel(); draw();
    const t = performance.now();
    log(`Reading ${files.length} files for ${id}…`);
    await ingestFiles(files, id, true, 'Reading images');
    busy(null, null, 'Resampling and registering…'); await paint();
    const regPath = await writeOne(regFile, 'reg');
    const res = JSON.parse(py.globals.get('load_secondary')(id, regPath, $('inv_' + id).checked));
    const info = res.info;
    log(`${id} parsed in ${((performance.now()-t)/1000).toFixed(1)} s\n` + JSON.stringify(info));
    setChecks(id, (info.warnings || []).map(([l, t]) => [l, `${info.series || info.modality}: ${t}`]), busyBatch);
    const wd = info.winDefault;
    Object.assign(secs[id], {loaded: true, label: info.series || info.modality, ww: info.autoW, wl: info.autoL, mod: info.modality, def: wd,
      sel: wd && wd.ww === info.autoW && wd.wl === info.autoL ? 'def' : (info.modality === 'CT' ? 'p:400,40' : 'custom')});
    $('lab_' + id).textContent = `${info.modality} · ${info.series || ''}`;
    $('name_' + id).value = secs[id].label; $('nmw_' + id).style.display = '';
    applyResolve(res.all);
    current = id; buildImgSel(); draw();
    busyDone();
    return true;
  } catch (e) {
    busyDone(true);
    reportError(`Scan ${SLOT_IDS.indexOf(id) + 2} could not be loaded`, e);
    $('st_' + id).textContent = '✗ ' + errText(e); $('st_' + id).className = 'status bad';
    setChecks(id, [], true);
    // the engine dropped this slot (and its REG): refresh the registration of the other scans
    try { if (meta) applyResolve(JSON.parse(py.globals.get('resolve_json')())); } catch (e2) { log('resolve after failure: ' + e2); }
    return false;
  }
}
function removeSecondary(id) {
  imgGen++; setChecks(id, [], true);
  if (secs[id].loaded) applyResolve(JSON.parse(py.globals.get('remove_secondary')(id)));
  Object.assign(secs[id], {loaded: false, label: '', status: ''});
  $('lab_' + id).textContent = ''; $('st_' + id).textContent = ''; $('nmw_' + id).style.display = 'none';
  const nn = notes.length; notes = notes.filter(n => n.scan !== id);
  if (nn !== notes.length) log(`Removed ${nn - notes.length} note(s) that belonged to that scan.`);
  pruneNoteEls(); renderNotesPanel();
  ['dir_', 'files_', 'reg_'].forEach(p => $(p + id).value = '');
  if (id !== 's1') { secs[id].shown = false; $('slot_' + id).style.display = 'none'; $('addSec').disabled = false; }
  if (current === id) current = 'pri';
  buildImgSel(); draw();
}
// registration status for every loaded scan (adding a REG can link scans loaded earlier)
function applyResolve(all) {
  imgGen++;
  if (typeof doseInvalidate === 'function') { doseInvalidate(); if (all.dose && dose && dose.info) dose.info.status = all.dose.status; }
  for (const id of SLOT_IDS) {
    const st = $('st_' + id), r = all[id];
    if (!r) continue;
    secs[id].status = r.status; secs[id].deformable = !!r.deformable;
    st.textContent = r.status === 'registered' ? '✓ ' + (r.notes.find(n => n.startsWith('Registration path') || n.startsWith('Same')) || 'registered')
                                               : '⚠ not linked to primary – shown unregistered';
    st.className = 'status ' + (r.status === 'registered' ? 'ok' : 'bad');
    log(`${id}: ${r.status}. ${r.notes.join(' ')} T=${JSON.stringify(r.primaryToSecondary)}`);
  }
  const rc = [];
  for (const id of SLOT_IDS) {
    if (!secs[id].loaded || !all[id]) continue;
    if (secs[id].status === 'UNREGISTERED') rc.push(['bad', `${scanName(id)} is not registered to the primary CT (no REG links them), so it is shown unaligned. It is left out of the atlas unless you include it.`]);
    else if (secs[id].deformable) rc.push(['warn', `${scanName(id)} uses a deformable registration: only its rigid part is applied, so alignment may be approximate.`]);
  }
  if (all.dose && all.dose.status === 'UNREGISTERED') rc.push(['bad', 'The dose is in a different frame of reference with no registration: it is shown unaligned.']);
  setChecks('reg', rc, busyBatch);
  buildImgSel(); draw();
}
function loadedIds() { return SLOT_IDS.filter(i => secs[i].loaded); }
function buildImgSel() {
  const opts = [['pri', scanName('pri')], ...loadedIds().map(i => [i, scanName(i) + (secs[i].status === 'UNREGISTERED' ? ' ⚠' : '')])];
  $('imgSel').innerHTML = opts.map(([v, l], n) =>
    `<label><input type="radio" name="img" value="${v}" ${v === current ? 'checked' : ''}> ${n + 1}: ${esc(l)}</label>`).join('');
  document.querySelectorAll('input[name=img]').forEach(r => r.onchange = e => { current = e.target.value; syncWL(); draw(); renderNotesPanel(); });
  syncWL();
}
// ---------- window / level ----------
// Every scan keeps its own window. CT: presets + the window stored in the images + manual.
// MR and others: the stored ("as acquired") window + manual, since fixed presets don't transfer between MR scans.
const CT_PRESETS = [['Soft tissue', 400, 40], ['Lung', 1600, -600], ['Bone', 2000, 300], ['Mediastinum', 350, 40], ['Brain', 80, 40], ['Liver', 150, 60]];
let priWin = {ww: 400, wl: 40, mod: 'CT', def: null, sel: 'p:400,40'};
const winOf = id => id === 'pri' ? priWin : secs[id];
const fmtW = v => +(+v).toFixed(1);
function winOptions(w) {
  const o = [];
  if (w.def) o.push(['def', w.def.src === 'dicom' ? 'Scan default' : 'Scan default (auto)']);
  if (w.mod === 'CT') CT_PRESETS.forEach(([n, a, b]) => o.push([`p:${a},${b}`, n]));
  o.push(['custom', 'Manual']);
  return o;
}
function syncWL() {
  const w = winOf(curWhich()); if (!w) return;
  const opts = winOptions(w);
  if (!opts.some(([v]) => v === w.sel)) w.sel = 'custom';
  $('wl').innerHTML = opts.map(([v, l]) => {
    const t = v === 'def' ? `${fmtW(w.def.ww)} / ${fmtW(w.def.wl)}` : v.startsWith('p:') ? v.slice(2).replace(',', ' / ') : '';
    return `<option value="${v}" ${v === w.sel ? 'selected' : ''}>${l}${t && v === 'def' ? ` (${t})` : ''}</option>`;
  }).join('');
  $('wl').title = `Window ${fmtW(w.ww)} / level ${fmtW(w.wl)}`;
  $('sw').value = fmtW(w.ww); $('sl2').value = fmtW(w.wl);
  $('secWL').style.display = w.sel === 'custom' ? 'inline-flex' : 'none';
}
$('wl').onchange = () => {
  const w = winOf(curWhich()), v = $('wl').value;
  w.sel = v;
  if (v === 'def') { w.ww = w.def.ww; w.wl = w.def.wl; }
  else if (v.startsWith('p:')) [w.ww, w.wl] = v.slice(2).split(',').map(Number);
  syncWL(); draw();
};
$('sw').oninput = () => { const w = winOf(curWhich()); if (+$('sw').value > 0) { w.ww = +$('sw').value; w.sel = 'custom'; draw(); } };
$('sl2').oninput = () => { const w = winOf(curWhich()); w.wl = +$('sl2').value; w.sel = 'custom'; draw(); };
function selectImage(v) { current = v; buildImgSel(); draw(); renderNotesPanel(); }

$('name_pri').oninput = e => { priName = e.target.value; buildImgSel(); draw(); renderNotesPanel(); };

// ---------- notes ----------
// A note belongs to one scan. Its dot is a single 3D point in the primary grid, so it can be shown on
// any plane; the "home" plane is where it was created, and each plane it is shown on keeps its own box.
// pt.c / pt.r: continuous column/row (pixel-edge based, like the canvas); pt.k: continuous slice index.
let notes = [], noteSeq = 1, noteMode = null, pending = null, suppressClick = 0;
let view2css = null;                    // {g, kx, ky}: native px -> css px for the current draw
const noteEls = new Map();              // note id -> DOM element
const PLANE_NAME = {ax: 'Axial', sag: 'Sagittal', cor: 'Coronal'};
const PLANE_SHORT = {ax: 'Ax', sag: 'Sag', cor: 'Cor'};
const curWhich = () => secs[current] && secs[current].loaded ? current : 'pri';

function noteIdx(n, p) { return p === 'ax' ? Math.round(n.pt.k) : p === 'sag' ? Math.floor(n.pt.c) : Math.floor(n.pt.r); }
function noteAnchor(n, p) {
  const yk = (meta.n - 1 - n.pt.k) + 0.5;
  return p === 'ax' ? {x: n.pt.c, y: n.pt.r} : p === 'sag' ? {x: n.pt.r, y: yk} : {x: n.pt.c, y: yk};
}
function setNoteAnchor(n, p, a) {      // move the dot within plane p (the third coordinate is kept)
  const k = (meta.n - 1) - (a.y - 0.5);
  if (p === 'ax') { n.pt.c = a.x; n.pt.r = a.y; }
  else if (p === 'sag') { n.pt.r = a.x; n.pt.k = k; }
  else { n.pt.c = a.x; n.pt.k = k; }
}
function noteShown(n, p, idx, which) { return n.scan === which && n.views[p] && n.views[p].on && noteIdx(n, p) === idx; }
function defaultNoteBox(n, p) {
  const a = noteAnchor(n, p), g = planeGeom(p);
  return {x: a.x + g.cw * 0.08, y: a.y - g.ch * 0.08};
}
function setNoteView(n, p, on) {
  if (!on && Object.entries(n.views).filter(([q, v]) => v.on && q !== p).length === 0) return false;   // keep at least one
  if (!n.views[p]) n.views[p] = {on, box: defaultNoteBox(n, p), mk: inheritMk(n, p)};
  n.views[p].on = on;
  return true;
}

// ---------- note markers: dot, arrow, circle/ellipse, free draw ----------
// Stored per plane in n.views[p].mk, in native plane pixels relative to the note's anchor point:
// ellipse {rx, ry}; free {pts: [[dx, dy], ...], closed}.
const MK_TYPES = [['dot', '\u25CF Dot'], ['arrow', '\u27A4 Arrow'], ['ellipse', '\u25EF Circle / ellipse'], ['free', '\u270E Free draw']];
let activeNote = null, freeDraw = null, mkMenuFor = null;
const noteMk = (n, p) => (n.views[p] && n.views[p].mk) || {type: 'dot'};
function mkRadiusMm(n, q) {                // rough size of a marker in mm (to carry it to another plane)
  const mk = noteMk(n, q), g = planeGeom(q);
  if (mk.type === 'ellipse') return (mk.rx * g.psx + mk.ry * g.psy) / 2;
  if (mk.type === 'free' && mk.pts && mk.pts.length) return mk.pts.reduce((a, [u, v]) => a + Math.hypot(u * g.psx, v * g.psy), 0) / mk.pts.length;
  return 8;
}
function circleMk(p, rMm) { const g = planeGeom(p); return {type: 'ellipse', rx: rMm / g.psx, ry: rMm / g.psy}; }
function inheritMk(n, p) {
  const h = noteMk(n, n.home);
  if (h.type === 'ellipse' || h.type === 'free') return circleMk(p, mkRadiusMm(n, n.home));
  return {type: h.type};
}
// Marker geometry on a canvas. T: {X, Y, sx, sy} native -> canvas; box {l, t, w, h} in canvas px.
// Returns the anchor (ax, ay), the leader line (from s to b) and shape data in canvas px.
function noteMarkerGeom(n, p, T, box) {
  const mk = noteMk(n, p), an = noteAnchor(n, p), ax = T.X(an.x), ay = T.Y(an.y);
  const clampB = (x, y) => [Math.max(box.l, Math.min(box.l + box.w, x)), Math.max(box.t, Math.min(box.t + box.h, y))];
  let [bx, by] = clampB(ax, ay), sx = ax, sy = ay, line = true;
  const o = {type: mk.type, ax, ay};
  if (mk.type === 'ellipse') {
    o.rx = Math.max(1, mk.rx * T.sx); o.ry = Math.max(1, mk.ry * T.sy);
    const dx = bx - ax, dy = by - ay, q = Math.hypot(dx / o.rx, dy / o.ry);
    if (q <= 1) line = false; else { sx = ax + dx / q; sy = ay + dy / q; }
  } else if (mk.type === 'free' && mk.pts && mk.pts.length) {
    o.pts = mk.pts.map(([u, v]) => [T.X(an.x + u), T.Y(an.y + v)]); o.closed = !!mk.closed;
    let best = Infinity;
    for (const [x, y] of o.pts) { const d = (x - bx) ** 2 + (y - by) ** 2; if (d < best) { best = d; sx = x; sy = y; } }
    [bx, by] = clampB(sx, sy);
  }
  if (Math.hypot(bx - sx, by - sy) < 0.5) line = false;
  return Object.assign(o, {line, sx, sy, bx, by});
}
// k: canvas px per CSS px (line widths); handles: draw edit handles (viewer only)
function drawNoteMarker(ctx, n, p, T, box, k, handles) {
  const o = noteMarkerGeom(n, p, T, box), Y = '#ffd400';
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  if (o.line) { ctx.strokeStyle = Y; ctx.lineWidth = 1.5 * k; ctx.beginPath(); ctx.moveTo(o.sx, o.sy); ctx.lineTo(o.bx, o.by); ctx.stroke(); }
  const twoTone = path => {        // dark halo under the yellow line so it shows on any background
    ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 3.6 * k; path(); ctx.stroke();
    ctx.strokeStyle = Y; ctx.lineWidth = 2 * k; path(); ctx.stroke();
  };
  if (o.type === 'ellipse') twoTone(() => { ctx.beginPath(); ctx.ellipse(o.ax, o.ay, o.rx, o.ry, 0, 0, 2 * Math.PI); });
  else if (o.type === 'free' && o.pts) twoTone(() => { ctx.beginPath(); o.pts.forEach(([x, y], j) => j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); if (o.closed) ctx.closePath(); });
  else if (o.type === 'arrow') {
    let dx = o.ax - o.bx, dy = o.ay - o.by, L = Math.hypot(dx, dy);
    if (L < 1) { dx = 1; dy = 1; L = Math.SQRT2; }
    dx /= L; dy /= L;
    const len = 12 * k, wd = 5 * k, bx = o.ax - dx * len, by = o.ay - dy * len;
    ctx.beginPath(); ctx.moveTo(o.ax, o.ay); ctx.lineTo(bx - dy * wd, by + dx * wd); ctx.lineTo(bx + dy * wd, by - dx * wd); ctx.closePath();
    ctx.fillStyle = Y; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 0.8 * k; ctx.stroke();
  } else {
    ctx.fillStyle = Y; ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * k;
    ctx.beginPath(); ctx.arc(o.ax, o.ay, 4 * k, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
  }
  if (handles && (o.type === 'ellipse' || o.type === 'free')) {
    const hs = [[o.ax, o.ay]];
    if (o.type === 'ellipse') hs.push([o.ax + o.rx, o.ay], [o.ax, o.ay - o.ry]);
    ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1 * k;
    for (const [x, y] of hs) { ctx.fillRect(x - 3.5 * k, y - 3.5 * k, 7 * k, 7 * k); ctx.strokeRect(x - 3.5 * k, y - 3.5 * k, 7 * k, 7 * k); }
  }
  ctx.restore();
  return o;
}
// what is under the mouse (CSS px) for note n on the viewer: 'rx' | 'ry' | 'move' | null
function hitMarker(n, p, mx, my) {
  const {g, kx, ky} = view2css, el = noteEls.get(n.id);
  const T = {X: x => (x - g.x0) * kx, Y: y => (y - g.y0) * ky, sx: kx, sy: ky};
  const box = el ? {l: el.offsetLeft, t: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight} : {l: 0, t: 0, w: 0, h: 0};
  const o = noteMarkerGeom(n, p, T, box), near = (x, y, r) => Math.hypot(x - mx, y - my) < r;
  if (o.type === 'ellipse') {
    if (n === activeNote && near(o.ax + o.rx, o.ay, 7)) return 'rx';
    if (n === activeNote && near(o.ax, o.ay - o.ry, 7)) return 'ry';
    const q = Math.hypot((mx - o.ax) / o.rx, (my - o.ay) / o.ry);
    if (near(o.ax, o.ay, 8) || Math.abs(q - 1) * Math.min(o.rx, o.ry) < 6) return 'move';
    return null;
  }
  if (o.type === 'free' && o.pts) {
    if (near(o.ax, o.ay, 8)) return 'move';
    const P = o.pts, m = P.length, segs = o.closed ? m : m - 1;
    for (let j = 0; j < segs; j++) {
      const [x1, y1] = P[j], [x2, y2] = P[(j + 1) % m], dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((mx - x1) * dx + (my - y1) * dy) / L2));
      if (near(x1 + t * dx, y1 + t * dy, 6)) return 'move';
    }
    return null;
  }
  return near(o.ax, o.ay, 9) ? 'move' : null;
}
// small menu next to the marker
function openMkMenu(n, p, cssX, cssY) {
  closeMkMenu();
  activeNote = n; mkMenuFor = {n, p};
  const m = document.createElement('div'); m.id = 'mkMenu';
  const cur = noteMk(n, p).type;
  m.innerHTML = `<div class="mh">Marker (${PLANE_NAME[p]})</div>` + MK_TYPES.map(([t, l]) => `<div class="mi ${t === cur ? 'on' : ''}" data-t="${t}">${l}</div>`).join('') +
    (cur === 'ellipse' ? '<div class="mhint">Drag the white squares to resize, the outline to move.</div>' : cur === 'free' ? '<div class="mhint">Drag the outline to move it.</div>' : '');
  m.style.left = (cssX + 12) + 'px'; m.style.top = (cssY + 6) + 'px';
  m.addEventListener('mousedown', e => e.stopPropagation());
  m.querySelectorAll('.mi').forEach(d => d.onclick = () => {
    const t = d.dataset.t, v = n.views[p];
    if (t === 'free') { closeMkMenu(); startFreeDraw(n, p); return; }
    if (t === 'ellipse') v.mk = cur === 'ellipse' ? v.mk : circleMk(p, cur === 'free' ? mkRadiusMm(n, p) : 8);
    else v.mk = {type: t};
    closeMkMenu(); activeNote = n; draw();
  });
  $('stage').appendChild(m);
}
function closeMkMenu() { const m = $('mkMenu'); if (m) m.remove(); mkMenuFor = null; }
function startFreeDraw(n, p) {
  freeDraw = {n, p, pts: null}; activeNote = n;
  $('cv').classList.add('drawing');
  toast('Free draw: drag on the image to draw the outline. Esc cancels.');
}
function endFreeDraw() { freeDraw = null; $('cv').classList.remove('drawing'); }

function toNativeF(e) {                 // continuous native-plane coords (pixel-edge based)
  const g = planeGeom(radio('plane')), rect = $('cv').getBoundingClientRect();
  return {x: g.x0 + (e.clientX - rect.left) / rect.width * g.cw, y: g.y0 + (e.clientY - rect.top) / rect.height * g.ch};
}
function setNoteMode(on) {
  noteMode = on ? 'anchor' : null;
  $('addNote').classList.toggle('on', on);
  $('addNote').textContent = on ? 'Click the point on the image…' : '+ Add note';
  $('cv').classList.toggle('placing', on);
}
function cancelNote() {
  if (pending) { notes = notes.filter(n => n !== pending); pending = null; pruneNoteEls(); }
  setNoteMode(false); draw(); renderNotesPanel();
}
// returns true if the click was consumed by note placement
function noteClick(e) {
  const p = radio('plane');
  if (noteMode === 'anchor') {
    const a = toNativeF(e), g = planeGeom(p);
    const n = {id: noteSeq++, scan: curWhich(), home: p, pt: {c: 0, r: 0, k: 0}, text: '', views: {}};
    if (p === 'ax') n.pt.k = g.idx; else if (p === 'sag') n.pt.c = g.idx + 0.5; else n.pt.r = g.idx + 0.5;
    setNoteAnchor(n, p, a);
    n.views[p] = {on: true, box: defaultNoteBox(n, p), mk: {type: 'dot'}};
    pending = n; notes.push(n); noteMode = 'box';
    $('addNote').textContent = 'Now click where the text box goes…';
    draw(); return true;
  }
  if (noteMode === 'box') {
    pending.views[p].box = toNativeF(e);
    const n = pending; pending = null; setNoteMode(false); draw(); renderNotesPanel();
    const el = noteEls.get(n.id); if (el) focusEnd(el.querySelector('.txt'));
    return true;
  }
  return false;
}
function noteEl(n) {
  let el = noteEls.get(n.id);
  if (el) return el;
  el = document.createElement('div'); el.className = 'note';
  el.innerHTML = `<div class="ntools">Show on: ${['ax', 'sag', 'cor'].map(p =>
      `<label><input type="checkbox" data-p="${p}">${PLANE_SHORT[p]}</label>`).join('')}</div>
    <div class="txt" spellcheck="true"></div><span class="del" title="Delete note">×</span>`;
  const tx = el.querySelector('.txt');
  try { tx.contentEditable = 'plaintext-only'; } catch (_) { tx.contentEditable = 'true'; }
  if (tx.contentEditable !== 'plaintext-only') tx.contentEditable = 'true';
  tx.innerText = n.text;
  tx.addEventListener('input', () => { n.text = tx.innerText.replace(/\n$/, ''); renderNotesPanel(); draw(); });
  tx.addEventListener('focus', () => el.classList.add('editing'));
  tx.addEventListener('blur', () => setTimeout(() => { if (!el.contains(document.activeElement)) el.classList.remove('editing'); }, 0));
  new ResizeObserver(() => { if (!dragNote) draw(); }).observe(el);
  const tools = el.querySelector('.ntools');
  tools.addEventListener('mousedown', e => e.stopPropagation());
  tools.querySelectorAll('input').forEach(cb => cb.onchange = () => {
    if (!setNoteView(n, cb.dataset.p, cb.checked)) cb.checked = true;
    renderNotesPanel(); draw();
  });
  el.querySelector('.del').addEventListener('mousedown', e => e.stopPropagation());
  el.querySelector('.del').onclick = () => { notes = notes.filter(x => x !== n); if (pending === n) { pending = null; setNoteMode(false); } pruneNoteEls(); draw(); renderNotesPanel(); };
  // drag the box itself to move it; a click without movement starts editing
  el.addEventListener('mousedown', e => {
    if (el.classList.contains('editing') && e.target === tx) return;   // while editing, allow text selection
    e.preventDefault();
    const v = n.views[radio('plane')]; closeMkMenu();
    dragNote = {n, what: 'box', v, x: e.clientX, y: e.clientY, bx: v.box.x, by: v.box.y, moved: false, el: tx};
  });
  $('notesLayer').appendChild(el); noteEls.set(n.id, el);
  return el;
}
function focusEnd(tx) {
  tx.focus();
  const r = document.createRange(); r.selectNodeContents(tx); r.collapse(false);
  const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
}
function pruneNoteEls() {
  if (activeNote && !notes.includes(activeNote)) { activeNote = null; closeMkMenu(); }
  const ids = new Set(notes.map(n => n.id));
  for (const [id, el] of noteEls) if (!ids.has(id)) { el.remove(); noteEls.delete(id); }
}
function renderNotes(p, g, which, ctx, cssW, cssH, dpr) {
  const layer = $('notesLayer');
  layer.style.width = cssW + 'px'; layer.style.height = cssH + 'px';
  const kx = cssW / g.cw, ky = cssH / g.ch;
  view2css = {g, kx, ky};
  const here = notes.filter(n => noteShown(n, p, g.idx, which));
  for (const n of notes) { const el = noteEls.get(n.id); if (el && !here.includes(n)) el.style.display = 'none'; }
  for (const n of here) {
    const el = noteEl(n), v = n.views[p];
    el.querySelectorAll('.ntools input').forEach(cb => cb.checked = !!(n.views[cb.dataset.p] && n.views[cb.dataset.p].on));
    el.style.display = '';
    el.style.pointerEvents = n === pending ? 'none' : '';   // let clicks reach the canvas while placing
    el.style.left = ((v.box.x - g.x0) * kx) + 'px'; el.style.top = ((v.box.y - g.y0) * ky) + 'px';
    // remember the box geometry in image units so the PDF/PPT can reproduce it at any zoom
    v.bw = el.offsetWidth / kx; v.bh = el.offsetHeight / ky; v.fs = 12 / kx; v.padX = 6 / kx; v.padY = 3 / ky;
    const an = noteAnchor(n, p), ax = (an.x - g.x0) * kx, ay = (an.y - g.y0) * ky;
    let l = el.offsetLeft, t = el.offsetTop; const w = el.offsetWidth, h = el.offsetHeight;
    const lc = Math.max(0, Math.min(cssW - w, l)), tc = Math.max(0, Math.min(cssH - h, t));   // keep inside the image
    if (lc !== l || tc !== t) {
      l = lc; t = tc; el.style.left = l + 'px'; el.style.top = t + 'px';
      if (!dragNote || dragNote.n !== n) v.box = {x: g.x0 + l / kx, y: g.y0 + t / ky};
    }
    const T = {X: x => (x - g.x0) * kx * dpr, Y: y => (y - g.y0) * ky * dpr, sx: kx * dpr, sy: ky * dpr};
    drawNoteMarker(ctx, n, p, T, {l: l * dpr, t: t * dpr, w: w * dpr, h: h * dpr}, dpr, n === activeNote);
  }
}
function renderNotesPanel() {
  const el = $('notesPanel'); if (!el) return;
  if (!meta) { el.innerHTML = ''; return; }
  const p = radio('plane'), g = planeGeom(p), which = curWhich();
  const sorted = [...notes].sort((a, b) => a.scan.localeCompare(b.scan) || a.home.localeCompare(b.home) || noteIdx(a, a.home) - noteIdx(b, b.home));
  const nHere = notes.filter(n => noteShown(n, p, g.idx, which)).length;
  if ($('cntNotes')) $('cntNotes').textContent = notes.length ? `${notes.length} · ${nHere} here` : '';
  el.innerHTML = `<button id="addNote" class="primary">+ Add note</button>
    <small class="nhint">Click the point, then where the text goes. Click a box to edit it and tick the planes it shows on. Click a marker to change it to an arrow, circle/ellipse or free drawing. Esc finishes.</small>
    <div class="nl">${sorted.map(n => {
      const planes = ['ax', 'sag', 'cor'].filter(q => n.views[q] && n.views[q].on).map(q => `<a class="njp" data-p="${q}" title="Go to it on ${PLANE_NAME[q]}">${PLANE_SHORT[q]}</a>`).join(' ');
      return `<div class="ni ${noteShown(n, p, g.idx, which) ? 'here' : ''}" data-id="${n.id}"><span class="nm">${esc(scanName(n.scan))} · ${PLANE_NAME[n.home]} ${noteIdx(n, n.home) + 1} · ${planes}</span><span class="nt">${esc((n.text || '(empty)').slice(0, 80))}</span></div>`;
    }).join('')}</div>`;
  $('addNote').onclick = () => { if (noteMode) cancelNote(); else setNoteMode(true); };
  if (noteMode) { $('addNote').classList.add('on'); $('addNote').textContent = noteMode === 'anchor' ? 'Click the point on the image…' : 'Now click where the text box goes…'; }
  el.querySelectorAll('.ni').forEach(d => d.onclick = (e) => { const j = e.target.closest('.njp'); jumpToNote(notes.find(n => n.id === +d.dataset.id), j ? j.dataset.p : undefined); });
}
function jumpToNote(n, plane) {
  if (!n) return;
  if (n.scan !== 'pri' && !(secs[n.scan] && secs[n.scan].loaded)) return;
  const p = plane || n.home, idx = noteIdx(n, p);
  current = n.scan; setRadio('plane', p); setIdx(p, idx);
  const c = crop || fullCrop();
  const inside = p === 'ax' ? idx >= c.k0 && idx <= c.k1 : p === 'sag' ? idx >= c.c0 && idx <= c.c1 : idx >= c.r0 && idx <= c.r1;
  if (!inside) setCrop(fullCrop(), 'Full (note was outside crop)');
  buildImgSel(); syncSlider(); draw(); renderNotesPanel();
}
// drag a note's box, its marker (move / resize), free drawing; click on a marker opens its menu
let dragNote = null;
$('cv').addEventListener('mousedown', e => {
  if (!meta || cropMode || noteMode || !view2css) return;
  const rect = $('cv').getBoundingClientRect(), mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const p = radio('plane'), which = curWhich(), {g} = view2css;
  if (freeDraw) {
    if (freeDraw.p !== p) { endFreeDraw(); return; }
    e.preventDefault(); freeDraw.pts = [toNativeF(e)]; return;
  }
  closeMkMenu();
  const here = notes.filter(n => noteShown(n, p, g.idx, which));
  // the active note first, so its handles win
  here.sort((a, b) => (b === activeNote) - (a === activeNote));
  for (const n of here) {
    const h = hitMarker(n, p, mx, my);
    if (!h) continue;
    e.preventDefault();
    dragNote = {n, what: h, p, x: e.clientX, y: e.clientY, mx, my, start: toNativeF(e), a0: noteAnchor(n, p), moved: false};
    return;
  }
});
window.addEventListener('mousemove', e => {
  if (noteMode === 'box' && pending && e.target === $('cv')) { pending.views[radio('plane')].box = toNativeF(e); draw(); return; }
  if (freeDraw && freeDraw.pts) {
    const a = toNativeF(e), l = freeDraw.pts[freeDraw.pts.length - 1], {kx, ky} = view2css;
    if (Math.hypot((a.x - l.x) * kx, (a.y - l.y) * ky) >= 2) { freeDraw.pts.push(a); drawFreePreview(); }
    return;
  }
  if (!dragNote || !view2css) return;
  const {kx, ky} = view2css, d = dragNote;
  if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
  d.moved = true;
  if (d.what === 'box') d.v.box = {x: d.bx + (e.clientX - d.x) / kx, y: d.by + (e.clientY - d.y) / ky};
  else {
    const a = toNativeF(e), mk = noteMk(d.n, d.p);
    if (d.what === 'rx') mk.rx = Math.max(1, Math.abs(a.x - d.a0.x));
    else if (d.what === 'ry') mk.ry = Math.max(1, Math.abs(a.y - d.a0.y));
    else setNoteAnchor(d.n, d.p, {x: d.a0.x + a.x - d.start.x, y: d.a0.y + a.y - d.start.y});
  }
  draw();
});
window.addEventListener('mouseup', e => {
  if (freeDraw && freeDraw.pts) { finishFreeDraw(); return; }
  if (!dragNote) return;
  const d = dragNote; dragNote = null;
  if (d.what === 'box') { activeNote = d.n; if (!d.moved) { focusEnd(d.el); return; } draw(); return; }
  suppressClick = performance.now();
  activeNote = d.n;
  if (!d.moved) openMkMenu(d.n, d.p, d.mx, d.my);
  renderNotesPanel(); draw();
});
function drawFreePreview() {
  draw();
  const {g, kx, ky} = view2css, ctx = $('cv').getContext('2d'), dpr = window.devicePixelRatio || 1;
  ctx.save(); ctx.strokeStyle = '#ffd400'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = ctx.lineCap = 'round';
  ctx.beginPath(); freeDraw.pts.forEach((a, j) => { const x = (a.x - g.x0) * kx * dpr, y = (a.y - g.y0) * ky * dpr; j ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke(); ctx.restore();
}
function finishFreeDraw() {
  const {n, p, pts} = freeDraw; endFreeDraw(); suppressClick = performance.now();
  if (pts.length < 3) { draw(); return; }
  const {kx, ky} = view2css;
  let cx = 0, cy = 0; pts.forEach(a => { cx += a.x; cy += a.y; }); cx /= pts.length; cy /= pts.length;
  const closed = Math.hypot((pts[0].x - pts[pts.length - 1].x) * kx, (pts[0].y - pts[pts.length - 1].y) * ky) < 15;
  // thin out to at most ~150 points
  const step = Math.max(1, Math.ceil(pts.length / 150));
  const keep = pts.filter((_, j) => j % step === 0 || j === pts.length - 1);
  setNoteAnchor(n, p, {x: cx, y: cy});
  const an = noteAnchor(n, p);
  n.views[p].mk = {type: 'free', closed, pts: keep.map(a => [+(a.x - an.x).toFixed(2), +(a.y - an.y).toFixed(2)])};
  activeNote = n; renderNotesPanel(); draw();
}

// ---------- structure panel ----------
function buildRoiPanel() {
  const el = $('rois');
  if (!rois.length) { el.innerHTML = '<small>No structure set loaded.</small>'; return; }
  el.innerHTML = `<div class="rtools"><button id="allOn">Show all</button><button id="allOff">Hide all</button>
    <span class="lwall" title="Set the line width of every structure">Width, all <input type="range" id="lw" min="0.5" max="5" step="0.5" value="${lineWidth}" style="width:70px"> <span id="lwv">${lineWidth}</span></span></div>
    <table>${rois.map((r, i) => `<tr>
      <td><input type="checkbox" data-i="${i}" class="vis" ${r.visible ? 'checked' : ''}></td>
      <td><input type="color" data-i="${i}" class="col" value="${hex(r.color)}"></td>
      <td><input type="text" data-i="${i}" class="nm" value="${esc(r.name)}" title="Original: ${esc(r.origName)}"></td>
      <td><input type="number" data-i="${i}" class="lwi" min="0.5" max="6" step="0.5" value="${r.lw ?? lineWidth}" title="Line width"></td>
      <td><button data-i="${i}" class="go" title="Go to this structure (${r.nContours} contours)">&#8982;</button></td></tr>`).join('')}</table>
    <small>Click a name to rename it for the atlas. The number sets its line width.</small>`;
  el.querySelectorAll('.vis').forEach(x => x.onchange = e => { rois[+e.target.dataset.i].visible = e.target.checked; draw(); });
  el.querySelectorAll('.col').forEach(x => x.oninput = e => { rois[+e.target.dataset.i].color = unhex(e.target.value); draw(); });
  el.querySelectorAll('.nm').forEach(x => x.oninput = e => {
    const r = rois[+e.target.dataset.i]; r.name = e.target.value;
    e.target.classList.toggle('renamed', r.name !== r.origName);
  });
  el.querySelectorAll('.go').forEach(x => x.onclick = e => {
    const r = rois[+e.target.dataset.i]; if (!r.ks.length) return;
    const k = r.ks[Math.floor(r.ks.length / 2)];
    const pts = r.slices[k].flat(); let sx = 0, sy = 0;
    for (let j = 0; j < pts.length; j += 2) { sx += pts[j]; sy += pts[j + 1]; }
    pos = {k, c: Math.round(sx / (pts.length / 2)), r: Math.round(sy / (pts.length / 2))};
    clampPos(); syncSlider(); draw();
  });
  $('allOn').onclick = () => setAll(true); $('allOff').onclick = () => setAll(false);
  $('lw').oninput = e => { lineWidth = +e.target.value; $('lwv').textContent = lineWidth; rois.forEach(r => r.lw = lineWidth); el.querySelectorAll('.lwi').forEach(x => x.value = lineWidth); draw(); };
  el.querySelectorAll('.lwi').forEach(x => x.oninput = e => { const v = +e.target.value; if (v > 0) { rois[+e.target.dataset.i].lw = v; draw(); } });
}
function setAll(v) { rois.forEach(r => r.visible = v); $('rois').querySelectorAll('.vis').forEach(x => x.checked = v); draw(); }

// ---------- crop ----------
const fullCrop = () => ({c0: 0, c1: meta.cols - 1, r0: 0, r1: meta.rows - 1, k0: 0, k1: meta.n - 1});
function setCrop(c, why) {
  const f = fullCrop();
  crop = {c0: Math.max(f.c0, Math.min(c.c0, c.c1)), c1: Math.min(f.c1, Math.max(c.c0, c.c1)),
          r0: Math.max(f.r0, Math.min(c.r0, c.r1)), r1: Math.min(f.r1, Math.max(c.r0, c.r1)),
          k0: Math.max(f.k0, Math.min(c.k0, c.k1)), k1: Math.min(f.k1, Math.max(c.k0, c.k1))};
  const mm = (a, b, s) => ((b - a + 1) * s).toFixed(0);
  $('cropInfo').textContent = `${why}: ${mm(crop.c0, crop.c1, meta.ps[1])} × ${mm(crop.r0, crop.r1, meta.ps[0])} × ${mm(crop.k0, crop.k1, Math.abs(meta.sliceGap))} mm (R-L × A-P × S-I)`;
  $('cropInfo').className = 'status ok';
  clampPos(); syncSlider(); draw();
}
function cropAuto() {
  setCrop(JSON.parse(py.globals.get('auto_crop')(+$('cropMargin').value)), 'Body');
}
$('cropAuto').onclick = cropAuto;
$('cropReset').onclick = () => setCrop(fullCrop(), 'Full');
$('cropRois').onclick = () => {
  const vis = rois.filter(r => r.visible && r.ks.length);
  if (!vis.length) return toast('No visible structures to crop to.', 'error');
  let c0 = 1e9, c1 = -1e9, r0 = 1e9, r1 = -1e9, k0 = 1e9, k1 = -1e9;
  for (const r of vis) for (const k of r.ks) {
    k0 = Math.min(k0, k); k1 = Math.max(k1, k);
    for (const poly of r.slices[k]) for (let j = 0; j < poly.length; j += 2) {
      c0 = Math.min(c0, poly[j]); c1 = Math.max(c1, poly[j]); r0 = Math.min(r0, poly[j + 1]); r1 = Math.max(r1, poly[j + 1]);
    }
  }
  const m = +$('cropMargin').value, gap = Math.abs(meta.sliceGap) || 1;
  setCrop({c0: Math.floor(c0 - m / meta.ps[1]), c1: Math.ceil(c1 + m / meta.ps[1]),
           r0: Math.floor(r0 - m / meta.ps[0]), r1: Math.ceil(r1 + m / meta.ps[0]),
           k0: Math.floor(k0 - m / gap), k1: Math.ceil(k1 + m / gap)}, 'Visible structures');
};
let cropMode = false, drag = null;
$('cropDraw').onclick = () => { cropMode = !cropMode; $('cv').classList.toggle('cropping', cropMode);
  $('cropDraw').textContent = cropMode ? 'Drag on image…' : 'Draw box'; };
function clampPos() {
  if (!crop) return;
  pos.k = Math.max(crop.k0, Math.min(crop.k1, pos.k));
  pos.r = Math.max(crop.r0, Math.min(crop.r1, pos.r));
  pos.c = Math.max(crop.c0, Math.min(crop.c1, pos.c));
}

// ---------- planes ----------
const radio = n => document.querySelector(`input[name=${n}]:checked`).value;
const setRadio = (n, v) => { document.querySelector(`input[name=${n}][value=${v}]`).checked = true; };

// native plane size, crop window within it (native px), physical size of the window, slider range
function planeGeom(p) {
  const {n, rows, cols, ps} = meta, gap = Math.abs(meta.sliceGap) || 1, c = crop || fullCrop();
  const yk0 = (n - 1) - c.k1, yk1 = (n - 1) - c.k0;
  let g;
  if (p === 'ax')       g = {w: cols, h: rows, x0: c.c0, x1: c.c1, y0: c.r0, y1: c.r1, psx: ps[1], psy: ps[0], min: c.k0, max: c.k1, idx: pos.k};
  else if (p === 'sag') g = {w: rows, h: n, x0: c.r0, x1: c.r1, y0: yk0, y1: yk1, psx: ps[0], psy: gap, min: c.c0, max: c.c1, idx: pos.c};
  else                  g = {w: cols, h: n, x0: c.c0, x1: c.c1, y0: yk0, y1: yk1, psx: ps[1], psy: gap, min: c.r0, max: c.r1, idx: pos.r};
  g.cw = g.x1 - g.x0 + 1; g.ch = g.y1 - g.y0 + 1; g.mmW = g.cw * g.psx; g.mmH = g.ch * g.psy;
  return g;
}
function setIdx(p, v) { if (p === 'ax') pos.k = v; else if (p === 'sag') pos.c = v; else pos.r = v; }
function syncSlider() {
  if (!meta) return;
  setTimeout(renderNotesPanel);
  const g = planeGeom(radio('plane'));
  $('slice').min = g.min; $('slice').max = g.max; $('slice').value = g.idx;
}

// Structure outline in a sagittal/coronal plane. Each axial contour is cut by the plane line, giving
// spans (inside intervals) on that slice. Default: the spans fill one slice row each and the outline is
// traced from that mask (a staircase: each contour stands for its whole slice). Smoothed: spans that
// overlap on neighbouring slices are joined by linear interpolation between the slice centres (at most
// half a slice spacing head-foot from the staircase); spans with no overlapping partner, and the first and
// last contoured slices, keep their square half-slice ends, so separate pieces are never bridged.
let smoothOutlines = false;
const SMOOTH_SUB = 4;                      // sub-rows per slice for the smoothed outline
function sliceSpans(r, p, L) {
  const out = new Map();                   // slice k -> [[a, b], ...] sorted, in plane pixel-centre coords
  for (const k of r.ks) {
    const xs = [];
    for (const poly of r.slices[k]) {
      const m = poly.length;
      for (let j = 0; j < m; j += 2) {
        const ax = poly[j], ay = poly[j + 1], bx = poly[(j + 2) % m], by = poly[(j + 3) % m];
        const [u0, v0, u1, v1] = p === 'sag' ? [ax, ay, bx, by] : [ay, ax, by, bx];
        if ((u0 <= L) !== (u1 <= L)) xs.push(v0 + (L - u0) / (u1 - u0) * (v1 - v0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const sp = [];
    for (let j = 0; j + 1 < xs.length; j += 2) sp.push([xs[j], xs[j + 1]]);
    out.set(k, sp);
  }
  return out;
}
function reslicedOutline(r, p, idx, g) {
  if (!r.ks.length) return null;
  const key = `${p}|${idx}|${g.w}|${smoothOutlines ? 1 : 0}`;
  const cache = r._oc || (r._oc = new Map());
  if (cache.has(key)) return cache.get(key);
  const res = smoothOutlines ? smoothOutline(r, p, idx, g) : stairOutline(r, p, idx, g);
  if (cache.size > 120) cache.clear();
  cache.set(key, res);
  return res;
}
function stairOutline(r, p, idx, g) {
  const n = meta.n, W = g.w;
  const kmin = r.ks[0], kmax = r.ks[r.ks.length - 1];
  const y0 = (n - 1) - kmax, y1 = (n - 1) - kmin;
  const bh = y1 - y0 + 3;
  const grid = new Float32Array(W * bh);
  let any = false;
  for (const [k, sp] of sliceSpans(r, p, idx)) {
    const row = ((n - 1) - k) - y0 + 1;
    for (const [xa, xb] of sp) {
      const a = Math.max(0, Math.ceil(xa)), b = Math.min(W - 1, Math.floor(xb));
      for (let x = a; x <= b; x++) { grid[row * W + x] = 1; any = true; }
    }
  }
  if (!any) return null;
  const mp = d3.contours().size([W, bh]).thresholds([0.5])(grid)[0];
  return {mp, yoff: y0 - 1};
}
function smoothOutline(r, p, idx, g) {
  const n = meta.n, S = SMOOTH_SUB, spans = sliceSpans(r, p, idx);
  if (!spans.size) return null;
  let xmin = Infinity, xmax = -Infinity;
  for (const sp of spans.values()) for (const [a, b] of sp) { xmin = Math.min(xmin, a); xmax = Math.max(xmax, b); }
  const kmin = Math.min(...spans.keys()), kmax = Math.max(...spans.keys());
  const x0 = Math.floor(xmin) - 2, W = Math.ceil(xmax) - x0 + 3;          // grid columns: plane x = x0 + col
  const y0 = (n - 1) - kmax - 1, H = (kmax - kmin + 3) * S;               // grid rows: plane y = y0 + row / S
  const grid = new Float32Array(W * H);
  const overlaps = (s, u) => s[0] <= u[1] && u[0] <= s[1];
  for (let row = 0; row < H; row++) {
    // continuous slice position of this sub-row's centre (slice k's centre sits at plane y = n - 1 - k + 0.5)
    const kc = n - 0.5 - (y0 + (row + 0.5) / S);
    const klo = Math.floor(kc), t = kc - klo;
    const A = spans.get(klo) || [], B = spans.get(klo + 1) || [];
    const cur = [];
    for (const s of A) {
      const part = B.filter(u => overlaps(s, u));
      if (part.length) for (const u of part) cur.push([s[0] + (u[0] - s[0]) * t, s[1] + (u[1] - s[1]) * t]);
      else if (t < 0.5) cur.push(s);                 // no partner above: square half-slice end
    }
    for (const u of B) if (t >= 0.5 && !A.some(s => overlaps(s, u))) cur.push(u);   // no partner below
    for (const [a, b] of cur) {
      const ca = Math.max(0, Math.floor(a - x0 - 0.5)), cb = Math.min(W - 1, Math.ceil(b - x0 + 0.5));
      for (let c = ca; c <= cb; c++) {
        const x = x0 + c, v = Math.min(b, x + 0.5) - Math.max(a, x - 0.5);   // fraction of the pixel inside
        if (v > grid[row * W + c]) grid[row * W + c] = Math.min(1, v);
      }
    }
  }
  const mp = d3.contours().size([W, H]).thresholds([0.5])(grid)[0];
  if (!mp.coordinates.length) return null;
  // grid -> plane pixel-edge coordinates (same convention as the staircase outline, with yoff = 0)
  for (const poly of mp.coordinates) for (const ring of poly) for (const pt of ring) { pt[0] = pt[0] + x0; pt[1] = y0 + pt[1] / S; }
  return {mp, yoff: 0};
}

function draw(overlay) {
  if (!meta) return;
  const p = radio('plane'), g = planeGeom(p);
  const which = secs[current] && secs[current].loaded ? current : 'pri';
  const {ww, wl} = winOf(which);
  $('smoothWrap').style.display = p === 'ax' ? 'none' : '';
  const ikey = `${imgGen}|${p}|${g.idx}|${ww}|${wl}|${which}|${g.w}x${g.h}`;
  if (viewImg.key !== ikey) {          // only ask Python for a new plane when something changed
    const proxy = py.globals.get('plane_rgba')(p, g.idx, ww, wl, which);
    const buf = proxy.toJs(); proxy.destroy();
    viewImg.cv.width = g.w; viewImg.cv.height = g.h;
    viewImg.cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(buf.buffer, buf.byteOffset, buf.length), g.w, g.h), 0, 0);
    viewImg.key = ikey;
  }

  const dpr = window.devicePixelRatio || 1;
  const vp = $('viewport'), maxW = Math.max(200, vp.clientWidth - 24), maxH = Math.max(200, vp.clientHeight - 24);
  const scale = Math.min(maxW / g.mmW, maxH / g.mmH);
  const cssW = Math.round(g.mmW * scale), cssH = Math.round(g.mmH * scale);
  const cv = $('cv');
  cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
  cv.width = cssW * dpr; cv.height = cssH * dpr;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(viewImg.cv, g.x0, g.y0, g.cw, g.ch, 0, 0, cv.width, cv.height);
  const sx = cv.width / g.cw, sy = cv.height / g.ch;
  if (typeof drawDose === 'function') drawDose(ctx, p, g.idx, g, sx, sy, dpr);
  const X = x => (x - g.x0 + .5) * sx, Y = y => (y - g.y0 + .5) * sy;   // pixel-centre coords -> canvas
  ctx.lineWidth = lineWidth * dpr; ctx.lineJoin = 'round';

  for (const r of rois) {
    if (!r.visible) continue;
    ctx.strokeStyle = `rgb(${r.color})`; ctx.lineWidth = (r.lw ?? lineWidth) * dpr;
    if (p === 'ax') {
      const cs = r.slices[pos.k]; if (!cs) continue;
      for (const c of cs) {
        ctx.beginPath(); ctx.moveTo(X(c[0]), Y(c[1]));
        for (let k = 2; k < c.length; k += 2) ctx.lineTo(X(c[k]), Y(c[k + 1]));
        ctx.closePath(); ctx.stroke();
      }
    } else {
      const o = reslicedOutline(r, p, g.idx, g); if (!o) continue;
      ctx.beginPath();
      for (const poly of o.mp.coordinates) for (const ring of poly) {   // d3 grid coords are cell-edge based
        ring.forEach(([x, y], j) => { const cx = (x - g.x0) * sx, cy = (y + o.yoff - g.y0) * sy; j ? ctx.lineTo(cx, cy) : ctx.moveTo(cx, cy); });
        ctx.closePath();
      }
      ctx.stroke();
    }
  }

  if ($('xhair').checked) {
    const n = meta.n;
    const [cx, cy] = p === 'ax' ? [pos.c, pos.r] : p === 'sag' ? [pos.r, (n - 1) - pos.k] : [pos.c, (n - 1) - pos.k];
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,0,.45)'; ctx.lineWidth = dpr; ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath(); ctx.moveTo(X(cx), 0); ctx.lineTo(X(cx), cv.height);
    ctx.moveTo(0, Y(cy)); ctx.lineTo(cv.width, Y(cy)); ctx.stroke(); ctx.restore();
  }
  if (overlay) {   // crop box being dragged
    ctx.save(); ctx.strokeStyle = '#0ff'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.strokeRect(X(Math.min(overlay.x0, overlay.x1)) - sx / 2, Y(Math.min(overlay.y0, overlay.y1)) - sy / 2,
                   (Math.abs(overlay.x1 - overlay.x0) + 1) * sx, (Math.abs(overlay.y1 - overlay.y0) + 1) * sy);
    ctx.restore();
  }
  renderNotes(p, g, which, ctx, cssW, cssH, dpr);
  if (typeof drawDoseKey === 'function') drawDoseKey(ctx, cv, dpr);
  ctx.fillStyle = '#ff0'; ctx.font = `${12 * dpr}px system-ui`;
  const names = {ax: 'AXIAL', sag: 'SAGITTAL', cor: 'CORONAL'};
  const regTxt = which === 'pri' ? ' (primary)' : secs[which].status === 'UNREGISTERED' ? ' — NOT REGISTERED' : secs[which].deformable ? ' (rigid part of deformable REG)' : ' (registered)';
  if (which !== 'pri' && secs[which].status === 'UNREGISTERED') ctx.fillStyle = '#ff6b6b';
  ctx.fillText(`${names[p]} · ${scanName(which)}${regTxt}`, 6 * dpr, 16 * dpr);
  ctx.fillStyle = '#ff0';
  const lab = planeLabels(p);
  ctx.textAlign = 'left'; ctx.fillText(lab[0], 6 * dpr, cv.height / 2);
  ctx.textAlign = 'right'; ctx.fillText(lab[1], cv.width - 6 * dpr, cv.height / 2);
  ctx.textAlign = 'center'; ctx.fillText(lab[2], cv.width / 2, 30 * dpr); ctx.fillText(lab[3], cv.width / 2, cv.height - 6 * dpr);
  ctx.textAlign = 'left';
  $('sl').textContent = `${g.idx - g.min + 1} / ${g.max - g.min + 1}`;
}

// canvas position -> native plane pixel
function toNative(e) {
  const g = planeGeom(radio('plane')), rect = $('cv').getBoundingClientRect();
  const x = g.x0 + Math.floor((e.clientX - rect.left) / rect.width * g.cw);
  const y = g.y0 + Math.floor((e.clientY - rect.top) / rect.height * g.ch);
  return [Math.max(g.x0, Math.min(g.x1, x)), Math.max(g.y0, Math.min(g.y1, y))];
}
$('cv').addEventListener('mousedown', e => {
  if (!meta || !cropMode) return;
  const [x, y] = toNative(e); drag = {x0: x, y0: y, x1: x, y1: y};
});
$('cv').addEventListener('mousemove', e => {
  if (!drag) return;
  [drag.x1, drag.y1] = toNative(e); draw(drag);
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  const d = drag; drag = null; cropMode = false; $('cv').classList.remove('cropping'); $('cropDraw').textContent = 'Draw box';
  if (Math.abs(d.x1 - d.x0) < 4 || Math.abs(d.y1 - d.y0) < 4) return draw();
  const p = radio('plane'), n = meta.n, c = {...(crop || fullCrop())};
  const xa = Math.min(d.x0, d.x1), xb = Math.max(d.x0, d.x1), ya = Math.min(d.y0, d.y1), yb = Math.max(d.y0, d.y1);
  if (p === 'ax') Object.assign(c, {c0: xa, c1: xb, r0: ya, r1: yb});
  else if (p === 'sag') Object.assign(c, {r0: xa, r1: xb, k0: (n - 1) - yb, k1: (n - 1) - ya});
  else Object.assign(c, {c0: xa, c1: xb, k0: (n - 1) - yb, k1: (n - 1) - ya});
  setCrop(c, 'Drawn');
});
// click = move the crosshair
$('cv').addEventListener('click', e => {
  if (!meta || cropMode) return;
  if (suppressClick) { const recent = performance.now() - suppressClick < 400; suppressClick = 0; if (recent) return; }
  if (noteClick(e)) return;
  if (activeNote || mkMenuFor) { activeNote = null; closeMkMenu(); }
  const p = radio('plane'), [x, y] = toNative(e), k = (meta.n - 1) - y;
  if (p === 'ax') { pos.c = x; pos.r = y; }
  else if (p === 'sag') { pos.r = x; pos.k = k; }
  else { pos.c = x; pos.k = k; }
  draw();
});
$('slice').oninput = e => { setIdx(radio('plane'), +e.target.value); draw(); renderNotesPanel(); };
$('xhair').onchange = () => draw();
$('smooth').onchange = e => { smoothOutlines = e.target.checked; draw(); };
document.querySelectorAll('input[name=plane]').forEach(r => r.onchange = () => { syncSlider(); draw(); });
window.addEventListener('resize', () => draw());
document.addEventListener('keydown', e => {
  if ((e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) && e.key === 'Escape') { e.target.blur(); return; }
  if (e.target.isContentEditable || e.target.tagName === 'TEXTAREA' || (e.target.tagName === 'INPUT' && (e.target.type === 'text' || e.target.type === 'number'))) return;
  if (e.key === 'Escape') { if (freeDraw) { endFreeDraw(); draw(); return; } if (mkMenuFor || activeNote) { closeMkMenu(); activeNote = null; draw(); return; } cancelNote(); return; }
  if (!meta) return;
  const k = e.key.toLowerCase(), ids = ['pri', ...loadedIds()];
  if (k === 't' && ids.length > 1) selectImage(ids[(ids.indexOf(current) + 1) % ids.length]);
  if (/^[1-5]$/.test(k) && ids[+k - 1]) selectImage(ids[+k - 1]);
  if (k === 'a' || k === 's' || k === 'c') { setRadio('plane', {a: 'ax', s: 'sag', c: 'cor'}[k]); syncSlider(); draw(); }
});
$('cv').addEventListener('wheel', e => {
  e.preventDefault(); if (!meta) return;
  const p = radio('plane'), g = planeGeom(p);
  // axial: scrolling down moves head -> toe (slice index increases towards the head)
  const headUp = p === 'ax' && meta.dirs && meta.dirs.normal[2] > 0.5;
  const step = (e.deltaY > 0 ? 1 : -1) * (headUp ? -1 : 1);
  setIdx(p, Math.max(g.min, Math.min(g.max, g.idx + step)));
  syncSlider(); draw();
}, {passive: false});
