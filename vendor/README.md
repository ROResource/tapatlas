# Vendored libraries

TapAtlas serves every script it runs from this site, so it keeps working where CDNs are blocked and the
Content-Security-Policy in `index.html` can stop the page contacting anywhere else (`connect-src 'self'`).
The only third-party request left is the General Sans web font (styling only).

| File | Version | Source | Licence |
|---|---|---|---|
| `pyodide/` (pyodide.js, pyodide.asm.js/.wasm, python_stdlib.zip, pyodide-lock.json) | 0.29.0 | npm `pyodide@0.29.0` | MPL-2.0 |
| `pyodide/numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl` | 2.2.5 | cdn.jsdelivr.net/pyodide/v0.29.0/full | BSD-3-Clause |
| `pyodide/pydicom-3.0.2-py3-none-any.whl` | 3.0.2 | PyPI | MIT |
| `d3.min.js` | 7.9.2 | npm `d3` | ISC |
| `jspdf.umd.min.js` | 2.5.2 | npm `jspdf` | MIT |
| `pptxgen.bundle.js` | 3.12.0 | npm `pptxgenjs` | MIT |
| `fonts/LiberationSans-*-subset.ttf` | 2.x, subset to Latin, Greek, arrows, maths and shapes | Liberation Sans | SIL OFL 1.1 (`fonts/OFL.txt`) |

To update a library, replace the file here and change the version in this table (and, for pydicom, the
wheel name in `app.js`).
