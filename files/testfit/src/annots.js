// ============================================================
// annots.js — the annotation type catalogue.
//
// Its own module because both the canvas renderer (app.js) and the Mapbox
// drape (map3d.js) need it. Importing it from app.js would make map3d depend
// on the entry point, which only works by accident of module caching.
// ============================================================

// Infrastructure annotations you can draw over the plan.
//   mode 'line'  → click points, finish on dbl-click/first point (Esc cancels)
//   mode 'cross' → 2 clicks define a crossing centreline (zebra stripes)
//   mode 'area'  → drag a rectangle
// `under: true` draws beneath the parking (roads, bike parking).
// `group` buckets the palette; `keywords` are extra search terms so you can find
// a tool by what you call it rather than by its label.
export const ANNOT_GROUPS = ['Rijden', 'Markeringen', 'Pictogrammen', 'Borden', 'Retail', 'Langzaam verkeer', 'Groen', 'Licht', 'Eigen', 'Overig'];
// Belgian road markings and signage. `picto` names a painter in PICTOS;
// `sign` marks a plate-on-a-post rather than paint on the asphalt; `value`
// gives an editable number (speed limits). Point markings carry an `angle`.
const MARK = (label, picto, keywords, extra) => ({
  label, color: '#f1f5f9', width: 3, mode: 'point', picto, group: 'Markeringen', keywords, ...extra,
});
const PICTO = (label, picto, keywords, extra) => ({
  label, color: '#e2e8f0', width: 2.6, mode: 'point', picto, group: 'Pictogrammen', keywords, ...extra,
});
const SIGN = (label, picto, keywords, extra) => ({
  label, color: '#cbd5e1', width: 1.6, mode: 'point', picto, sign: true, group: 'Borden', keywords, ...extra,
});
export const ANNOT_TYPES = {
  // `body` draws a filled carriageway instead of a fat stroke: square corners,
  // and the drawn line can be a kerb rather than the centreline (`align`).
  // `aisleColor` paints it exactly like the solver's own drive aisles.
  road:        { label: 'Weg',          color: '#3b424e', width: 6.0, mode: 'line', curved: false, under: true, blocks: true, body: true, aisleColor: true, group: 'Rijden', keywords: 'straat rijbaan asfalt baan rijstrook' },
  driveway:    { label: 'In/uitrit',    color: '#525b68', width: 6.5, depth: 12, mode: 'driveway', under: true, blocks: true, group: 'Rijden', keywords: 'oprit inrit uitrit toegang entree' },
  drivethru:   { label: 'Drive-thru',   color: '#f97316', width: 3.5, mode: 'line', curved: true, under: true, blocks: true, group: 'Rijden', keywords: 'drive through afhaal loket wachtrij' },
  // `body` like the road: a filled surface, so the ends are square and the
  // corners are mitred. They keep their own colour — only the road is asphalt.
  walkway:     { label: 'Wandelpad',    color: '#9aa4b2', width: 1.8, mode: 'line', curved: true, body: true, group: 'Langzaam verkeer', keywords: 'voetpad trottoir stoep voetganger boulevard promenade' },
  bikepath:    { label: 'Fietspad',     color: '#b91c1c', width: 2.0, mode: 'line', curved: true, body: true, group: 'Langzaam verkeer', keywords: 'fiets bike cyclepad' },
  crosswalk:   { label: 'Zebrapad',     color: '#e5e7eb', width: 3.5, mode: 'cross', group: 'Langzaam verkeer', keywords: 'zebra oversteek voetganger kruising' },
  bikeparking: { label: 'Fietsparking', color: '#0e7490', width: 0,   mode: 'area', under: true, group: 'Langzaam verkeer', keywords: 'fietsenstalling fietsrek stalling' },
  grass:       { label: 'Gras',         color: '#3f9b46', width: 0,   mode: 'area', under: true, group: 'Groen', keywords: 'groen gazon berm perk' },
  tree:        { label: 'Boom',         color: '#2f9e44', width: 5,   mode: 'point', group: 'Groen', keywords: 'bomen beplanting groen' },
  access:      { label: 'Toegang',      color: '#22d3ee', width: 6,   mode: 'point', group: 'Overig', keywords: 'toegangspunt poort ingang' },
  marking:     { label: 'Markering',    color: '#eab308', width: 0.3, mode: 'line', curved: false, group: 'Overig', keywords: 'belijning streep lijn verf' },

  // ---- Grondmarkering: verkeer ----
  arrowAhead:  MARK('Pijl rechtdoor', 'arrowAhead', 'pijl recht vooruit richting bewegwijzering'),
  arrowLeft:   MARK('Pijl links', 'arrowLeft', 'pijl afslaan links richting'),
  arrowRight:  MARK('Pijl rechts', 'arrowRight', 'pijl afslaan rechts richting'),
  arrowAheadL: MARK('Pijl recht + links', 'arrowAheadL', 'pijl gecombineerd links rechtdoor'),
  arrowAheadR: MARK('Pijl recht + rechts', 'arrowAheadR', 'pijl gecombineerd rechts rechtdoor'),
  sharkTeeth:  { label: 'Haaientanden', color: '#f8fafc', width: 2.5, mode: 'line', curved: false, group: 'Markeringen', keywords: 'voorrang verlenen driehoek b1 tanden' },
  stopLine:    { label: 'Stopstreep', color: '#f8fafc', width: 0.4, mode: 'line', curved: false, group: 'Markeringen', keywords: 'stop streep b5 wachtlijn' },
  speedMark:   MARK('Snelheid (grond)', 'speed', 'snelheid km/u 20 30 cijfer zone', { width: 4, value: 20 }),
  hatchZone:   { label: 'Kruisarcering', color: '#f8fafc', width: 0, mode: 'area', group: 'Markeringen', keywords: 'arcering verboden zone schuine strepen uitsluiting' },
  bayLines:    { label: 'Vakbelijning', color: '#f8fafc', width: 0, mode: 'area', group: 'Markeringen', keywords: 'parkeervak belijning wit vakken lijnen' },

  // ---- Grondpictogrammen ----
  pictoBike:   PICTO('Fietslogo', 'bike', 'fiets pictogram logo'),
  pictoEV:     PICTO('EV-laadsymbool', 'ev', 'elektrisch laadpaal stekker ev'),
  pictoAda:    PICTO('Minder-validen', 'ada', 'rolstoel gehandicapt invalide ada blauw', { color: '#3b82f6' }),
  pictoWalk:   PICTO('Voetganger', 'walk', 'voetganger wandelaar oversteek'),
  pictoP:      PICTO('P-symbool', 'letterP', 'parkeren letter p'),

  // ---- Verticale signalisatie (Belgische codes) ----
  signYield:   SIGN('B1 voorrang verlenen', 'signYield', 'b1 driehoek voorrang haaientand bord'),
  signStop:    SIGN('B5 stop', 'signStop', 'b5 stop achthoek bord'),
  signSpeed:   SIGN('C43 snelheid', 'signSpeed', 'c43 snelheidsbeperking bord rond', { value: 20 }),
  signNoEntry: SIGN('C1 verboden richting', 'signNoEntry', 'c1 verboden inrit eenrichting bord'),
  signParking: SIGN('E9a parkeren', 'signParking', 'e9a parkeren blauw bord p'),
  signOneWay:  SIGN('F19 eenrichting', 'signOneWay', 'f19 eenrichtingsverkeer pijl bord'),
  signAda:     SIGN('Bord minder-validen', 'signAda', 'gehandicapt rolstoel voorbehouden bord'),
  signEV:      SIGN('Bord laadpunt', 'signEV', 'ev laadpaal elektrisch bord'),

  // ---- Retail ----
  loadingZone: { label: 'Laad- en loszone', color: '#fbbf24', width: 0, mode: 'area', under: true, group: 'Retail', keywords: 'laden lossen laadzone loszone levering vrachtwagen expeditie truck losplaats' },
  trolleyBay:  { label: 'Winkelwagens', color: '#38bdf8', width: 0, mode: 'area', under: true, group: 'Retail', keywords: 'winkelwagen winkelkar karren trolley stalling caddy' },
  clickCollect: { label: 'Click & collect', color: '#a78bfa', width: 0, mode: 'area', under: true, group: 'Retail', keywords: 'afhaal ophalen bestelling collect pickup' },
  familyBay:   PICTO('Familieplaats', 'family', 'gezin kind kinderwagen zwanger familie', { group: 'Retail', color: '#f472b6' }),

  // ---- Licht ----
  // The lamp post carries its own mounting height in `value`, because the one
  // thing that differs from post to post on a site is how high the light hangs;
  // the luminaire's output is a document parameter.
  lightPole:   { label: 'Lichtmast', color: '#fcd34d', width: 1.2, mode: 'point', group: 'Licht',
                 value: 6, valueLabel: 'Lichtpunthoogte (m)', valueMin: 3, valueMax: 16, valueStep: 0.5,
                 keywords: 'verlichting lamp mast paal armatuur straatlantaarn lantaarn licht lux' },
  // A carport roofs over parking that is already paved, so it adds no impervious
  // surface of its own — see NON_PAVED in solver.js.
  carport:     { label: 'Zonnecarport', color: '#0ea5e9', width: 0, mode: 'area', group: 'Licht',
                 keywords: 'carport overkapping zonnepanelen pv luifel afdak zonnedak solar' },
};

// ---------- Surface materials ----------
// What a surface is made of, and how much rain runs off it rather than soaking
// away. A coefficient rather than a paved/unpaved flag, because that is how
// stormwater is actually reckoned and it lets "half hard" be said without
// inventing a third category.
//
// `surfaceOf` returns null when no material was chosen. That is deliberate:
// an annotation without one behaves exactly as it did before materials existed,
// so no saved plan quietly changes its numbers.
export const SURFACES = {
  asphalt:  { key: 'asphalt',  label: 'Asfalt',   tint: '#3b424e', runoff: 1.00 },
  concrete: { key: 'concrete', label: 'Beton',    tint: '#9ca3af', runoff: 1.00 },
  paver:    { key: 'paver',    label: 'Klinkers', tint: '#8d6e63', runoff: 0.60 },
  gravel:   { key: 'gravel',   label: 'Kiezel',   tint: '#a8a29e', runoff: 0.40 },
  sand:     { key: 'sand',     label: 'Zand',     tint: '#e3cf9e', runoff: 0.20 },
  grass:    { key: 'grass',    label: 'Gras',     tint: '#3f9b46', runoff: 0.10 },
};
export const surfaceOf = (an) => (an && SURFACES[an.material]) || null;
/** How much of this surface's area counts as hard. 1 when nothing was chosen. */
export const runoffOf = (an) => { const m = surfaceOf(an); return m ? m.runoff : 1; };

// ---------- Imported assets ----------
// An imported symbol is not a new kind of object — it is a point annotation
// whose painter happens to draw a bitmap. Registering it here means the palette,
// the object list, selection, copy/paste, the exporters and the 3D drape all
// pick it up without a single extra branch.
//
// The catalogue is mutated at runtime on purpose: it is the one place every
// consumer already reads from, and a parallel registry would have to be
// threaded through modules that only import ANNOT_TYPES.
export const ASSET_PREFIX = 'asset:';
export const assetKindOf = (id) => ASSET_PREFIX + id;
export const isAssetKind = (kind) => typeof kind === 'string' && kind.startsWith(ASSET_PREFIX);
export const assetIdOf = (kind) => (isAssetKind(kind) ? kind.slice(ASSET_PREFIX.length) : '');

export function registerAsset(asset) {
  if (!asset || !asset.id) return null;
  const kind = assetKindOf(asset.id);
  ANNOT_TYPES[kind] = {
    label: asset.name || 'Asset',
    // Only used for the palette dot when the thumbnail hasn't decoded yet.
    color: '#94a3b8',
    width: asset.mWidth || 2,
    mode: 'point',
    picto: kind,
    group: 'Eigen',
    keywords: 'eigen asset symbool import ' + (asset.name || '').toLowerCase(),
    asset,
  };
  return kind;
}
// Removing an asset from the library must not blank out instances already
// placed in the document, so the type stays registered and is only hidden from
// the palette. Deleting the entry outright would make drawAnnotation bail on an
// unknown kind and silently erase the objects from the canvas.
export function hideAsset(id) {
  const t = ANNOT_TYPES[assetKindOf(id)];
  if (t) t.hidden = true;
}
