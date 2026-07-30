// ============================================================
// share.js — a plan in a link.
//
// There is no server. A shared plan therefore has to travel inside the URL
// itself, which means it has to be small: gzip and base64url, both of which the
// platform already has (`CompressionStream`, `btoa`). A demo plan comes out at
// around 860 characters and a plan with thirty hand-placed stalls at around
// 1 800 — well inside what any browser or chat client will carry.
//
// Pure apart from the two web-stream globals, which Node also has, so this can
// be round-tripped without a browser.
// ============================================================

export const SHARE_KEY = 'p';

// Everything a link is allowed to carry. Deliberately not "the document minus a
// blacklist": a field added later should have to be considered rather than
// silently shipped to strangers.
const DOC_FIELDS = [
  'name', 'site', 'siteCurved', 'obstacles', 'geo', 'params', 'orientationIndex',
  'autoParking', 'overrides', 'annotations', 'junctions', 'manualStalls',
  // Imported building styles are small parameter sets, unlike the symbol library
  // — a few hundred bytes each — so they can travel, and without them a shared
  // plan would silently redraw its warehouses as the default shed.
  'buildingStyles',
  // Variants are patches — a label and a handful of layout parameters, tens of
  // bytes each, and near-identical to one another, which is the best case gzip
  // has. Measured on the demo plan: 544 chars with none, 714 with eight. What
  // they deliberately do not carry is solved geometry; that is hundreds of
  // stalls apiece against a budget of about 860 characters for the whole plan,
  // so a shared variant is re-solved on arrival instead.
  'variants',
];
// Past this the link stops being a link. Anything beyond is reported as dropped
// rather than silently truncated.
export const MAX_SHARED_VARIANTS = 24;

/**
 * The part of a document that can travel in a URL, and an honest account of
 * what had to stay behind.
 *
 * Imported symbols are data URIs — a single 512 px PNG is tens of kilobytes
 * before base64, so one import would make the link longer than the plan. They
 * are dropped, and so are the objects placed with them: an asset annotation
 * whose type is not registered is silently skipped by the canvas, and a link
 * that quietly loses objects is worse than one that says it did.
 */
export function shareable(doc) {
  const out = {};
  for (const k of DOC_FIELDS) if (doc[k] !== undefined) out[k] = doc[k];
  const anns = out.annotations || [];
  const kept = anns.filter((a) => !(a && typeof a.kind === 'string' && a.kind.startsWith('asset:')));
  out.annotations = kept;
  const vars = Array.isArray(out.variants) ? out.variants : [];
  out.variants = vars.slice(0, MAX_SHARED_VARIANTS);
  return {
    doc: out,
    dropped: {
      assets: (doc.assets || []).length,
      objects: anns.length - kept.length,
      variants: Math.max(0, vars.length - MAX_SHARED_VARIANTS),
    },
  };
}

const b64url = (bytes) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (str) => {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

async function through(bytes, stream) {
  const w = stream.writable.getWriter();
  // On bad input the decompressor errors, and it rejects the *writer's*
  // promises as well as the reader's. Left unhandled those escape the caller's
  // try/catch entirely and take the process (or the tab's error handler) with
  // them, so they are swallowed here — the read below is what reports failure.
  w.write(bytes).catch(() => {});
  w.close().catch(() => {});
  const chunks = [];
  const r = stream.readable.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    chunks.push(value);
  }
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** A payload as a URL-safe string. */
export async function encodeShare(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  return b64url(await through(json, new CompressionStream('gzip')));
}

/**
 * A URL-safe string back to a payload, or `null` if it is not one.
 *
 * Anything can end up after a `#` — a stale link, a mangled paste, someone
 * else's anchor — so this never throws; the caller decides what to say.
 */
export async function decodeShare(str) {
  try {
    const bytes = await through(unb64url(String(str || '')), new DecompressionStream('gzip'));
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    return obj && obj.doc && obj.doc.site && obj.doc.params ? obj : null;
  } catch (e) {
    return null;
  }
}

/** The full link for a plan, given the page it should open in. */
export async function shareURL(href, doc, view) {
  const { doc: d, dropped } = shareable(doc);
  const code = await encodeShare({ _pp: 1, doc: d, view });
  const base = String(href).split('#')[0];
  return { url: base + '#' + SHARE_KEY + '=' + code, chars: code.length, dropped };
}

/** The share code in a location hash, or '' if there is none. */
export function shareCodeOf(hash) {
  const m = /^#(?:.*&)?p=([A-Za-z0-9\-_]+)/.exec(String(hash || ''));
  return m ? m[1] : '';
}
