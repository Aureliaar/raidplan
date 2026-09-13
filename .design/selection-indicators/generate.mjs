// Generates one .dc.html artboard per selection-indicator proposal.
// Scene: same three objects in every board so the proposals compare 1:1.
import { writeFileSync } from "node:fs";

const ACC = "#7aa2f7";
const ZONE = "#ff7043";
const TANK = "#3f6ac4";
const FONT = "ui-sans-serif, system-ui, 'Segoe UI', sans-serif";
const W = 760, H = 480;

// px per arena unit
const S = 0.8;
const player = { x: 130, y: 240, size: 60 * S };          // r = 24
const aoe    = { x: 350, y: 240, r: 110 * S };            // r = 88
const beam   = { x: 600, y: 240, w: 120 * S, l: 440 * S, rot: 25 }; // 96 x 352

const P0 = player, A0 = aoe, B0 = beam;

const rgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

const defs = `
<defs>
  <radialGradient id="aoeFill" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${aoe.r}">
    <stop offset="0" stop-color="${rgba(ZONE, 0)}"/>
    <stop offset="0.75" stop-color="${rgba(ZONE, 0.1)}"/>
    <stop offset="1" stop-color="${rgba(ZONE, 0.32)}"/>
  </radialGradient>
  <radialGradient id="beamFill" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${Math.hypot(beam.w, beam.l) / 2}">
    <stop offset="0" stop-color="${rgba(ZONE, 0)}"/>
    <stop offset="0.75" stop-color="${rgba(ZONE, 0.1)}"/>
    <stop offset="1" stop-color="${rgba(ZONE, 0.32)}"/>
  </radialGradient>
  <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
    <feGaussianBlur stdDeviation="5"/>
  </filter>
  <clipPath id="clipPlayer"><rect x="${-player.size/2}" y="${-player.size/2}" width="${player.size}" height="${player.size}" rx="6.4"/></clipPath>
</defs>`;

function floor(x = 16, y = 16, w = W - 32, h = H - 32) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#252a33" stroke="#4a525f" stroke-width="3.2"/>`;
}

// The three objects, drawn as the app does (scaled 0.8).
function objects(opacity = { p: 1, a: 1, b: 1 }, player = P0, aoe = A0, beam = B0) {
  const r = player.size / 2;
  return `
  <g transform="translate(${aoe.x} ${aoe.y})" opacity="${opacity.a}">
    <circle r="${aoe.r}" fill="url(#aoeFill)" stroke="${ZONE}" stroke-width="4"/>
  </g>
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})" opacity="${opacity.b}">
    <rect x="${-beam.w/2}" y="${-beam.l/2}" width="${beam.w}" height="${beam.l}" fill="url(#beamFill)" stroke="${ZONE}" stroke-width="4"/>
  </g>
  <g transform="translate(${player.x} ${player.y})" opacity="${opacity.p}">
    <image href="PLD.png" x="${-r}" y="${-r}" width="${player.size}" height="${player.size}" clip-path="url(#clipPlayer)"/>
    <rect x="${-r}" y="${-r}" width="${player.size}" height="${player.size}" rx="6.4" fill="none" stroke="${TANK}" stroke-width="4.8"/>
    <text x="0" y="${r + 4 + 17}" text-anchor="middle" font-size="17" font-weight="700" fill="#e6edf3" stroke="#0d1117" stroke-width="3" paint-order="stroke" font-family="${FONT}">MT</text>
  </g>`;
}

// The white diagonal resize tick the pins put at the ring's south-east.
function tickAt(x, y) {
  const d = 6 * Math.SQRT1_2;
  return `<line x1="${x - d}" y1="${y - d}" x2="${x + d}" y2="${y + d}" stroke="#14171c" stroke-width="6" stroke-linecap="round" opacity="0.7"/>
  <line x1="${x - d}" y1="${y - d}" x2="${x + d}" y2="${y + d}" stroke="#e6ebf2" stroke-width="3" stroke-linecap="round"/>`;
}
function tick(cx, cy, ring) {
  return tickAt(cx + ring * Math.SQRT1_2, cy + ring * Math.SQRT1_2);
}
// Same tick, in a rotated group's local space at the beam's SE corner.
function localTick(hw, hh, pad) {
  return tickAt(hw + pad, hh + pad);
}

function caption(title, sub) {
  return `<text x="28" y="44" font-size="15" font-weight="600" fill="#e6ebf2" font-family="${FONT}">${title}</text>
  <text x="28" y="64" font-size="12.5" fill="#b8c0cc" font-family="${FONT}">${sub}</text>`;
}

const legend = `<g font-size="11.5" fill="#6b7686" font-family="${FONT}" text-anchor="middle">
  <text x="${player.x}" y="${H - 28}">player · 60u</text>
  <text x="${aoe.x}" y="${H - 28}">aoe · r 110u</text>
  <text x="${beam.x}" y="${H - 28}">beam · 120×440u, 25°</text>
</g>`;

// ---------- indicators ----------

// 0. current: dotted circle at radiusHint + 14
function current() {
  const rings = [
    [player.x, player.y, (30 + 14) * S],
    [aoe.x, aoe.y, (110 + 14) * S],
    [beam.x, beam.y, (220 + 14) * S],
  ];
  return rings.map(([x, y, r]) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${ACC}" stroke-width="3.2" stroke-dasharray="9.6 6.4"/>` + tick(x, y, r)
  ).join("");
}

// A. contour halo: an outline that follows the shape, plus a soft glow
function contour() {
  const off = 6;
  const r = player.size / 2 + off;
  const ra = aoe.r + off;
  const bw = beam.w + 2 * off, bl = beam.l + 2 * off;
  return `
  <g transform="translate(${player.x} ${player.y})">
    <rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="10" fill="none" stroke="${ACC}" stroke-width="8" opacity="0.35" filter="url(#glow)"/>
    <rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="10" fill="none" stroke="${ACC}" stroke-width="2"/>
    ${tickAt(r, r)}
  </g>
  <g transform="translate(${aoe.x} ${aoe.y})">
    <circle r="${ra}" fill="none" stroke="${ACC}" stroke-width="8" opacity="0.35" filter="url(#glow)"/>
    <circle r="${ra}" fill="none" stroke="${ACC}" stroke-width="2"/>
    ${tick(0, 0, ra)}
  </g>
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})">
    <rect x="${-bw/2}" y="${-bl/2}" width="${bw}" height="${bl}" rx="4" fill="none" stroke="${ACC}" stroke-width="8" opacity="0.35" filter="url(#glow)"/>
    <rect x="${-bw/2}" y="${-bl/2}" width="${bw}" height="${bl}" rx="4" fill="none" stroke="${ACC}" stroke-width="2"/>
    ${localTick(bw/2, bl/2, 0)}
  </g>`;
}

// B. corner brackets on the oriented bounding box
function brackets() {
  const L = 14, off = 8, sw = 2.5;
  const box = (hw, hh) => {
    const c = [[-1,-1],[1,-1],[1,1],[-1,1]];
    return c.map(([sx, sy]) => {
      const x = sx * hw, y = sy * hh;
      return `<path d="M ${x} ${y - sy * L} L ${x} ${y} L ${x - sx * L} ${y}" fill="none" stroke="${ACC}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
    }).join("");
  };
  const r = player.size / 2 + off;
  return `
  <g transform="translate(${player.x} ${player.y})">${box(r, r)}${localTick(r, r, 8)}</g>
  <g transform="translate(${aoe.x} ${aoe.y})">${box(aoe.r + off, aoe.r + off)}${localTick(aoe.r + off, aoe.r + off, 8)}</g>
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})">${box(beam.w/2 + off, beam.l/2 + off)}${localTick(beam.w/2 + off, beam.l/2 + off, 8)}</g>`;
}

// C. tint + solid edge: the shape itself lights up in the accent
function tint() {
  const r = player.size / 2;
  return `
  <g transform="translate(${player.x} ${player.y})">
    <rect x="${-r}" y="${-r}" width="${player.size}" height="${player.size}" rx="6.4" fill="${rgba(ACC, 0.22)}" stroke="${ACC}" stroke-width="2.5"/>
    ${tickAt(r + 2, r + 2)}
  </g>
  <g transform="translate(${aoe.x} ${aoe.y})">
    <circle r="${aoe.r}" fill="${rgba(ACC, 0.16)}" stroke="${ACC}" stroke-width="2.5"/>
    ${tick(0, 0, aoe.r + 2)}
  </g>
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})">
    <rect x="${-beam.w/2}" y="${-beam.l/2}" width="${beam.w}" height="${beam.l}" fill="${rgba(ACC, 0.16)}" stroke="${ACC}" stroke-width="2.5"/>
    ${localTick(beam.w/2, beam.l/2, 2)}
  </g>`;
}

// D. anchor chip + hairline: a small label above the object, a dot at its centre
function chip() {
  const chipAt = (x, y, label, w) => `
  <g transform="translate(${x} ${y})">
    <circle r="3.5" fill="${ACC}" stroke="#14171c" stroke-width="1.5"/>
    <line x1="0" y1="-4" x2="0" y2="-18" stroke="${ACC}" stroke-width="1.5"/>
    <rect x="${-w/2}" y="-36" width="${w}" height="18" rx="4" fill="${ACC}"/>
    <text x="0" y="-23" text-anchor="middle" font-size="11" font-weight="700" fill="#0d1117" font-family="${FONT}">${label}</text>
  </g>`;
  const r = player.size / 2;
  return `
  <g transform="translate(${player.x} ${player.y})">
    <rect x="${-r - 2}" y="${-r - 2}" width="${player.size + 4}" height="${player.size + 4}" rx="8" fill="none" stroke="${ACC}" stroke-width="1.2" opacity="0.8"/>
    ${tickAt(r + 4, r + 4)}
  </g>
  ${chipAt(player.x, player.y - r - 6, "MT · PLD", 62)}
  <g transform="translate(${aoe.x} ${aoe.y})">
    <circle r="${aoe.r + 2}" fill="none" stroke="${ACC}" stroke-width="1.2" opacity="0.8"/>
    ${tick(0, 0, aoe.r + 4)}
  </g>
  ${chipAt(aoe.x, aoe.y, "AoE · r 110", 72)}
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})">
    <rect x="${-beam.w/2 - 2}" y="${-beam.l/2 - 2}" width="${beam.w + 4}" height="${beam.l + 4}" fill="none" stroke="${ACC}" stroke-width="1.2" opacity="0.8"/>
    ${localTick(beam.w/2, beam.l/2, 4)}
  </g>
  ${chipAt(beam.x, beam.y, "Beam · 120 × 440 · 25°", 130)}`;
}

// E. marching ants along the actual contour (animated)
function ants() {
  const r = player.size / 2 + 3;
  return `
  <style>
    @keyframes march { to { stroke-dashoffset: -14; } }
    .ant { stroke-dasharray: 7 7; animation: march 0.9s linear infinite; }
  </style>
  <g transform="translate(${player.x} ${player.y})">
    <rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="8" fill="none" stroke="#14171c" stroke-width="2.5"/>
    <rect class="ant" x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="8" fill="none" stroke="#e6ebf2" stroke-width="2.5"/>
    ${tickAt(r + 2, r + 2)}
  </g>
  <g transform="translate(${aoe.x} ${aoe.y})">
    <circle r="${aoe.r + 3}" fill="none" stroke="#14171c" stroke-width="2.5"/>
    <circle class="ant" r="${aoe.r + 3}" fill="none" stroke="#e6ebf2" stroke-width="2.5"/>
    ${tick(0, 0, aoe.r + 3)}
  </g>
  <g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})">
    <rect x="${-beam.w/2 - 3}" y="${-beam.l/2 - 3}" width="${beam.w + 6}" height="${beam.l + 6}" fill="none" stroke="#14171c" stroke-width="2.5"/>
    <rect class="ant" x="${-beam.w/2 - 3}" y="${-beam.l/2 - 3}" width="${beam.w + 6}" height="${beam.l + 6}" fill="none" stroke="#e6ebf2" stroke-width="2.5"/>
    ${localTick(beam.w/2, beam.l/2, 3)}
  </g>`;
}

function wrap(svg, w, h) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; background: #14171c; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    a { color: #7aa2f7; } a:hover { color: #9dbbff; }
  </style>
</helmet>
<div style="width: ${w}px; height: ${h}px; background: #14171c; overflow: hidden;">
${svg}
</div>
</x-dc>
</body>
</html>
`;
}

function board(name, title, sub, indicator) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="display:block">
  ${defs}
  <rect width="${W}" height="${H}" fill="#14171c"/>
  ${floor()}
  ${objects()}
  ${indicator}
  ${caption(title, sub)}
  ${legend}
</svg>`;
  writeFileSync(new URL(`./${name}.dc.html`, import.meta.url), wrap(svg, W, H));
}

// F. focus dim: three stacked scenes, one object selected in each
function dimBoard() {
  const scenes = [
    { sel: "p", label: "player selected" },
    { sel: "a", label: "aoe selected" },
    { sel: "b", label: "beam selected" },
  ];
  const sc = 0.72;
  const rowH = H * sc + 16;
  const edge = (sel) => {
    const r = player.size / 2 + 2;
    if (sel === "p") return `<g transform="translate(${player.x} ${player.y})"><rect x="${-r}" y="${-r}" width="${2*r}" height="${2*r}" rx="8" fill="none" stroke="${ACC}" stroke-width="2"/>${tickAt(r + 2, r + 2)}</g>`;
    if (sel === "a") return `<g transform="translate(${aoe.x} ${aoe.y})"><circle r="${aoe.r + 2}" fill="none" stroke="${ACC}" stroke-width="2"/>${tick(0, 0, aoe.r + 2)}</g>`;
    return `<g transform="translate(${beam.x} ${beam.y}) rotate(${beam.rot})"><rect x="${-beam.w/2 - 2}" y="${-beam.l/2 - 2}" width="${beam.w + 4}" height="${beam.l + 4}" fill="none" stroke="${ACC}" stroke-width="2"/>${localTick(beam.w/2, beam.l/2, 2)}</g>`;
  };
  const rows = scenes.map((s, i) => {
    const op = { p: s.sel === "p" ? 1 : 0.4, a: s.sel === "a" ? 1 : 0.4, b: s.sel === "b" ? 1 : 0.4 };
    return `<g transform="translate(0 ${76 + i * rowH}) scale(${sc})">
      ${floor()}
      ${objects(op)}
      ${edge(s.sel)}
      <text x="28" y="${H - 28}" font-size="14" fill="#6b7686" font-family="${FONT}">${s.label}</text>
    </g>`;
  }).join("");
  const TH = 76 + 3 * rowH + 8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${TH}" viewBox="0 0 ${W} ${TH}" style="display:block">
  ${defs}
  <rect width="${W}" height="${TH}" fill="#14171c"/>
  ${caption("F · Focus dim", "Everything not selected drops to 40%; the selected object keeps full colour plus a 2px accent edge. No ring at all.")}
  ${rows}
</svg>`;
  writeFileSync(new URL(`./FocusDim.dc.html`, import.meta.url), wrap(svg, W, TH));
  return TH;
}

board("Main", "Current · Dotted ring", "Dashed accent circle at radiusHint + 14. A rotated beam gets a circle almost 4× its width.", current());
board("ContourHalo", "A · Contour halo", "A 2px accent outline 6u outside the real silhouette, with a soft glow. Follows rotation.", contour());
board("CornerBrackets", "B · Corner brackets", "Four L marks on the oriented bounding box, 8u out. Nothing touches the shape.", brackets());
board("TintEdge", "C · Tint + edge", "The shape itself takes a 16–22% accent wash and a solid 2.5px edge. No extra geometry.", tint());
board("AnchorChip", "D · Anchor chip", "A hairline edge at 80% plus a name chip anchored to the centre dot. Says what, not just where.", chip());
board("MarchingAnts", "E · Marching ants", "A white 7/7 dash crawling along the contour, 3u out, over a dark under-stroke. Reads on any colour.", ants());
console.log("FocusDim height", dimBoard());

// Shared by G and H: a dark readout chip in the margin. `glyph` is a job icon
// file, null for a round zone, undefined for a box zone.
function chipSvg(x, y, w, label, sub, col, glyph, state = "idle") {
  const h = 26;
  const border = state === "selected" ? ACC : col;
  const bw = state === "selected" ? 2 : 1.2;
  const fill = state === "selected" ? rgba(ACC, 0.18) : state === "hover" ? "#2e3543" : "#232833";
  const g = glyph
    ? `<image href="${glyph}" x="${x + 6}" y="${y + 5}" width="16" height="16"/>`
    : glyph === null
      ? `<circle cx="${x + 14}" cy="${y + 13}" r="6" fill="none" stroke="${col}" stroke-width="1.6"/>`
      : `<rect x="${x + 9}" y="${y + 6}" width="10" height="14" fill="none" stroke="${col}" stroke-width="1.6" transform="rotate(25 ${x + 14} ${y + 13})"/>`;
  return `
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="5" fill="${fill}" stroke="${border}" stroke-width="${bw}"/>
  ${g}
  <text x="${x + 28}" y="${y + 17}" font-size="12" font-weight="700" fill="#e6ebf2" font-family="${FONT}">${label}<tspan fill="#b8c0cc" font-weight="500"> ${sub}</tspan></text>`;
}

// A leader: from the object's edge at 45° to a knee, then level into the
// margin, where the chip sits. side -1 = left margin, +1 = right margin.
function leaderSvg(from, kneeY, side, edgeX, col, opacity = 1) {
  const kx = from.x + side * Math.abs(kneeY - from.y);
  const endX = side < 0 ? edgeX - 12 : edgeX + 12;
  return `<path d="M ${from.x} ${from.y} L ${kx} ${kneeY} L ${endX} ${kneeY}" fill="none" stroke="${col}" stroke-width="1.5" stroke-linejoin="round" opacity="${opacity}"/>`;
}

// Hairline edge on a token, circle or box, in a given colour.
function edgeSvg(kind, o, col, op = 0.9, withTick = true) {
  if (kind === "p") {
    const r = o.size / 2;
    return `<g transform="translate(${o.x} ${o.y})"><rect x="${-r - 2}" y="${-r - 2}" width="${o.size + 4}" height="${o.size + 4}" rx="8" fill="none" stroke="${col}" stroke-width="1.2" opacity="${op}"/>${withTick ? tickAt(r + 4, r + 4) : ""}</g>`;
  }
  if (kind === "a") return `<g transform="translate(${o.x} ${o.y})"><circle r="${o.r + 2}" fill="none" stroke="${col}" stroke-width="1.2" opacity="${op}"/>${withTick ? tick(0, 0, o.r + 4) : ""}</g>`;
  return `<g transform="translate(${o.x} ${o.y}) rotate(${o.rot})"><rect x="${-o.w/2 - 2}" y="${-o.l/2 - 2}" width="${o.w + 4}" height="${o.l + 4}" fill="none" stroke="${col}" stroke-width="1.2" opacity="${op}"/>${withTick ? localTick(o.w/2, o.l/2, 4) : ""}</g>`;
}

// G. scanner callout: hairline edge; a leader in the item's own colour leaves
// on a 45° diagonal, turns level, and ends at a chip just outside the arena.
function scannerBoard() {
  const GW = 1000, GH = 480;
  const fx = 200, fy = 40, fw = 620, fh = 424;
  const p = { ...P0, x: 330, y: 240 }, a = { ...A0, x: 510, y: 240 }, b = { ...B0, x: 700, y: 240 };
  const r = p.size / 2, d = Math.SQRT1_2;
  const rot = (b.rot * Math.PI) / 180;
  const beamEdge = { x: b.x + (b.w / 2 + 2) * Math.cos(rot), y: b.y + (b.w / 2 + 2) * Math.sin(rot) };
  const indicator = `
  ${edgeSvg("p", p, TANK)}${edgeSvg("a", a, ZONE)}${edgeSvg("b", b, ZONE)}
  ${leaderSvg({ x: p.x - r - 2, y: p.y - r - 2 }, 160, -1, fx, TANK)}
  ${chipSvg(fx - 12 - 92, 160 - 13, 92, "MT", "PLD", TANK, "PLD.png")}
  ${leaderSvg({ x: a.x - (a.r + 2) * d, y: a.y + (a.r + 2) * d }, 360, -1, fx, ZONE)}
  ${chipSvg(fx - 12 - 92, 360 - 13, 92, "AoE", "r 110", ZONE, null)}
  ${leaderSvg(beamEdge, 320, 1, fx + fw, ZONE)}
  ${chipSvg(fx + fw + 12, 320 - 13, 150, "Beam", "120 × 440 · 25°", ZONE, undefined)}`;
  const legend = `<g font-size="11.5" fill="#6b7686" font-family="${FONT}" text-anchor="middle">
    <text x="${p.x}" y="${GH - 28}">player · 60u</text>
    <text x="${a.x}" y="${GH - 28}">aoe · r 110u</text>
    <text x="${b.x}" y="${GH - 28}">beam · 120×440u, 25°</text>
  </g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GW}" height="${GH}" viewBox="0 0 ${GW} ${GH}" style="display:block">
  ${defs}
  <rect width="${GW}" height="${GH}" fill="#14171c"/>
  ${floor(fx, fy, fw, fh)}
  ${objects(undefined, p, a, b)}
  ${indicator}
  <text x="${fx + 12}" y="${fy + 24}" font-size="15" font-weight="600" fill="#e6ebf2" font-family="${FONT}">G · Scanner callout</text>
  <text x="${fx + 12}" y="${fy + 44}" font-size="12.5" fill="#b8c0cc" font-family="${FONT}">Hairline edge; a leader in the item colour leaves at 45°, turns level, ends at a chip outside the arena.</text>
  ${legend}
</svg>`;
  writeFileSync(new URL(`./ScannerCallout.dc.html`, import.meta.url), wrap(svg, GW, GH));
}
scannerBoard();

// H. callout mode: the toolbar toggle shows a leader and chip for everything on
// the floor; chips are click targets, so a multi-select is made from the
// margin. Focus dim applies to whatever is not selected.
function calloutModeBoard() {
  const GW = 1000, GH = 540;
  const fx = 200, fy = 60, fw = 620, fh = 440;
  const HEAL = "#29a655", MELEE = "#b5432b";
  const mt = { ...P0, x: 330, y: 200 }, h1 = { ...P0, x: 300, y: 310 }, d1 = { ...P0, x: 590, y: 435 };
  const ao = { ...A0, x: 510, y: 300, r: 56 };
  const bm = { ...B0, x: 710, y: 250, l: 360 * S };
  const r = mt.size / 2, d = Math.SQRT1_2;
  const rot = (bm.rot * Math.PI) / 180;
  const beamEdge = { x: bm.x + (bm.w / 2 + 2) * Math.cos(rot), y: bm.y + (bm.w / 2 + 2) * Math.sin(rot) };
  const DIM = 0.4;
  const token = (o, icon, col, op) => `
  <g transform="translate(${o.x} ${o.y})" opacity="${op}">
    <image href="${icon}" x="${-r}" y="${-r}" width="${o.size}" height="${o.size}" clip-path="url(#clipPlayer)"/>
    <rect x="${-r}" y="${-r}" width="${o.size}" height="${o.size}" rx="6.4" fill="none" stroke="${col}" stroke-width="4.8"/>
  </g>`;
  const name = (o, t, op) => `<text x="${o.x}" y="${o.y + r + 21}" opacity="${op}" text-anchor="middle" font-size="17" font-weight="700" fill="#e6edf3" stroke="#0d1117" stroke-width="3" paint-order="stroke" font-family="${FONT}">${t}</text>`;
  const L = fx - 12 - 92, R = fx + fw + 12;
  const scene = `
  <g opacity="${DIM}">
    <g transform="translate(${ao.x} ${ao.y})"><circle r="${ao.r}" fill="url(#aoeFill)" stroke="${ZONE}" stroke-width="4"/></g>
    <g transform="translate(${bm.x} ${bm.y}) rotate(${bm.rot})"><rect x="${-bm.w/2}" y="${-bm.l/2}" width="${bm.w}" height="${bm.l}" fill="url(#beamFill)" stroke="${ZONE}" stroke-width="4"/></g>
  </g>
  ${token(h1, "WHM.png", HEAL, DIM)}${name(h1, "H1", DIM)}
  ${token(mt, "PLD.png", TANK, 1)}${name(mt, "MT", 1)}
  ${token(d1, "DRG.png", MELEE, 1)}${name(d1, "D1", 1)}
  ${edgeSvg("p", mt, ACC, 1)}${edgeSvg("p", d1, ACC, 1)}
  ${edgeSvg("p", h1, HEAL, 0.5, false)}${edgeSvg("a", ao, ZONE, 0.5, false)}${edgeSvg("b", bm, ZONE, 0.5, false)}
  ${leaderSvg({ x: mt.x - r - 2, y: mt.y - r - 2 }, 120, -1, fx, TANK)}
  ${chipSvg(L, 120 - 13, 92, "MT", "PLD", TANK, "PLD.png", "selected")}
  ${leaderSvg({ x: h1.x - r - 2, y: h1.y - r - 2 }, 250, -1, fx, HEAL, 0.5)}
  ${chipSvg(L, 250 - 13, 92, "H1", "WHM", HEAL, "WHM.png")}
  ${leaderSvg({ x: d1.x - r - 2, y: d1.y - r - 2 }, 440, -1, fx, MELEE)}
  ${chipSvg(L, 440 - 13, 92, "D1", "DRG", MELEE, "DRG.png", "selected")}
  ${leaderSvg({ x: ao.x - (ao.r + 2) * d, y: ao.y + (ao.r + 2) * d }, 380, -1, fx, ZONE, 0.5)}
  ${chipSvg(L, 380 - 13, 92, "AoE", "r 70", ZONE, null)}
  ${leaderSvg(beamEdge, 330, 1, fx + fw, ZONE, 0.5)}
  ${chipSvg(R, 330 - 13, 150, "Beam", "120 × 360 · 25°", ZONE, undefined, "hover")}`;
  // Toolbar strip above the floor: the toggle, on.
  const toolbar = `
  <g transform="translate(${fx} 14)">
    <rect x="0" y="0" width="70" height="26" rx="4" fill="#232833"/>
    <text x="35" y="17" text-anchor="middle" font-size="12.5" fill="#b8c0cc" font-family="${FONT}">Select</text>
    <rect x="78" y="0" width="86" height="26" rx="4" fill="${ACC}"/>
    <path d="M 90 18 L 96 12 L 104 12" fill="none" stroke="#0d1117" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="110" y="17" font-size="12.5" font-weight="600" fill="#0d1117" font-family="${FONT}">Callouts</text>
    <text x="176" y="17" font-size="12" fill="#6b7686" font-family="${FONT}">on · every floor item gets a leader and a chip · click a chip to select it, shift-click to add</text>
  </g>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${GW}" height="${GH}" viewBox="0 0 ${GW} ${GH}" style="display:block">
  ${defs}
  <rect width="${GW}" height="${GH}" fill="#14171c"/>
  ${toolbar}
  ${floor(fx, fy, fw, fh)}
  ${scene}
  <text x="${fx + 12}" y="${fy + 24}" font-size="15" font-weight="600" fill="#e6ebf2" font-family="${FONT}">H · Callout mode + focus dim</text>
  <text x="${fx + 12}" y="${fy + 44}" font-size="12.5" fill="#b8c0cc" font-family="${FONT}">MT and D1 picked from their chips; the rest dims. Beam chip is hovered.</text>
  <g font-size="11.5" fill="#6b7686" font-family="${FONT}">
    <text x="${R}" y="${fy + 24}">chip states</text>
    ${chipSvg(R, fy + 34, 92, "MT", "PLD", TANK, "PLD.png")}
    <text x="${R + 100}" y="${fy + 51}">idle</text>
    ${chipSvg(R, fy + 68, 92, "MT", "PLD", TANK, "PLD.png", "hover")}
    <text x="${R + 100}" y="${fy + 85}">hover</text>
    ${chipSvg(R, fy + 102, 92, "MT", "PLD", TANK, "PLD.png", "selected")}
    <text x="${R + 100}" y="${fy + 119}">selected</text>
  </g>
</svg>`;
  writeFileSync(new URL(`./CalloutMode.dc.html`, import.meta.url), wrap(svg, GW, GH));
}
calloutModeBoard();
