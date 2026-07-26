# 🅿️ ParkPlanner — een TestFit-kloon in React

Een open-source, in-browser **parkeerplanner**: teken een site-grens, plaats
gebouwen/uitsluitingszones, en de solver genereert live parkeervakken,
rijstroken en metrics — geïnspireerd op TestFit's *Parking Solver*.

**Live:** `/files/testfit/` (bijv. https://vandenostende.github.io/files/testfit/)

## Wat het doet

- **Kaart-onderlaag** — plan bovenop **OpenStreetMap**, **satelliet** of **hybride**
  (satelliet + labels) luchtbeelden. Zoek een adres/plaats (OSM Nominatim) en de
  site wordt op die locatie geplaatst; de tegels lijnen uit met de site-geometrie.
- **3D-weergave (Mapbox)** — schakel naar 3D met **echte gebouwen**; het plan wordt
  over de 3D-kaart gedrapeerd. Vereist je **eigen Mapbox public token** (pk.…), die
  alleen lokaal in je browser wordt bewaard.
- **Vakken markeren** — selecteer één vak of sleep een kader over meerdere en
  markeer ze als EV, minder-valide, personeel, bezoeker, gereserveerd, compact of motor.
- **Rijbanen als eenrichting** — selecteer een rijbaan en zet 'm op eenrichting;
  richtingspijlen verschijnen op de baan (met omkeer-knop).
- **Infrastructuur tekenen** — wegen (met bochten), wandelpaden, fietspaden,
  zebrapaden, fietsparking (met capaciteit), **gras**, **bomen** en markeringen.
  Wegen/paden **snappen** aan bestaande hoekpunten en kunnen tot een **gesloten
  vlak/plein** worden gesloten; **afmetingen** verschijnen live tijdens het tekenen.
- **Gebogen site-grenzen** — teken multipoint-sites en zet "Vloeiende bochten"
  aan; de solver plaatst automatisch vakken in de curves.
- **Handmatig vakken plaatsen** — "Vak +" (K) plaatst vakken die aan bestaande
  vakken snappen; selecteer vakken en verwijder ze (Delete). Verwijderde
  solver-vakken blijven weg bij her-solve.
- **Site verplaatsen/verwijderen** — klik de site-rand om de hele site te
  selecteren, sleep om te verplaatsen, Delete om te verwijderen.
- **Navigatie** — twee-vinger trackpad pant, pinch/Ctrl+scroll zoomt.
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
en `htm` zijn lokaal gevendord in `vendor/` als klassieke UMD-scripts en via kleine
ESM-shims geïmporteerd met **relatieve paden** — geen import-map en geen runtime-CDN.
Daardoor boot de app ook op oudere browsers (ES-modules, geen import-maps vereist),
met een foutmelding-overlay als er toch iets misgaat.

```
files/testfit/
├── index.html            # gevendorde <script>-tags + boot-foutoverlay
├── styles.css            # donkere CAD-achtige UI
├── vendor/               # React 18, ReactDOM, htm (UMD + ESM-shims)
└── src/
    ├── geometry.js       # pure 2D-polygoongeometrie (offset, clip, hit-tests)
    ├── solver.js         # parkeer-solver + ADA-tabel + metrics
    ├── basemap.js        # slippy-map tegels (OSM/Esri) + geocoding + geo↔meters
    └── app.js            # React-UI (htm) + imperatieve canvas-rendering
```

De kaart-tegels (OpenStreetMap, Esri World Imagery) en geocoding (Nominatim) zijn
de enige externe netwerkverzoeken; zonder internet werkt de rest gewoon door.

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

## Recente uitbreidingen

- **Export** naar GeoJSON, DXF (CAD) en CSV (takeoff), naast PNG/JSON.
- **Web-worker solve** (met inline-fallback) zodat grote sites de UI niet bevriezen.
- **Single-loaded rijen & dead-end turnarounds** als solver-opties.
- **Pin/lock** op vakken en rijstroken (blijven bij "wis markering").
- **2.5D** gekantelde alleen-lezen weergave (naast de Mapbox 3D).
- **Programma & parkeerratio** (GLA → vereiste plaatsen), **impervious/verhard %**,
  en **toegangspunten** op de site-rand.

## Roadmap (grotere epics)

Meerlaags structured/garage-parking (tray counts), site-import (GeoJSON/KML/DXF),
generatieve varianten, en PDF/Revit/glTF-export.

---

Demonstrator ter educatie; geen affiliatie met TestFit. Parkeerafmetingen en
ADA-aantallen variëren per jurisdictie — alle waarden zijn configureerbaar.
