// Zone opacity rework: no-snapshot zones get one look, snapshotting zones get a look before and
// after the snapshot, and big and long zones keep the telegraph feel. Tokens from src/client/styles.css;
// telegraph gradient stops from telegraphFill in Scene.tsx.
import { writeFileSync } from "node:fs";

const ink = { 900: "#14171c", 800: "#1a1e25", 700: "#232833", 600: "#2e3543", 400: "#6b7686", 200: "#b8c0cc", 100: "#dfe5ee" };
const accent = "#7aa2f7";
const ORANGE = "#ff7043", PURPLE = "#b07cf7", TEAL = "#3fc1a5";
const AMBER = "rgba(251,191,36,0.8)";
const font = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };

const head = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
    body { margin: 0; font-family: ${font}; background: ${ink[900]}; color: ${ink[200]}; }
    a { color: ${accent}; } a:hover { color: #a5c0fa; }
    .label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[400]}; }
    .cap { font-size: 12px; line-height: 1.5; color: #8a95a5; text-wrap: pretty; }
    .h { font-size: 13px; font-weight: 600; color: #e6ebf2; }
    .title { font-size: 20px; font-weight: 600; color: #e6ebf2; }
    .field { box-sizing: border-box; width: 100%; border-radius: 4px; padding: 4px 8px; font-size: 14px; background: ${ink[900]}; border: 1px solid ${ink[600]}; color: ${ink[200]}; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: ${ink[100]}; }
  </style>
</helmet>
`;
const tail = `</x-dc>
</body>
</html>
`;
const page = (w, inner) => `${head}<div style="width: ${w}px; box-sizing: border-box; padding: 28px; display: flex; flex-direction: column; gap: 18px;">${inner}</div>\n${tail}`;
const header = (eyebrow, title, pitch) => `<div style="display: flex; flex-direction: column; gap: 6px;"><div class="label">${eyebrow}</div><div class="title">${title}</div><div class="cap" style="max-width: 780px;">${pitch}</div></div>`;
const framed = (frames) => `<div style="display: flex; gap: 10px; flex-wrap: wrap;">${frames.map(([cap, svg]) => `<div style="display: flex; flex-direction: column; gap: 4px;">${svg}<div class="label">${cap}</div></div>`).join("")}</div>`;

let gid = 0;
const uid = (p) => `${p}${gid++}`;

/* ------------------------------------------------------------------ arena */
/* A 1000-unit arena, origin at the centre. `backdrop` paints a floor texture so "hide background" has something to hide. */
function arena(px, shapes, { backdrop = false, party = true, under = "" } = {}) {
  const floorId = uid("floor");
  const floor = backdrop
    ? `<defs><pattern id="${floorId}" width="125" height="125" patternUnits="userSpaceOnUse" x="-500" y="-500"><rect width="125" height="125" fill="#2a2620"></rect><rect x="4" y="4" width="117" height="117" fill="#332e26"></rect><path d="M20 90 L60 70 L100 95" stroke="#3d372d" stroke-width="5" fill="none"></path></pattern></defs><rect x="-500" y="-500" width="1000" height="1000" fill="url(#${floorId})"></rect>`
    : `<rect x="-500" y="-500" width="1000" height="1000" fill="${ink[800]}"></rect>`;
  const grid = [-250, 0, 250].map((v) => `<line x1="${v}" y1="-500" x2="${v}" y2="500" stroke="${backdrop ? "rgba(0,0,0,0.25)" : ink[600]}" stroke-width="3"></line><line x1="-500" y1="${v}" x2="500" y2="${v}" stroke="${backdrop ? "rgba(0,0,0,0.25)" : ink[600]}" stroke-width="3"></line>`).join("");
  const people = party ? [[-60, -120, "#4a7fe0"], [60, -120, "#4a7fe0"], [-150, 60, "#3fae62"], [150, 60, "#3fae62"], [-60, 180, "#d0504a"], [60, 180, "#d0504a"], [-200, -40, "#d0504a"], [200, -40, "#d0504a"]]
    .map(([x, y, c]) => `<circle cx="${x}" cy="${y}" r="26" fill="${c}" stroke="#0d1117" stroke-width="6"></circle>`).join("") : "";
  const clip = uid("wall");
  return `<svg width="${px}" height="${px}" viewBox="-510 -510 1020 1020" style="display: block; border-radius: 6px; background: ${ink[900]};" aria-hidden="true"><defs><clipPath id="${clip}"><rect x="-500" y="-500" width="1000" height="1000"></rect></clipPath></defs>${floor}${grid}${under}<g clip-path="url(#${clip})">${shapes}</g><rect x="-500" y="-500" width="1000" height="1000" fill="none" stroke="${ink[600]}" stroke-width="6"></rect>${people}</svg>`;
}

/* ------------------------------------------------------------------ looks */
function teleCircle(cx, cy, r, c, { blast = 0, op = 1 } = {}) {
  const id = uid("g");
  return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" stop-color="${rgba(c, 0.62 * blast)}"></stop><stop offset="0.75" stop-color="${rgba(c, 0.1 + 0.55 * blast)}"></stop><stop offset="1" stop-color="${rgba(c, 0.32 + 0.45 * blast)}"></stop></radialGradient></defs><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})" stroke="${c}" stroke-width="5" opacity="${op}"></circle>`;
}
const solidCircle = (cx, cy, r, c, a = 0.4) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${rgba(c, a)}" stroke="${c}" stroke-width="5"></circle>`;
function hazardCircle(cx, cy, r, c) {
  const id = uid("hz");
  return `<defs><pattern id="${id}" width="44" height="44" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="44" height="44" fill="${rgba(c, 0.14)}"></rect><rect width="14" height="44" fill="${rgba(c, 0.45)}"></rect></pattern></defs><circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${id})" stroke="${c}" stroke-width="5"></circle>`;
}
const hideCircle = (cx, cy, r, c) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${ink[900]}"></circle><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${rgba(c, 0.55)}" stroke-width="5" stroke-dasharray="18 14"></circle>`;

/* ------------------------------------------------------------ inspector UI */
const inspector = (inner, w = 300) => `<div style="width: ${w}px; box-sizing: border-box; padding: 12px; border-radius: 6px; background: ${ink[800]}; border: 1px solid ${ink[700]}; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;">${inner}</div>`;
const field = (label, ctl, span = false) => `<div style="${span ? "grid-column: span 2; " : ""}display: flex; flex-direction: column; gap: 2px;"><div class="label">${label}</div>${ctl}</div>`;
const slider = (v) => `<div style="position: relative; height: 16px; display: flex; align-items: center;"><div style="height: 4px; width: 100%; border-radius: 2px; background: ${ink[600]};"><div style="height: 4px; width: ${v * 100}%; border-radius: 2px; background: #3b82f6;"></div></div><div style="position: absolute; left: calc(${v * 100}% - 8px); width: 16px; height: 16px; border-radius: 50%; background: #3b82f6;"></div></div>`;
const select = (v) => `<div class="field" style="display: flex; justify-content: space-between; align-items: center;"><span>${v}</span><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="${ink[400]}" stroke-width="1.5"><path d="M4 6l4 4 4-4"></path></svg></div>`;
const colour = (c) => `<div class="field" style="display: flex; gap: 6px; align-items: center;"><span style="width: 12px; height: 12px; border-radius: 2px; background: ${c};"></span>${c}</div>`;
const group = (title, inner) => `<div style="grid-column: span 2; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding-top: 8px; border-top: 1px solid ${ink[700]};"><div style="grid-column: span 2; font-size: 12px; font-weight: 600; color: ${ink[100]};">${title}</div>${inner}</div>`;

/* A four-step rail with one Beat bar and its snapshot diamond, after the timeline-modes canvas. */
function rail({ snapAt, note }) {
  const ROW = 28, GAP = 4;
  const diamond = `<svg width="12" height="12" viewBox="0 0 10 10" style="display: block;"><path d="M5 0.7L9.3 5 5 9.3 0.7 5z" fill="${ink[100]}" stroke="${ink[900]}" stroke-width="1.2"></path></svg>`;
  const rows = [1, 2, 3, 4].map((n) => `<div style="height: ${ROW}px; display: flex; align-items: center; gap: 8px; padding: 0 8px; border-radius: 4px; background: ${n === snapAt ? ink[600] : "transparent"}; color: ${n === snapAt ? "#fff" : ink[200]}; font-size: 13px;"><span style="width: 14px; color: ${ink[400]};">${n}</span>step ${n}</div>`).join("");
  const top = 0, bottom = 3 * (ROW + GAP) + ROW;
  const seam = snapAt === 4 ? bottom - 7 : snapAt * (ROW + GAP) - GAP / 2 - 6;
  const frozen = snapAt === 4 ? "" : `<div style="position: absolute; left: 0; right: 0; top: ${snapAt * (ROW + GAP) - GAP / 2}px; bottom: 0; border: 1px dashed ${rgba(ORANGE, 0.6)}; border-top: none; border-radius: 0 0 4px 4px; background: transparent;"></div>`;
  return `<div style="display: flex; flex-direction: column; gap: 6px;">
  <div style="display: flex; gap: 8px; width: 240px;">
    <div style="flex: 1; display: flex; flex-direction: column; gap: ${GAP}px;">${rows}</div>
    <div style="position: relative; width: 66px; height: ${bottom}px;">
      <div style="position: absolute; left: 0; right: 0; top: ${top}px; height: ${snapAt === 4 ? bottom : snapAt * (ROW + GAP) - GAP / 2}px; background: ${rgba(ORANGE, 0.22)}; border-left: 2px solid ${ORANGE}; border-radius: 4px 4px 0 0;"></div>
      ${frozen}
      <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: ${AMBER};"></div>
      <div style="position: absolute; left: 27px; top: ${seam}px;">${diamond}</div>
    </div>
  </div>
  <div class="cap" style="width: 240px;">${note}</div>
</div>`;
}

/* ================================================================= Main: the model */
{
  const L = 150;
  const looks = [
    ["telegraph", arena(L, teleCircle(0, -60, 260, ORANGE)), "Today’s look. Clear heart, rim showing."],
    ["solid", arena(L, solidCircle(0, -60, 260, ORANGE)), "Flat fill at the opacity you set."],
    ["hazard · optional", arena(L, hazardCircle(0, -60, 260, PURPLE)), "Hatched. Kept as a choice, not the default for anything."],
    ["hide background", arena(L, hideCircle(0, -60, 260, ORANGE), { backdrop: true }), "Cuts the arena floor out underneath: the ground is gone, only the party stays."],
  ];
  writeFileSync(new URL("./Main.dc.html", import.meta.url), page(1060, `
  ${header("Zone opacity · model", "One look before it snapshots, one after, or just one", "Whether a zone gets one set of options or two comes from the timeline, not from a switch. Snapshot on the last step of the Beat means nothing is frozen, so the zone has a single look. Snapshot earlier means there is a before and an after, and each gets its own look and opacity. Big and long zones draw whichever look they have through the telegraph proposals beside this.")}
  <div style="display: flex; flex-direction: column; gap: 8px;">
    <div class="h">Looks</div>
    <div style="display: flex; gap: 14px;">
      ${looks.map(([cap, svg, body]) => `<div style="width: ${L}px; display: flex; flex-direction: column; gap: 4px;">${svg}<div class="label">${cap}</div><div class="cap">${body}</div></div>`).join("")}
    </div>
  </div>
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;">
    <div style="display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 8px; background: ${ink[800]}; border: 1px solid ${ink[700]};">
      <div class="h">A · No snapshot</div>
      <div style="display: flex; gap: 16px; align-items: flex-start;">
        ${rail({ snapAt: 4, note: "Diamond dragged onto the last step. Today it cannot go there; it should, and that is what “no snapshot” means." })}
        ${inspector([field("colour", colour(PURPLE)), field("opacity", slider(0.6)), field("look", select("Solid"), true)].join(""), 200)}
      </div>
    </div>
    <div style="display: flex; flex-direction: column; gap: 10px; padding: 16px; border-radius: 8px; background: ${ink[800]}; border: 1px solid ${ink[700]};">
      <div class="h">B · Snapshots in step 2</div>
      <div style="display: flex; gap: 16px; align-items: flex-start;">
        ${rail({ snapAt: 2, note: "Following through step 2, frozen (dashed) in 3 and 4, goes off at the end of 4." })}
        ${inspector([
          field("colour", colour(ORANGE), true),
          group("Until snapshot", field("look", select("Telegraph")) + field("opacity", slider(0.5))),
          group("After snapshot", field("look", select("Solid")) + field("opacity", slider(0.8))),
        ].join(""), 200)}
      </div>
    </div>
  </div>
  <div style="display: flex; flex-direction: column; gap: 8px;">
    <div class="h">B across its steps</div>
    ${framed([
      ["step 1 · following", arena(170, teleCircle(-40, -120, 230, ORANGE, { op: 0.5 }))],
      ["step 2 · snapshot", arena(170, teleCircle(-60, -120, 230, ORANGE, { op: 0.5 }))],
      ["step 3 · frozen", arena(170, solidCircle(-60, -120, 230, ORANGE, 0.32))],
      ["into step 5 · goes off", arena(170, solidCircle(-60, -120, 250, ORANGE, 0.62))],
    ])}
    <div class="cap" style="max-width: 780px;">The flare when it goes off stays as it is today and starts from the after look. A zone whose snapshot is on the last step goes straight from its one look to the flare.</div>
  </div>`));
}


/* ================================================================= Big and long zones: keep the telegraph */
// Four test shapes: a beam through the boss, a plus, a half-room cleave and a huge circle past two walls.
// Every proposal uses today's stops (0 heart, 0.1 at a quarter in, 0.32 at the edge) and only changes what they are measured from.
const STOPS = [[0, 0], [0.75, 0.1], [1, 0.32]];
const W = 120, D = 150; // beam width; the capped depth, about 6 yalms
const beamArms = [{ x: -W / 2, y: -620, w: W, h: 1240 }];
const plusArms = [{ x: -W / 2, y: -620, w: W, h: 560 }, { x: -W / 2, y: 60, w: W, h: 560 }, { x: -620, y: -W / 2, w: 560, h: W }, { x: 60, y: -W / 2, w: 560, h: W }];
const HALF = { x: -500, y: -500, w: 500, h: 1000 };
const CIRC = { cx: 260, cy: -220, r: 520 };
const stops = (list, c) => list.map(([o, a]) => `<stop offset="${o}" stop-color="${rgba(c, a)}"></stop>`).join("");
const outline = (r, c) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="none" stroke="${c}" stroke-width="5"></rect>`;
const radialRect = (r, c, cx, cy, rad) => { const id = uid("t"); return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${cx}" cy="${cy}" r="${rad}">${stops(STOPS, c)}</radialGradient></defs><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="url(#${id})" stroke="${c}" stroke-width="5"></rect>`; };

// Today: one radial gradient sized to half the diagonal, whatever the shape.
function today(kind, c) {
  if (kind === "circle") return teleCircle(CIRC.cx, CIRC.cy, CIRC.r, c);
  const rects = kind === "beam" ? beamArms : kind === "plus" ? [{ x: -W / 2, y: -620, w: W, h: 1240 }, { x: -620, y: -W / 2, w: 1240, h: W }] : [HALF];
  return rects.map((r) => radialRect(r, c, r.x + r.w / 2, r.y + r.h / 2, Math.hypot(r.w, r.h) / 2)).join("");
}

// 1 · Nearest edge: the same stops across the short side, never deeper than D. A beam is a telegraph in cross-section.
function acrossRect(r, c) {
  const across = r.w <= r.h;
  const depth = Math.min((across ? r.w : r.h) / 2, D);
  const edges = across ? [[r.x, 1], [r.x + r.w, -1]] : [[r.y, 1], [r.y + r.h, -1]];
  let out = "";
  for (const [e, dir] of edges) {
    if (Math.abs(Math.abs(e) - 500) < 1) continue; // an edge on the arena wall gets no rim
    const id = uid("n");
    const p2 = e + dir * depth;
    const g = across ? `x1="${e}" y1="0" x2="${p2}" y2="0"` : `x1="0" y1="${e}" x2="0" y2="${p2}"`;
    const band = across ? `<rect x="${Math.min(e, p2)}" y="${r.y}" width="${depth}" height="${r.h}"` : `<rect x="${r.x}" y="${Math.min(e, p2)}" width="${r.w}" height="${depth}"`;
    out += `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" ${g}>${stops([[0, 0.32], [0.25, 0.1], [1, 0]], c)}</linearGradient></defs>${band} fill="url(#${id})"></rect>`;
  }
  return out + outline(r, c);
}
const centreSquare = (c) => { const id = uid("cs"); return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="${W * 0.72}">${stops(STOPS, c)}</radialGradient></defs><rect x="${-W / 2}" y="${-W / 2}" width="${W}" height="${W}" fill="url(#${id})"></rect>`; };
function nearest(kind, c) {
  if (kind === "circle") {
    const id = uid("n"); const k = (CIRC.r - D) / CIRC.r;
    return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r}">${stops([[0, 0], [k, 0], [1 - (D * 0.25) / CIRC.r, 0.1], [1, 0.32]], c)}</radialGradient></defs><circle cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r}" fill="url(#${id})" stroke="${c}" stroke-width="5"></circle>`;
  }
  if (kind === "plus") return plusArms.map((r) => acrossRect(r, c)).join("") + centreSquare(c);
  return (kind === "beam" ? beamArms : [HALF]).map((r) => acrossRect(r, c)).join("");
}

// 2 · Sweep from the caster: proposal 1 plus a wash running outwards from where the cast comes from.
// `progress` is how far between appearing and going off the step is, like the in-game cast fill.
function sweepRect(r, c, from, progress) {
  const id = uid("s");
  const [x1, y1, x2, y2] = from === "down" ? [0, r.y + r.h, 0, r.y] : from === "up" ? [0, r.y, 0, r.y + r.h] : from === "right" ? [r.x + r.w, 0, r.x, 0] : [r.x, 0, r.x + r.w, 0];
  const front = Math.max(0.001, progress);
  return `<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stops([[0, 0.3], [front, 0.22], [Math.min(1, front + 0.02), 0], [1, 0]], c)}</linearGradient></defs><rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="url(#${id})"></rect>`;
}
function sweep(kind, c, progress = 0.45) {
  if (kind === "circle") {
    const id = uid("s");
    return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r}">${stops([[0, 0.3], [progress, 0.22], [progress + 0.02, 0], [0.75, 0.1], [1, 0.32]], c)}</radialGradient></defs><circle cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r}" fill="url(#${id})" stroke="${c}" stroke-width="5"></circle>`;
  }
  if (kind === "beam") return sweepRect({ x: -W / 2, y: -620, w: W, h: 620 }, c, "down", progress) + sweepRect({ x: -W / 2, y: 0, w: W, h: 620 }, c, "up", progress) + acrossRect(beamArms[0], c);
  if (kind === "plus") return [["down", plusArms[0]], ["up", plusArms[1]], ["right", plusArms[2]], ["left", plusArms[3]]].map(([f, r]) => sweepRect(r, c, f, progress) + acrossRect(r, c)).join("") + centreSquare(c);
  return sweepRect(HALF, c, "right", progress) + acrossRect(HALF, c);
}

// 3 · Echo: proposal 1, plus a faint dashed outline one depth inside, on shapes wide enough to have a middle.
function echo(kind, c) {
  const inner = `stroke="${rgba(c, 0.35)}" stroke-width="4" fill="none" stroke-dasharray="26 16"`;
  if (kind === "circle") return nearest("circle", c) + `<circle cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r - D}" ${inner}></circle>`;
  if (kind === "half") return nearest("half", c) + `<line x1="${-D}" y1="-500" x2="${-D}" y2="500" ${inner}></line>`;
  return nearest(kind, c);
}

// 4 · Fit to visible: today's single radial, centred and sized on the part inside the arena.
function fit(kind, c) {
  if (kind === "circle") {
    const id = uid("f");
    return `<defs><radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="120" cy="-100" r="470">${stops(STOPS, c)}</radialGradient></defs><circle cx="${CIRC.cx}" cy="${CIRC.cy}" r="${CIRC.r}" fill="url(#${id})" stroke="${c}" stroke-width="5"></circle>`;
  }
  const v = { x: -W / 2, y: -500, w: W, h: 1000 }, h = { x: -500, y: -W / 2, w: 1000, h: W };
  const diag = Math.hypot(W, 1000) / 2;
  if (kind === "beam") return radialRect(v, c, 0, 0, diag);
  if (kind === "plus") return radialRect(v, c, 0, 0, diag) + radialRect(h, c, 0, 0, diag);
  return today("half", c);
}

const KINDS = [["beam", "beam"], ["plus", "plus"], ["half", "half-room"], ["circle", "huge circle"]];
const rotBeam = (svg, kind) => (kind === "beam" ? `<g transform="rotate(30)">${svg}</g>` : svg);
function board({ file, eyebrow, title, pitch, draw, notes, tradeoff, extra = "" }) {
  writeFileSync(new URL(`./${file}`, import.meta.url), page(880, `
  ${header(eyebrow, title, pitch)}
  ${framed(KINDS.map(([k, cap]) => [cap, arena(185, rotBeam(draw(k, ORANGE), k))]))}
  ${extra}
  <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px;">
    <div style="display: flex; flex-direction: column; gap: 4px;"><div class="h">How it reads</div><div class="cap">${notes}</div></div>
    <div style="display: flex; flex-direction: column; gap: 4px;"><div class="h">Tradeoff</div><div class="cap">${tradeoff}</div></div>
  </div>`));
}

board({ file: "Today.dc.html", eyebrow: "Big and long zones · today", title: "One radial gradient, sized to the whole shape", draw: today,
  pitch: "The clear heart is measured from the shape’s centre out to half its diagonal. A beam 3 yalms wide and 30 long has a 15-yalm half-diagonal, so the whole visible beam sits inside the clear heart and only its outline shows. On anything big the walls cut the rim off.",
  notes: "Beams and plus arms are outlines with nothing inside. The half-room is a faint smear whose strongest band is in the corners. The huge circle’s rim is mostly outside the arena.",
  tradeoff: "The baseline. The proposals use the same colour and the same three stops." });

board({ file: "Nearest.dc.html", eyebrow: "Proposal 1", title: "Measure the telegraph from the nearest edge", draw: nearest,
  pitch: "Same three stops, measured inwards from the nearest edge instead of outwards from the centre, and never deeper than about 6 yalms. A beam becomes a telegraph in cross-section: rim on both long sides, clear down the middle. Edges lying on the arena wall get no rim.",
  notes: "Beams, crosses and plus arms read like small circles do today, because across their width they are small. A half-room carries the rim on its cut line, not on the wall. A normal-sized circle looks exactly like today.",
  tradeoff: "Rectangles are two linear gradients, and a plus is four arms plus a centre square, so it is cheap. Circles, donuts and cones need capped radial stops: a small change to telegraphFill." });

board({ file: "Sweep.dc.html", eyebrow: "Proposal 2", title: "Proposal 1, plus a fill sweeping out from the caster", draw: (k, c) => sweep(k, c, 0.45),
  pitch: "On top of the nearest-edge rim, a wash runs outwards from where the cast comes from: the boss for a beam or plus, the cut line for a cleave, the centre for a circle. How far it has got follows the steps between appearing and going off, like the in-game cast fill.",
  extra: `<div style="display: flex; flex-direction: column; gap: 6px;"><div class="h">The beam across its steps</div>${framed([["appears", arena(140, rotBeam(sweep("beam", ORANGE, 0.05), "beam"))], ["one step in", arena(140, rotBeam(sweep("beam", ORANGE, 0.45), "beam"))], ["step before it goes off", arena(140, rotBeam(sweep("beam", ORANGE, 0.9), "beam"))], ["goes off", arena(140, rotBeam(`<rect x="${-W / 2}" y="-620" width="${W}" height="1240" fill="${rgba(ORANGE, 0.62)}"></rect>`, "beam"))]])}</div>`,
  notes: "Direction is visible at a glance: which way a beam travels, which side a cleave comes from. Stepping through a plan shows how close each cast is to landing.",
  tradeoff: "Needs a “from” for every shape; beams and cones have one, plain rectangles do not. A cast that appears and goes off in the same step has no sweep to show." });

board({ file: "Echo.dc.html", eyebrow: "Proposal 3", title: "Proposal 1, with a faint inner outline on wide shapes", draw: echo,
  pitch: "Shapes wide enough to have a clear middle get a second dashed outline one depth inside the edge, so you can still see you are inside when the real edge is off-screen or zoomed past.",
  notes: "Beams and plus arms are too thin for it and stay as proposal 1. The half-room and huge circle get a line that says “still inside” well into their middle without filling it.",
  tradeoff: "One more line on the floor, doubled where two big zones overlap. Dashes are the one element here not already in the telegraph’s vocabulary." });

board({ file: "Fit.dc.html", eyebrow: "Proposal 4", title: "Keep one radial, fit it to what is visible", draw: fit,
  pitch: "The smallest change: today’s gradient, centred and sized on the part of the shape inside the arena rather than the whole shape.",
  notes: "The huge circle gets its rim back. Beams and plus arms are still outlines with a clear middle, and the half-room still puts its rim in the corners.",
  tradeoff: "Here to rule it out: it keeps the centre-out model, and that model is what fails on long shapes." });

writeFileSync(new URL("./canvas.json", import.meta.url), JSON.stringify({
  artboards: [
    { file: "Main.dc.html", x: 0, y: 0, w: 1060, h: 1160, title: "Model · A no snapshot, B snapshot" },
    { file: "Today.dc.html", x: 1160, y: 0, w: 880, h: 500, title: "Today" },
    { file: "Nearest.dc.html", x: 2120, y: 0, w: 880, h: 500, title: "1 · nearest edge" },
    { file: "Sweep.dc.html", x: 1160, y: 620, w: 880, h: 720, title: "2 · sweep from the caster" },
    { file: "Echo.dc.html", x: 2120, y: 620, w: 880, h: 500, title: "3 · inner echo" },
    { file: "Fit.dc.html", x: 2120, y: 1240, w: 880, h: 500, title: "4 · fit to visible" },
  ],
  annotations: [
    { id: "pick", x: 1160, y: -170, w: 600, text: "C · big and long zones, round 2. No tiling. All four keep today’s telegraph stops and only change what they are measured from. Proposal 1 is the core; 2 and 3 add to it; 4 is there to show why centre-out cannot work for beams." },
  ],
  launch: { view: "canvas" },
}, null, 2));
