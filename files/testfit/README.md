# 🅿️ ParkPlanner — een TestFit-kloon in React

Een open-source, in-browser **parkeerplanner**: teken een site-grens, plaats
gebouwen/uitsluitingszones, en de solver genereert live parkeervakken,
rijstroken en metrics — geïnspireerd op TestFit's *Parking Solver*.

**Live:** `/files/testfit/` (bijv. https://vandenostende.github.io/files/testfit/)

## Wat het doet

- **Site tekenen** — polygoon-tool met sleepbare hoekpunten en numerieke oppervlakte.
- **Gebouwen / uitsluitingszones** — sleep rechthoeken die de solver respecteert.
- **Automatische parkeergeneratie** — dubbel-belaste modules, live herberekend.
- **Parameters** — vakbreedte/-diepte, rijstrookbreedte, hoek (45/60/90°),
  setback, padding-buffer en max. rijlengte (planter-gaps).
- **Vaktypes** — standaard, compact, EV en ADA, met automatische ADA-tabel
  (2010 ADA Standards, Tabel 208.2 + 1-op-6 van-regel).
- **Rij-as wisselen** — cyclet door de gevonden oriëntaties (meeste vakken eerst).
- **Metrics** — totaal vakken, site-oppervlak, bebouwd %, m²/vak, per-type telling.
- **Lagen, undo/redo, opslaan/laden (JSON) en PNG-export.**
- **Presets** — VS-standaard, VS-SUV, EU-metrisch, compact.

## De solver-pijplijn

Mirror van de publiek gedocumenteerde aanpak van surface-parking solvers:

1. **Buildable** = `offset(site, −setback)` minus gebouwen/uitsluitingen
   (met padding-buffer).
2. **Oriëntaties** = elke site-rand-richting én de loodrechte daarvan.
3. Per oriëntatie: roteer naar een uitgelijnd assenstelsel, **tegel
   dubbel-belaste modules** (vak + rijstrook + vak) en "vorm" elke bruikbare
   plek tot een vak, met containment-tests tegen de buildable-polygoon en de
   obstakels. Max. rijlengte plaatst planter-gaps.
4. Kies de oriëntatie met de **meeste vakken**.

Alles draait client-side; er is geen backend en geen build-stap nodig.

## Architectuur

Bewust **geen build-tooling** (past bij deze GitHub Pages-site). React, ReactDOM
en `htm` zijn lokaal gevendord in `vendor/` en via een import-map gekoppeld, dus
de app is volledig zelfstandig — geen runtime-CDN.

```
files/testfit/
├── index.html            # import-map + gevendorde <script>-tags
├── styles.css            # donkere CAD-achtige UI
├── vendor/               # React 18, ReactDOM, htm (UMD + ESM-shims)
└── src/
    ├── geometry.js       # pure 2D-polygoongeometrie (offset, clip, hit-tests)
    ├── solver.js         # parkeer-solver + ADA-tabel + metrics
    └── app.js            # React-UI (htm) + imperatieve canvas-rendering
```

`geometry.js` en `solver.js` zijn dependency-vrije, pure ES-modules en zijn
los te testen met Node.

## Toetsenbord

| Toets | Actie | Toets | Actie |
|-------|-------|-------|-------|
| `V` | Selecteren | `G` | Raster aan/uit |
| `P` | Site tekenen | `Esc` | Annuleren |
| `B` | Gebouw tekenen | `Del` | Selectie verwijderen |
| `Space` | Pan | `Ctrl/⌘+Z` / `+Shift` | Undo / Redo |

Zoom met het scrollwiel; pan met de Pan-tool, middelste muisknop of `Shift`+slepen.

## Roadmap (nice-to-have)

Web-worker voor de solve bij grote sites, single-loaded rijen & dead-end
turnarounds, manual override met pin/lock op vakken en rijstroken, licht-gekantelde
2.5D-weergave, en DXF/GeoJSON-export.

---

Demonstrator ter educatie; geen affiliatie met TestFit. Parkeerafmetingen en
ADA-aantallen variëren per jurisdictie — alle waarden zijn configureerbaar.
