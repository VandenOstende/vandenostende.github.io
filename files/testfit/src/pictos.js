// ============================================================
// pictos.js — the painters for markings, pictograms and signage.
//
// Its own module for the same reason annots.js is: the canvas renderer draws
// these and the Mapbox drape rasterises them into map images, and importing
// them from app.js would make map3d depend on the entry point.
//
// Each painter draws inside a unit box centred on the origin (-1..1); the
// caller handles position, scale and rotation. That is what makes the same
// function usable both for a 2D stamp and for an offscreen texture.
// ============================================================

// ---------- Belgian markings, pictograms and signage ----------
// Each painter draws inside a unit box centred on the origin (-1..1) with the
// caller handling position, scale and rotation. Keeps them resolution-free and
// lets any of them be rotated onto a road tangent.
export function pathFrom(ctx, pts, close) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  if (close) ctx.closePath();
}
// A road arrow: a shaft up the middle, a head straight ahead, and a branch to
// either side. `dirs` names which of the three the marking permits, so one
// painter covers every legal combination instead of one function per glyph —
// which is what let "links + rechts" and "alle richtingen" be drawn at all.
function arrow(ctx, dirs) {
  const d = dirs || {};
  // Without a head ahead, the shaft stops where the branches leave it. Left
  // standing, the stub above them reads as a fourth, unmarked direction.
  const top = d.ahead ? -0.3 : 0.12;
  // Losing the head also loses the top half of the glyph, which would leave the
  // marking hanging in the bottom of its box — and the caller positions by the
  // centre, so it would sit low on the tarmac. Recentre what is actually drawn.
  if (!d.ahead) ctx.translate(0, -(0.95 + 0.01) / 2);
  ctx.fillStyle = '#f8fafc';
  pathFrom(ctx, [[-0.16, 0.95], [0.16, 0.95], [0.16, top], [-0.16, top]], true);
  ctx.fill();
  if (d.ahead) {
    pathFrom(ctx, [[-0.45, -0.25], [0.45, -0.25], [0, -0.95]], true);
    ctx.fill();
  }
  for (const sx of [d.left ? -1 : 0, d.right ? 1 : 0]) {
    if (!sx) continue;
    pathFrom(ctx, [[0, 0.35], [sx * 0.62, 0.35], [sx * 0.62, 0.12], [0, 0.12]], true);
    ctx.fill();
    pathFrom(ctx, [[sx * 0.55, 0.46], [sx * 0.55, 0.01], [sx * 0.95, 0.235]], true);
    ctx.fill();
  }
}

// Keren: up one side, over the top and back down the other, with the head
// pointing where the driver ends up. Not a combination of the three directions
// above, so it gets its own geometry: a half annulus for the bend plus a leg
// either side of it.
function uturn(ctx) {
  const rOut = 0.52, rIn = 0.24, yTop = -0.34;
  ctx.fillStyle = '#f8fafc';
  // The bend. Both arcs run over the top (anticlockwise in canvas's y-down
  // frame); the implicit lineTo between them closes the right-hand end flat.
  ctx.beginPath();
  ctx.arc(0, yTop, rOut, Math.PI, 0, true);
  ctx.arc(0, yTop, rIn, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();
  pathFrom(ctx, [[rIn, yTop], [rOut, yTop], [rOut, 0.95], [rIn, 0.95]], true);
  ctx.fill();
  pathFrom(ctx, [[-rOut, yTop], [-rIn, yTop], [-rIn, 0.2], [-rOut, 0.2]], true);
  ctx.fill();
  pathFrom(ctx, [[-0.66, 0.16], [-0.1, 0.16], [-0.38, 0.95]], true);
  ctx.fill();
}
export function glyph(ctx, txt, size, color) {
  ctx.fillStyle = color || '#f8fafc';
  ctx.font = `bold ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, 0, 0);
}
// Plate shapes for vertical signage, drawn face-on with a small post shadow.
export function plate(ctx, shape, fill, rim) {
  ctx.fillStyle = fill;
  if (shape === 'circle') { ctx.beginPath(); ctx.arc(0, 0, 1, 0, Math.PI * 2); ctx.fill(); }
  else if (shape === 'triangle') { pathFrom(ctx, [[0, -1], [1, 0.82], [-1, 0.82]], true); ctx.fill(); }
  else if (shape === 'octagon') {
    const p = []; for (let i = 0; i < 8; i++) { const a = (Math.PI / 4) * i + Math.PI / 8; p.push([Math.cos(a), Math.sin(a)]); }
    pathFrom(ctx, p, true); ctx.fill();
  } else { pathFrom(ctx, [[-1, -1], [1, -1], [1, 1], [-1, 1]], true); ctx.fill(); }
  if (rim) {
    ctx.strokeStyle = rim; ctx.lineWidth = 0.22; ctx.stroke();
  }
}
// Mutated at runtime when a symbol is imported, deliberately: it is the one
// registry every consumer already reads from.
export const PICTOS = {
  arrowAhead: (ctx) => arrow(ctx, { ahead: true }),
  arrowLeft: (ctx) => { ctx.rotate(-Math.PI / 2); arrow(ctx, { ahead: true }); },
  arrowRight: (ctx) => { ctx.rotate(Math.PI / 2); arrow(ctx, { ahead: true }); },
  arrowAheadL: (ctx) => arrow(ctx, { ahead: true, left: true }),
  arrowAheadR: (ctx) => arrow(ctx, { ahead: true, right: true }),
  arrowLeftRight: (ctx) => arrow(ctx, { left: true, right: true }),
  arrowAll: (ctx) => arrow(ctx, { ahead: true, left: true, right: true }),
  arrowUturn: uturn,
  speed: (ctx, ann) => {
    ctx.fillStyle = '#f8fafc';
    glyph(ctx, String(ann && ann.value != null ? ann.value : 20), 1.5, '#f8fafc');
  },
  bike: (ctx) => {
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(-0.55, 0.42, 0.4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(0.55, 0.42, 0.4, 0, Math.PI * 2); ctx.stroke();
    pathFrom(ctx, [[-0.55, 0.42], [-0.1, -0.35], [0.35, -0.35], [0.55, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[-0.1, -0.35], [0.55, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[0.2, -0.62], [0.5, -0.62]], false); ctx.stroke();
  },
  ev: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    pathFrom(ctx, [[0.18, -0.95], [-0.5, 0.1], [-0.05, 0.1], [-0.22, 0.95], [0.5, -0.15], [0.02, -0.15]], true);
    ctx.fill();
  },
  ada: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(-0.05, -0.62, 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.19; ctx.lineCap = 'round';
    pathFrom(ctx, [[-0.05, -0.3], [-0.05, 0.2], [0.45, 0.2]], false); ctx.stroke();
    ctx.beginPath(); ctx.arc(-0.08, 0.35, 0.5, -0.5, Math.PI * 0.95); ctx.stroke();
    pathFrom(ctx, [[0.45, 0.2], [0.62, 0.75]], false); ctx.stroke();
  },
  walk: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(0, -0.68, 0.22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.18; ctx.lineCap = 'round';
    pathFrom(ctx, [[0, -0.4], [0, 0.15]], false); ctx.stroke();
    pathFrom(ctx, [[-0.35, -0.15], [0.35, -0.2]], false); ctx.stroke();
    pathFrom(ctx, [[0, 0.15], [-0.28, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0, 0.15], [0.3, 0.88]], false); ctx.stroke();
  },
  letterP: (ctx) => glyph(ctx, 'P', 1.8, '#f8fafc'),
  family: (ctx) => {
    ctx.fillStyle = '#f8fafc';
    ctx.beginPath(); ctx.arc(-0.4, -0.55, 0.24, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(0.42, -0.28, 0.17, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8fafc'; ctx.lineWidth = 0.17; ctx.lineCap = 'round';
    pathFrom(ctx, [[-0.4, -0.28], [-0.4, 0.35]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.35], [-0.62, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.35], [-0.18, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, -0.08], [0.42, 0.42]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, 0.42], [0.26, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[0.42, 0.42], [0.6, 0.9]], false); ctx.stroke();
    pathFrom(ctx, [[-0.4, 0.02], [0.42, 0.06]], false); ctx.stroke();
  },
  // ---- signage ----
  signYield: (ctx) => { plate(ctx, 'triangle', '#ffffff', '#d92b2b'); },
  signStop: (ctx) => { plate(ctx, 'octagon', '#d92b2b'); glyph(ctx, 'STOP', 0.52, '#ffffff'); },
  signSpeed: (ctx, ann) => {
    plate(ctx, 'circle', '#ffffff', '#d92b2b');
    glyph(ctx, String(ann && ann.value != null ? ann.value : 20), 0.95, '#111827');
  },
  signNoEntry: (ctx) => {
    plate(ctx, 'circle', '#d92b2b');
    ctx.fillStyle = '#ffffff';
    pathFrom(ctx, [[-0.62, -0.17], [0.62, -0.17], [0.62, 0.17], [-0.62, 0.17]], true); ctx.fill();
  },
  signParking: (ctx) => { plate(ctx, 'rect', '#1d4ed8'); glyph(ctx, 'P', 1.3, '#ffffff'); },
  signOneWay: (ctx) => {
    plate(ctx, 'rect', '#1d4ed8');
    ctx.fillStyle = '#ffffff';
    pathFrom(ctx, [[-0.6, -0.12], [0.25, -0.12], [0.25, -0.38], [0.75, 0], [0.25, 0.38], [0.25, 0.12], [-0.6, 0.12]], true);
    ctx.fill();
  },
  signAda: (ctx) => { plate(ctx, 'rect', '#1d4ed8'); ctx.save(); ctx.scale(0.62, 0.62); PICTOS.ada(ctx); ctx.restore(); },
  signEV: (ctx) => { plate(ctx, 'rect', '#15803d'); ctx.save(); ctx.scale(0.62, 0.62); PICTOS.ev(ctx); ctx.restore(); },
};
