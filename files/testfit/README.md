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
- **The solver connects its own rows.** A cross-aisle at one end (or both, for a
  full loop) joins every row and runs a spur out to your entrance — without it
  the rows are parallel islands you cannot drive between, which is exactly what
  the drivability check reported the day it was built. It costs stalls, and that
  is the point: the old higher number was for a site you could not drive into.
- **Options** — single-loaded rows, dead-end turnarounds (which now draw the
  hammerhead in the space they reserve), and an alignment toggle that squares
  the rows to the longest site edge.
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
- **Three ways to draw a road.** As a *line* — click points, and the width
  follows the type. As an **object** — one click drops a rectangle you then size
  by its width and length fields, stretch by an end grip and turn by a grip
  beside it; stalls snap along it because it carries a real centreline. Or as
  **multipoint** — click points for a free-form surface.
- **Surface materials** — asphalt, concrete, pavers, gravel, sand or grass. The
  material decides the colour *and* how much of the area counts as hard: a
  runoff coefficient rather than a paved/unpaved flag, so half-hard can be said
  without inventing a third category. Leave it unset and nothing changes.
- **Snapping is a switch** (`S`). On, points land on existing vertices and
  stalls tuck against a road or their neighbours. Off means off: things go
  exactly where you click, with no fallback grid.
- **Belgian/EU road markings and signage** — arrows, shark's teeth, stop lines,
  hatched zones, speed numerals, ground pictograms, and plate-on-a-post signs
  (B1, B5, C1, C43, E9a, F19, accessible, EV).
- **Junctions.** Where two drawn ways meet — crossing, or one ending on the
  other's kerb — the app asks what that place is: a junction, a junction with an
  interruption, or not linked. Undecided crossings are marked in red until you
  answer, and **double-clicking one reopens the choice**, so a decision is never
  final. For an interruption you click the arm you want closed, on the plan, and
  the bollards stand at the **mouth** of that arm, flush with the kerb of the
  road it meets. A junction behaves as one object — one row in the object list,
  and dragging one arm moves the whole network.
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

### Does the plan work?

- **Pick a design vehicle** — car, van, rigid truck or fire appliance — and the
  app lists the **knelpunten**: bends it cannot take, dead ends with no room to
  turn and no room to reverse out, stalls it cannot reach at all, and facades
  too far from where a fire appliance can stand. Each row is clickable and
  highlights the place it is about.
- Junction decisions gate the network: a junction joins, "not linked" does not,
  and bollards sever the arm they cross. Walkways and cycle paths are surfaces
  but not drivable, and the check knows the difference.
- The turning check is **circular swept width** — the closed-form first pass
  every design manual uses. It does not model the transition into a bend,
  articulated vehicles, reversing, or corner-cutting, and it says so.
- Every vehicle dimension is an editable constant. They are common design
  values, **not a verified norm citation** — parking and fire-access figures
  differ per municipality and per fire zone.
- The lighting model treats each luminaire as a point source radiating evenly
  into the lower hemisphere. That is the first-pass hand calculation, **not
  photometry**: a real design reads an IES intensity distribution per luminaire.
  The lux and uniformity targets are common design values, not a norm citation.
- The solar model is a clear-sky shape calibrated onto two published climate
  numbers — annual irradiation and annual diffuse fraction — because a cloudless
  year overstates the total and, worse, gets the beam/diffuse split wrong, which
  is what sets the gain from tilting. There is no weather year and no
  temperature or soiling model beyond a single performance ratio.
- **Accessible stalls land near an entrance** when the plan has one (an access
  point, else a driveway, else the nearest corner of the largest building). With
  none, placement is unchanged.

### Views and output

- **Basemaps** — plan on top of **OpenStreetMap**, **satellite**, or **hybrid**
  imagery. Search an address (OSM Nominatim) and the site is placed there; the
  tiles stay aligned with the site geometry.
- **3D (Mapbox)** — switch to 3D and the plan is draped over the map with real
  buildings around it. Your own buildings and the parking bays are extruded,
  each separately toggleable. Needs your **own Mapbox public token** (`pk.…`),
  which is only ever stored in your browser.
- **Everything you draw is in 3D**, not just the big shapes: road markings and
  pictograms lie flat on the tarmac at their real size and their own heading,
  signs stand on a post, zebra crossings keep their bars, hatched zones keep
  their stripes, and a cycle path stays red instead of dissolving into asphalt.
  Switching basemap style keeps the camera where you left it.
- **Sun and shadow** — set a date and a time and the sun really moves: the 3D
  light takes the computed position, and a 2D layer draws the ground shadows and
  counts how many stalls stand in one. The clock is mean solar time for the
  site's longitude, so no summer time — the panel says so.
- **How much light lands here** — one heat map, two sources. Switch it to
  *artificial* and lamp posts you place light the plan: horizontal illuminance
  on a grid, average and minimum over the **parking surface** (not the parcel —
  the setback strip is unlit by design and would peg uniformity at zero), the
  U₀ ratio against a target, and the darkest stall as a row you can click.
  Switch it to *sun* and the same grid shows annual irradiation, with your own
  buildings taking their bite out of it.
- **Solar carports** — roof over the rows and the app reports kWp, kWh per year,
  specific yield and the shading loss your own buildings cost. Buildings block
  the canopy only where they rise above it. A carport adds **no** impervious
  area: it stands over paving that is already counted.
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
- **Drawing library** (`T`) — the whole catalogue as browsable cards, each with a
  one-line description and a thumbnail painted by the app's own drawing code, so
  a preview can never show something the plan would not draw. Grouped by
  category, searchable, with a separate tab for your own imported symbols.
- **The plan has a name**, editable in the top bar; it becomes the filename when
  you save, and the bar says when you last did.
- **A shareable link.** There is no server, so the plan travels inside the URL:
  gzip plus base64url puts the demo plan in about 860 characters and a plan with
  thirty hand-placed stalls in about 1 800. Delen copies the link and updates the
  address bar; opening one restores the plan *and* the camera through the same
  code path a saved file takes. Imported symbols do not travel — a single 512 px
  PNG would be longer than the plan — so they and the objects placed with them
  are dropped and the confirmation says how many; send the JSON file for those.
- **Fold either panel away** from a chevron in the panel itself, and back from a
  tab on the canvas edge where it was. Same state the Weergave menu and saved
  workspaces use, so the three cannot disagree.
- **One toolbar row**, in the design's order: the named tools, the measure icon,
  the library as the single accent button, then a spacer and the view cluster
  (row axis, 2D/3D, Fit, Weergave, undo/redo, plan, export, help). Everything
  that reads or writes a file sits in one Plan menu — save, load, parcel import,
  the shareable link, a new empty site. The row-axis reset only appears once you
  have moved off the default. Icon buttons all carry a title and an `aria-label`.
- **Each right-panel section folds on its own**, with a search at the top of the
  panel that keeps only the sections that match. The search covers words people
  would type rather than the heading again: "schaduw" finds *Zon en schaduw* and
  "regenwater" finds the runoff figure, which no heading mentions. A hit is shown
  open — a result you still have to unfold is not a result.
- **Name any object in the list.** The pencil on a row turns it into a field; the
  name is written onto the record, so it travels with save, undo and a shared
  link, and the object search matches it. An aisle is derived, so its name goes
  in the position-keyed override where its other manual decisions live. Clear the
  field and the type name comes back. Solver stall groups are a *type* rather
  than an object and are deliberately not renameable.
- **The left panel holds what you are working in**: the active tool's options,
  with one line saying what the tool is for and the snapping switch, and the
  object list. Locatie, Lagen and the dimension preset moved into the Weergave
  menu — they answer "what am I looking at", not "what am I drawing", and in the
  panel they pushed the other two below the fold. The tool palette and the asset
  importer are off by default, both being fully covered by the library; they stay
  switchable, since typing a name in the side list is still the fastest route
  once you know it.
- Undo/redo, save/load, layers, and hideable/resizable UI parts you can save as
  a workspace.

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
├── styles.css            # Nocturne tokens + the CAD-like UI on top of them
├── tools/stamp.js        # rewrites ?v=<hash> on every import (run before commit)
├── vendor/               # React 18, ReactDOM, htm (UMD + ESM shims)
└── src/
    ├── geometry.js       # pure 2D polygon geometry (offset, clip, hit tests)
    ├── solver.js         # parking solver + accessible-stall table + metrics
    ├── solver.worker.js  # the solver off the main thread
    ├── drive.js          # design vehicles + the drivability check (pure)
    ├── sun.js            # solar position + ground shadows (pure)
    ├── light.js          # illuminance, annual irradiance, PV yield (pure)
    ├── pictos.js         # the unit-box painters: markings, pictograms, signage
    ├── annots.js         # the annotation type catalogue
    ├── buildings.js      # deterministic building exteriors per use
    ├── basemap.js        # slippy-map tiles (OSM/Esri) + geocoding + geo↔metres
    ├── map3d.js          # Mapbox drape: extrusions, textures, markings, lighting
    ├── importers.js      # GeoJSON/KML parcel rings + simplification
    ├── exporters.js      # GeoJSON, DXF, CSV
    ├── share.js          # a plan in a URL: gzip + base64url (pure)
    ├── build.js          # the build stamp the app checks itself against
    └── app.js            # React UI (htm) + imperative canvas rendering
```

Map tiles (OpenStreetMap, Esri World Imagery) and geocoding (Nominatim) are the
only outbound requests; without a network the rest keeps working.

`geometry.js`, `solver.js`, `drive.js`, `sun.js`, `light.js` and `share.js` are
dependency-free, pure ES modules and can be tested on their own with Node — the
last three deliberately so, since a geometric check, an almanac and a light
calculation all deserve assertions that need no browser. It pays: the tilt gain
in the PV model was wrong by a factor of three until the tests compared it
against the optimum tilt for the latitude, which is a fact and not an opinion.

## Keyboard

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `V` | Select | `G` | Grid on/off |
| `P` | Draw site | `M` | Measure |
| `B` | Draw building | `N` | Draw building (polygon) |
| `Del` | Delete selection | `Esc` | Cancel |
| `K` | Place stall | `/` | Focus the tool search |
| `R` / `Shift+R` | Rotate in 15° steps | `?` | Shortcut list |
| `S` | Snapping on/off | `T` | Drawing library |
| `Ctrl/⌘+Z` / `+Shift` | Undo / Redo | | |
| `Space` | Pan (hold) | `Ctrl/⌘+D` | Duplicate |
| `Ctrl/⌘+C` / `+V` | Copy / Paste | `?` | Shortcut list |

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

The impervious figure is a plain sum of surfaces with **no overlap subtracted**,
so a road drawn across a drive aisle is counted twice and the percentage
saturates early on a busy plan. Doing better needs boolean polygon clipping,
which this project deliberately does not carry.

An educational demonstrator; not affiliated with TestFit. Parking dimensions and
accessible-stall counts vary by jurisdiction — every value is configurable.
