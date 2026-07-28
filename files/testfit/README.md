# 🅿️ ParkPlanner — a TestFit-style parking planner in React

An open-source, in-browser **surface-parking planner**: draw a site boundary,
drop in buildings and exclusion zones, and a solver lays out parking stalls,
drive aisles and live metrics — inspired by TestFit's *Parking Solver*.

**Live:** `/files/testfit/` (e.g. https://vandenostende.github.io/files/testfit/)

Everything runs client-side. There is no backend, no build step, and no bundler.

## What it does

### Site and solver

- **Draw a site** with the polygon tool: draggable vertices, a live area
  readout, and smooth (spline) boundaries if you want the parking to follow a
  curve.
- **Import a real parcel** from GeoJSON or KML — the ring is anchored at its
  centroid, converted to local metres and simplified.
- **Buildings and exclusion zones** as rectangles or free polygons; the solver
  works around them.
- **Automatic parking generation**, recomputed live, with a **web-worker**
  solve (and an inline fallback) so big sites never freeze the UI.
- **Layouts**: straight rows, edge+middle, or concentric rings that follow the
  site's curves.
- **Parameters** — stall width and depth, aisle width, angle (45/60/90°),
  setback, padding buffer, and a maximum row length that inserts planter gaps.
- **Options** — single-loaded rows, dead-end turnarounds, and an alignment
  toggle that squares the rows to the longest site edge.
- **Presets** — US standard, US SUV, EU metric, compact.

### Editing what the solver produced

- **Mark stalls** — click one, or drag a marquee over many, and tag them EV,
  accessible, staff, visitor, reserved, compact or motorcycle.
- **One-way aisles** — select an aisle, make it one-way, and direction arrows
  appear on it (with a reverse button). Generated aisles can also be deleted.
- **Pin/lock** stalls and aisles so they survive "clear marks" and re-solves.
- **Place stalls by hand** (`K`) — they snap to existing stalls and to roads;
  delete solver stalls and they stay gone across re-solves.
- Every manual mark is keyed on its **position**, not on an array index, so it
  survives the layout being recomputed underneath it.

### Infrastructure you draw yourself

- Roads, driveways, drive-thrus, walkways, cycle paths, crosswalks, bike
  parking (with capacity), grass, trees, and free-hand markings.
- **Roads are surfaces, not strokes**: square ends, mitred corners, and the
  line you draw can be the centreline *or* a kerb. Walkways and cycle paths
  work the same way. They merge into one seamless tarmac surface together with
  the solver's own aisles.
- **Belgian/EU road markings and signage** — arrows, shark's teeth, stop lines,
  hatched zones, speed numerals, ground pictograms, and plate-on-a-post signs
  (B1, B5, C1, C43, E9a, F19, accessible, EV).
- **Junctions.** Where two drawn ways cross, the app asks what that place is: a
  junction, a junction with an interruption (bollards across the arm you name),
  or not linked. Undecided crossings are marked in red until you answer.
  A junction behaves as one object — one row in the object list, and dragging
  one arm moves the whole network.
- **Alt-drag** takes everything standing on a road (signs, markings, stalls)
  along with it; there is a sticky toggle if you want that to be the default.
- Ways **snap** to existing vertices, can be **closed** into a square or plaza,
  and show live dimensions while you draw.

### Buildings

- Pick a **use** — retail, residential or office — and a full exterior design is
  generated: row houses with front and back gardens, a retail shed with canopy
  and loading dock, or an office with a set-back top floor and a forecourt.
- **Facade materials** — brick, concrete, wood, render, metal or glass, drawn as
  real textures on the 3D walls.
- Storeys per building, with floor heights that follow the use.

### Views and output

- **Basemaps** — plan on top of **OpenStreetMap**, **satellite**, or **hybrid**
  imagery. Search an address (OSM Nominatim) and the site is placed there; the
  tiles stay aligned with the site geometry.
- **3D (Mapbox)** — switch to 3D and the plan is draped over the map with real
  buildings around it. Your own buildings and the parking bays are extruded,
  each separately toggleable. Needs your **own Mapbox public token** (`pk.…`),
  which is only ever stored in your browser.
- **2.5D** — a tilted read-only view that needs no token.
- **Metrics** — stall count, site area, built %, m²/stall, impervious %, FAR,
  per-type counts, an automatic accessible-stall table (2010 ADA Standards,
  Table 208.2 plus the 1-in-6 van rule), and a programme/parking-ratio panel
  (GLA → required stalls).
- **Export** to PNG, JSON, GeoJSON, DXF (CAD) and CSV (takeoff).
- **Import your own symbols** — drop in a PNG or SVG, give it a real-world size
  and height, and it becomes a placeable symbol that shows up in the palette,
  the object list, copy/paste, the exporters and (extruded) the 3D view.
- **Object list** with search: everything you placed, grouped, selectable and
  deletable from one panel.
- Undo/redo, save/load, layers, light and dark themes, and hideable/resizable
  UI parts you can save as a workspace.

## The solver pipeline

A mirror of the publicly documented approach used by surface-parking solvers:

1. **Buildable** = `offset(site, −setback)` minus buildings and exclusions
   (with the padding buffer applied).
2. **Orientations** = every site-edge direction and its perpendicular.
3. Per orientation: rotate into an aligned frame, tile **double-loaded modules**
   (stall + aisle + stall), and "shape" every usable spot into a stall, testing
   containment against the buildable polygon and the obstacles. The maximum row
   length inserts planter gaps.
4. Keep the orientation with the **most stalls**.

## Architecture

Deliberately **no build tooling** — it has to work as a plain folder on GitHub
Pages. React, ReactDOM and `htm` are vendored locally in `vendor/` as classic
UMD scripts and imported through small ESM shims using **relative paths**: no
import map, no runtime CDN. That means the app boots on older browsers too (ES
modules are enough), with an error overlay if anything does go wrong.

```
files/testfit/
├── index.html            # vendored <script> tags + boot error overlay
├── styles.css            # dark/light CAD-like UI
├── tools/stamp.js        # rewrites ?v=<hash> on every import (run before commit)
├── vendor/               # React 18, ReactDOM, htm (UMD + ESM shims)
└── src/
    ├── geometry.js       # pure 2D polygon geometry (offset, clip, hit tests)
    ├── solver.js         # parking solver + accessible-stall table + metrics
    ├── solver.worker.js  # the solver off the main thread
    ├── annots.js         # the annotation type catalogue
    ├── buildings.js      # deterministic building exteriors per use
    ├── basemap.js        # slippy-map tiles (OSM/Esri) + geocoding + geo↔metres
    ├── map3d.js          # Mapbox drape: extrusions, facade textures, lighting
    ├── importers.js      # GeoJSON/KML parcel rings + simplification
    ├── exporters.js      # GeoJSON, DXF, CSV
    ├── build.js          # the build stamp the app checks itself against
    └── app.js            # React UI (htm) + imperative canvas rendering
```

Map tiles (OpenStreetMap, Esri World Imagery) and geocoding (Nominatim) are the
only outbound requests; without a network the rest keeps working.

`geometry.js` and `solver.js` are dependency-free, pure ES modules and can be
tested on their own with Node.

## Keyboard

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `V` | Select | `G` | Grid on/off |
| `P` | Draw site | `M` | Measure |
| `B` | Draw building | `N` | Draw building (polygon) |
| `Del` | Delete selection | `Esc` | Cancel |
| `K` | Place stall | `/` | Focus the tool search |
| `R` / `Shift+R` | Rotate in 15° steps | `?` | Shortcut list |
| `Space` | Pan (hold) | `Ctrl/⌘+Z` / `+Shift` | Undo / Redo |
| `Ctrl/⌘+D` | Duplicate | `Ctrl/⌘+C` / `+V` | Copy / Paste |

Scroll to zoom. Pan by dragging with the right mouse button, the middle button,
`Space` held down, or the Pan tool. On a trackpad, a two-finger swipe pans and
pinch zooms. Hold `Alt` while dragging a road to take its furniture with it.

## Development

There is nothing to install. Serve the folder and open it:

```sh
python3 -m http.server 8199        # from files/testfit/
```

`src/*.js` are imported with a `?v=<hash>` query so a stale browser cache can
never serve a half-updated app. **Run `node tools/stamp.js` before every
commit** — it rewrites those hashes, and the running app compares its own stamp
against the live one and offers a reload when it falls behind.

## Roadmap

Multi-level structured/garage parking (tray counts), generative variants, and
PDF/Revit/glTF export.

---

An educational demonstrator; not affiliated with TestFit. Parking dimensions and
accessible-stall counts vary by jurisdiction — every value is configurable.
