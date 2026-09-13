// Emits the Timeline Rail rework artboards. Values lifted from src/client/styles.css
// and the StepRail in src/client/Editor.tsx: ink tokens, 14px rows with 4px padding,
// 4px grid gaps, 66px lanes, 2px coloured cast edge, amber resolve edge.
import { writeFileSync } from "node:fs";

const ink = { 900: "#14171c", 800: "#1a1e25", 700: "#232833", 600: "#2e3543", 400: "#6b7686", 200: "#b8c0cc", 100: "#dfe5ee" };
const accent = "#7aa2f7";
const amber = "rgba(251,191,36,0.8)";
const font = 'ui-sans-serif, system-ui, "Segoe UI", sans-serif';
const tint = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const ROW = 28, GAP = 4, PITCH = ROW + GAP;

const head = (extraCss = "") => `<!doctype html>
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
    .cap { font-size: 12px; line-height: 1.5; color: #8a95a5; }
    .h { font-size: 12px; font-weight: 600; color: #e6ebf2; }
    code { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: ${ink[100]}; }
    ${extraCss}
  </style>
</helmet>
`;
const tail = `</x-dc>
</body>
</html>
`;

/* ---------------------------------------------------------------- icons */
const svg = (d, size = 12, stroke = "currentColor") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const icon = {
  chevron: svg('<path d="M6 3l5 5-5 5"></path>', 10),
  split: svg('<path d="M8 2l5 6-5 6-5-6z"></path>'),
  dup: svg('<rect x="5" y="5" width="9" height="9" rx="1.5"></rect><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"></path>'),
  plus: svg('<path d="M8 3v10M3 8h10"></path>'),
  x: svg('<path d="M4 4l8 8M12 4l-8 8"></path>'),
  grip: svg('<circle cx="6" cy="4" r="1" fill="currentColor" stroke="none"></circle><circle cx="10" cy="4" r="1" fill="currentColor" stroke="none"></circle><circle cx="6" cy="8" r="1" fill="currentColor" stroke="none"></circle><circle cx="10" cy="8" r="1" fill="currentColor" stroke="none"></circle><circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"></circle><circle cx="10" cy="12" r="1" fill="currentColor" stroke="none"></circle>', 12),
  camera: svg('<path d="M2 5.5A1.5 1.5 0 0 1 3.5 4H5l1-1.5h4L11 4h1.5A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"></path><circle cx="8" cy="8.5" r="2.5"></circle>', 10),
};
const diamond = (size, fill, stroke, extra = "") =>
  `<svg width="${size}" height="${size}" viewBox="0 0 10 10" aria-hidden="true" style="display: block; ${extra}"><path d="M5 0.7L9.3 5 5 9.3 0.7 5z" fill="${fill}" stroke="${stroke}" stroke-width="1.2"></path></svg>`;

/* ------------------------------------------------------------- step rows */
function stepRow({ n, name, state = "idle", gridRow, col = 1, editable = true, compact = false }) {
  const bg = state === "selected" ? ink[600] : state === "hover" ? "rgba(46,53,67,0.55)" : "transparent";
  const color = state === "selected" ? "#ffffff" : ink[200];
  const numColor = state === "selected" ? "rgba(255,255,255,0.7)" : ink[400];
  const showActions = !compact && editable && (state === "selected" || state === "hover");
  const act = (ic, title) =>
    `<span title="${title}" style="display: grid; place-items: center; width: 24px; height: 24px; border-radius: 4px; color: ${state === "selected" ? "#e6ebf2" : ink[200]};">${ic}</span>`;
  if (compact)
    return `<div title="Step ${n}. W and S walk the steps." style="grid-column: ${col}; grid-row: ${gridRow}; display: grid; place-items: center; height: ${ROW}px; border-radius: 4px; background: ${bg}; font-size: 12px; color: ${state === "selected" ? "#fff" : ink[400]}; box-sizing: border-box;">${n}</div>`;
  return `<div style="grid-column: ${col}; grid-row: ${gridRow}; display: flex; align-items: center; gap: 2px; height: ${ROW}px; border-radius: 4px; background: ${bg}; color: ${color}; padding: 0 2px 0 4px; box-sizing: border-box; min-width: 0;">
    <span style="width: 18px; text-align: right; font-size: 12px; color: ${numColor}; flex-shrink: 0;">${n}.</span>
    <span style="flex: 1; min-width: 0; font-size: 14px; line-height: 20px; padding: 0 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</span>
    ${showActions ? `<span style="display: flex; gap: 0; flex-shrink: 0;">${act(icon.split, "Split this Step into Variants")}${act(icon.dup, "Duplicate step")}${act(icon.plus, "Add step after this one")}${act(icon.x, "Delete step")}</span>` : ""}
  </div>`;
}

/* -------------------------------------------------------------- beat card */
/**
 * A Beat card in the reworked rail. Rows are 28px on a 32px pitch. `snap` is the
 * last row the Beat still follows its bait/anchor rule on; it is only drawn for
 * spans of three or more rows (two rows: the first is the snap, nothing to say).
 */
function card({ name, count, color, lo, hi, snap = lo, hover = false, dragging = false, active = false, gridCol, gridRow, width = 66, tail = "outline" }) {
  const rows = hi - lo + 1;
  const height = rows * PITCH - GAP;
  const hasSnap = rows >= 3;
  const cut = (snap - lo + 1) * PITCH - GAP / 2; // the seam between row `snap` and the next
  const frozen = hasSnap && snap < hi;
  const base = tint(color, active ? 0.4 : 0.18);
  const tails = {
    hatch: `background: repeating-linear-gradient(135deg, rgba(255,255,255,0.06) 0 2px, transparent 2px 7px), ${tint(color, active ? 0.22 : 0.08)};`,
    dim: `background: ${tint(color, active ? 0.18 : 0.07)};`,
    outline: `background: rgba(20,23,28,0.35); box-shadow: inset 1px 0 0 ${tint(color, 0.55)}, inset -1px 0 0 ${tint(color, 0.55)};`,
    dots: `background: radial-gradient(rgba(255,255,255,0.16) 0.7px, transparent 0.9px) 0 0 / 5px 5px, ${tint(color, active ? 0.2 : 0.08)};`,
    bar: "",
  };
  const hatch = tails[tail] ?? tails.outline;
  const ring = dragging ? "box-shadow: 0 0 0 1px rgba(255,255,255,0.7);" : hover ? "box-shadow: 0 0 0 1px rgba(255,255,255,0.25);" : "";
  // A one-row card has room for one line, so the count rides on the label.
  const label = rows === 1
    ? `<div style="padding: 5px 3px 0; text-align: center; font-size: 10px; line-height: 12px; color: ${active ? "#fff" : ink[100]}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}${count ? ` <span style="font-size: 9px; color: ${ink[400]};">&times;${count}</span>` : ""}</div>`
    : `<div style="padding: 4px 3px 0; text-align: center; font-size: 10px; line-height: 12px; color: ${active ? "#fff" : ink[100]}; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;">${name}</div>
    ${count ? `<div style="text-align: center; font-size: 9px; line-height: 11px; color: ${ink[400]};">&times;${count}</div>` : ""}`;
  const snapMark = hasSnap
    ? `<div title="Snap: baits and anchors follow their target through step ${snap + 1}, then freeze where they are. Drag to move it." style="position: absolute; left: 0; right: 0; top: ${cut - 0.5}px; height: 0; border-top: 1px dashed ${hover || dragging ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.45)"};"></div>
       <div style="position: absolute; left: -5px; top: ${cut - 5}px; width: 10px; height: 10px; cursor: ns-resize;">${diamond(10, dragging ? "#fff" : hover ? ink[100] : color, dragging ? "#fff" : "#e6ebf2")}</div>`
    : "";
  const edges = hover || dragging
    ? `<div style="position: absolute; left: 0; right: 0; top: 0; height: 6px; background: linear-gradient(${tint(color, 0.9)}, transparent); cursor: ns-resize;"></div>
       <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 7px; background: linear-gradient(transparent, rgba(251,191,36,0.45)); cursor: ns-resize;"></div>`
    : "";
  const pos = gridCol ? `grid-column: ${gridCol}; grid-row: ${gridRow};` : "";
  const w = typeof width === "number" ? `${width}px` : width;
  return `<div title="${name} — casts in step ${lo + 1}, resolves in step ${hi + 1}. Drag the top edge to move the cast, the bottom edge to move the resolve, the body to move the whole Beat." style="${pos} position: relative; width: ${w}; height: ${height}px; box-sizing: border-box; border-radius: 4px; border-top: 2px solid ${color}; border-bottom: 3px solid ${amber}; background: ${base}; overflow: visible; ${ring} cursor: grab;">
    <div style="position: absolute; inset: 0; border-radius: 2px; overflow: hidden;">
      ${frozen && tail !== "bar" ? `<div style="position: absolute; left: 0; right: 0; top: ${cut}px; bottom: 0; ${hatch}"></div>` : ""}
      ${tail === "bar" && hasSnap ? `<div style="position: absolute; left: 0; top: 0; width: 3px; height: ${cut}px; background: ${color};"></div><div style="position: absolute; left: 0; top: ${cut}px; bottom: 0; width: 3px; background: repeating-linear-gradient(${color} 0 2px, transparent 2px 5px);"></div>` : ""}
      ${label}
    </div>
    ${edges}
    ${snapMark}
  </div>`;
}

/* ----------------------------------------------------- step variant box */
function variantBox({ lo, hi, gridCol, gridRow, halves, beat }) {
  const rows = hi - lo + 1;
  return `<div style="grid-column: ${gridCol}; grid-row: ${gridRow}; position: relative; margin: -4px 0 -4px -2px; display: flex; flex-direction: column; border-radius: 4px; border: 1px solid rgba(107,118,134,0.7); background: rgba(20,23,28,0.7); overflow: hidden; box-sizing: border-box;">
    <div style="display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-height: 0;">
      ${halves.map((h, i) => `<div style="display: flex; flex-direction: column; min-height: 0; ${i ? "border-left: 1px solid rgba(46,53,67,0.6);" : ""} ${h.on ? `background: ${tint(h.color, 0.12)}; color: #fff;` : `color: ${ink[200]}; opacity: 0.6;`}">
        <div title="${h.name} — click to preview and edit it; drag this edge to move the split's start Step" style="height: 12px; flex-shrink: 0; background: ${h.color}; display: flex; align-items: center; padding: 0 4px; font-size: 8px; line-height: 12px; font-weight: 700; color: ${ink[900]}; letter-spacing: 0.04em; cursor: grab;">${h.name}</div>
        <div style="flex: 1; min-height: 0; padding: 2px; display: grid; grid-template-rows: repeat(${rows}, minmax(0, 1fr)); gap: 4px;">${i === 0 && beat ? beat : ""}</div>
      </div>`).join("")}
    </div>
    <div title="Drag the Variant container's end Step" style="height: 4px; flex-shrink: 0; background: rgba(251,191,36,0.7); border-top: 1px solid rgba(46,53,67,0.6); cursor: ns-resize;"></div>
  </div>`;
}

const btn = (text, title, bg) =>
  `<div title="${title}" style="border-radius: 4px; padding: 4px 8px; font-size: 14px; line-height: 20px; text-align: center; background: ${bg}; color: ${ink[200]};">${text}</div>`;

/* ================================================================ Main */
const steps = ["Start", "Add Movement 1", "Add Movement 2", "Final Ring", "Resolve S1", "Resolve S2", "End"];
{
  const rowsHtml = steps
    .map((name, i) => stepRow({ n: i + 1, name, gridRow: i + 1, state: i === 3 ? "selected" : i === 5 ? "hover" : "idle" }))
    .join("\n");
  // The inner Beat of a Variant half sits on the half's own row grid.
  const stackCard = card({ name: "Stack", count: 1, color: "#3f8a3f", lo: 2, hi: 5, snap: 2, gridCol: 1, gridRow: "1 / 5", width: "auto" });
  const guideY = 3 * PITCH - GAP / 2; // Add cast snaps after row 3 (it is the hovered card)
  const grid = `<div style="position: relative;">
    <div style="display: grid; grid-template-columns: minmax(0, 1fr) 66px 66px 78px; column-gap: 4px; row-gap: 4px; grid-auto-rows: ${ROW}px;">
      ${rowsHtml}
      ${card({ name: "Add cast", count: 1, color: "#b8632f", lo: 0, hi: 4, snap: 2, hover: true, gridCol: 2, gridRow: "1 / 6" })}
      ${card({ name: "Ring", count: 1, color: "#b03a3a", lo: 1, hi: 2, gridCol: 3, gridRow: "2 / 4" })}
      ${card({ name: "Line", count: 1, color: "#8c3a6e", lo: 4, hi: 4, gridCol: 3, gridRow: "5 / 6" })}
      ${variantBox({ lo: 2, hi: 5, gridCol: 4, gridRow: "3 / 7", halves: [{ name: "A", color: "#93c5fd", on: true }, { name: "B", color: "#c084fc", on: false }], beat: stackCard })}
    </div>
    <div aria-hidden="true" style="position: absolute; left: 0; right: 0; top: ${guideY - 0.5}px; height: 0; border-top: 1px dashed rgba(255,255,255,0.18); pointer-events: none;"></div>
  </div>`;

  const html = head() + `
<div style="width: 480px; min-height: 700px; box-sizing: border-box; background: ${ink[800]}; border-right: 1px solid ${ink[700]}; padding: 8px; display: flex; flex-direction: column;">
  <div class="label">Encounter</div>
  <div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;">
    <span style="font-size: 14px; color: ${ink[200]}; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Paradeigma 1</span>
    <span style="margin-left: auto; font-size: 11px; color: ${ink[400]}; flex-shrink: 0;">1 mechanic</span>
  </div>

  <div style="margin-top: 4px; border-radius: 4px; background: ${ink[700]}; padding: 4px;">
    <div style="display: flex; align-items: center;">
      <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 4px; font-size: 14px; line-height: 20px; color: ${ink[200]}; cursor: grab;">
        <span style="display: inline-flex; color: ${ink[400]}; transform: rotate(90deg);">${icon.chevron}</span>
        <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Mechanic 1</span>
        <span style="font-size: 11px; color: ${ink[400]}; flex-shrink: 0;">7</span>
      </div>
      <span title="Delete this mechanic and its steps" style="display: grid; place-items: center; width: 24px; height: 24px; color: ${ink[400]};">${icon.x}</span>
    </div>

    <div style="display: flex; align-items: center; gap: 10px; padding: 2px 4px 6px; font-size: 9px; line-height: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[400]};">
      <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 2px; background: ${ink[200]};"></span>cast</span>
      <span style="display: inline-flex; align-items: center; gap: 4px;">${diamond(8, ink[200], ink[100])}snap</span>
      <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 3px; background: ${amber};"></span>resolve</span>
    </div>

    ${grid}

    <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;">
      ${btn("New Beat here", "A new Beat casting in the Step you are on. Say where it resolves, then drop its Parts in.", ink[600])}
      ${btn("New debuff Beat here", "A Beat that deals the fight's debuffs onto role pools.", ink[600])}
    </div>
    <div style="margin-top: 16px;">
      <div class="label" style="margin-bottom: 4px;">Step notes</div>
      <div style="height: 96px; border-radius: 4px; background: ${ink[900]}; border: 1px solid ${ink[600]};"></div>
    </div>
  </div>

  <div style="margin-top: 12px;">${btn("New mechanic", "A new section of the fight, with a step in it", ink[700])}</div>
</div>
` + tail;
  writeFileSync("Main.dc.html", html);
}

/* ============================================================ BeatCard */
{
  const Z = 2; // drawn at 2x so 66px cards are readable on the canvas
  const cell = (title, note, inner, h = 5 * PITCH) => `<div style="display: flex; flex-direction: column; gap: 10px; width: 150px;">
    <div class="h">${title}</div>
    <div style="height: ${h * Z}px; position: relative;"><div style="transform: scale(${Z}); transform-origin: top left; padding-left: 8px;">${inner}</div></div>
    <div class="cap">${note}</div>
  </div>`;
  const c = (o) => card({ count: 1, ...o });
  const html = head() + `
<div style="width: 920px; box-sizing: border-box; padding: 28px 32px; display: flex; flex-direction: column; gap: 22px;">
  <div>
    <div class="label">Beat card &middot; anatomy &middot; shown at 2&times;</div>
    <div class="cap" style="margin-top: 4px; max-width: 720px;">The two edges stay what they are today: the coloured top edge is the step the Beat casts in, the amber bottom edge the step it resolves in. The word under it goes. The Snap marker is a diamond on a dashed seam: the Beat's baits and anchors follow their target down to that seam, then freeze where they stand. Below the seam the fill drains out and only the card's sides keep its colour: those steps are on the snapshot.</div>
  </div>
  <div style="display: flex; gap: 28px; align-items: flex-start;">
    ${cell("1 step", "Instant. No marker: it casts and resolves in the same step.", c({ name: "Line", color: "#8c3a6e", lo: 0, hi: 0 }))}
    ${cell("2 steps", "No marker: the first step is the snap, nothing else it could be.", c({ name: "Ring", color: "#b03a3a", lo: 0, hi: 1 }))}
    ${cell("3 steps", "Marker appears, on the cast step by default, which is today's behaviour. Nothing follows past the cast unless you say so.", c({ name: "Stack", color: "#3f8a3f", lo: 0, hi: 2 }))}
    ${cell("5 steps, snap moved", "Dragged down two rows: baits follow the party through step 3, then hold.", c({ name: "Add cast", color: "#b8632f", lo: 0, hi: 4, snap: 2 }))}
    ${cell("Hovered", "Three grips light up: the cast edge, the resolve edge and the marker. The body drags the whole Beat.", c({ name: "Add cast", color: "#b8632f", lo: 0, hi: 4, snap: 2, hover: true }))}
  </div>

  <div style="display: flex; gap: 28px; align-items: flex-start; padding-top: 8px; border-top: 1px solid ${ink[700]};">
    <div style="width: 300px;">
      <div class="h">Where the marker can go</div>
      <div class="cap" style="margin-top: 6px;">From the cast row down to the row before the resolve, inclusive. It cannot sit on the resolve row: freezing at the last step says nothing. Dragging the cast edge past the marker pushes it along, the way the resolve edge cannot cross the cast edge today.</div>
    </div>
    <div style="width: 300px;">
      <div class="h">Reading a card</div>
      <div class="cap" style="margin-top: 6px;">Filled means following its bait or anchor rule. Hollow means on the snapshot. A card with no hollow tail is a Beat that never followed past its cast, which is every Beat in every plan so far, so nothing existing changes its look except losing the word.</div>
    </div>
    <div style="width: 240px;">
      <div class="h">Naming</div>
      <div class="cap" style="margin-top: 6px;">The schema already calls the cast step <code>snap</code> and the resolve step <code>boom</code>. The marker needs its own field; the mockup calls the three moments cast, snap and resolve in every tooltip and in the legend.</div>
    </div>
  </div>
</div>
` + tail;
  writeFileSync("BeatCard.dc.html", html);
}

/* ============================================================== Compact */
// Steps as bare numbered rows: no names, no per-row actions. The width the
// names took goes to the lanes, so a card reads its whole label on one line.
{
  const LANE = 92, VLANE = LANE + 12;
  const rowsHtml = steps
    .map((_, i) => stepRow({ n: i + 1, gridRow: i + 1, compact: true, state: i === 3 ? "selected" : i === 5 ? "hover" : "idle" }))
    .join("\n");
  // The selected and hovered rows are bands across the whole rail: with no
  // name to read, the band is how you see which step the cards sit on.
  const band = (i, a) => `<div aria-hidden="true" style="grid-column: 1 / -1; grid-row: ${i + 1}; border-radius: 4px; background: ${a === 1 ? ink[600] : "rgba(46,53,67,0.6)"}; pointer-events: none;"></div>`;
  const stackCard = card({ name: "Stack", count: 1, color: "#3f8a3f", lo: 2, hi: 5, snap: 2, gridCol: 1, gridRow: "1 / 5", width: "auto" });
  const guideY = 3 * PITCH - GAP / 2;
  const grid = `<div style="position: relative;">
    <div style="display: grid; grid-template-columns: 24px ${LANE}px ${LANE}px ${VLANE}px; column-gap: 4px; row-gap: 4px; grid-auto-rows: ${ROW}px;">
      ${band(3, 1)}${band(5, 0)}
      ${rowsHtml}
      ${card({ name: "Add cast", count: 1, color: "#b8632f", lo: 0, hi: 4, snap: 2, hover: true, gridCol: 2, gridRow: "1 / 6", width: LANE })}
      ${card({ name: "Ring", count: 1, color: "#b03a3a", lo: 1, hi: 2, gridCol: 3, gridRow: "2 / 4", width: LANE })}
      ${card({ name: "Line", count: 1, color: "#8c3a6e", lo: 4, hi: 4, gridCol: 3, gridRow: "5 / 6", width: LANE })}
      ${variantBox({ lo: 2, hi: 5, gridCol: 4, gridRow: "3 / 7", halves: [{ name: "A", color: "#93c5fd", on: true }, { name: "B", color: "#c084fc", on: false }], beat: stackCard })}
      <div title="Add a step after the last one" style="grid-column: 1; grid-row: 8; display: grid; place-items: center; height: ${ROW}px; border-radius: 4px; color: ${ink[400]};">${icon.plus}</div>
    </div>
    <div aria-hidden="true" style="position: absolute; left: 0; right: 0; top: ${guideY - 0.5}px; height: 0; border-top: 1px dashed rgba(255,255,255,0.18); pointer-events: none;"></div>
  </div>`;
  const W = 8 * 2 + 4 * 2 + 24 + LANE * 2 + VLANE + 4 * 3 + 2; // padding, section padding, gutter, lanes, gaps, border
  const html = head() + `
<div style="width: ${W}px; min-height: 700px; box-sizing: border-box; background: ${ink[800]}; border-right: 1px solid ${ink[700]}; padding: 8px; display: flex; flex-direction: column;">
  <div class="label">Encounter</div>
  <div style="display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px;">
    <span style="font-size: 14px; color: ${ink[200]}; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Paradeigma 1</span>
    <span style="margin-left: auto; font-size: 11px; color: ${ink[400]}; flex-shrink: 0;">1 mechanic</span>
  </div>

  <div style="margin-top: 4px; border-radius: 4px; background: ${ink[700]}; padding: 4px;">
    <div style="display: flex; align-items: center;">
      <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 4px; font-size: 14px; line-height: 20px; color: ${ink[200]}; cursor: grab;">
        <span style="display: inline-flex; color: ${ink[400]}; transform: rotate(90deg);">${icon.chevron}</span>
        <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Mechanic 1</span>
        <span style="font-size: 11px; color: ${ink[400]}; flex-shrink: 0;">7</span>
      </div>
      <span title="Delete this mechanic and its steps" style="display: grid; place-items: center; width: 24px; height: 24px; color: ${ink[400]};">${icon.x}</span>
    </div>

    <div style="display: flex; align-items: center; gap: 10px; padding: 2px 4px 6px; font-size: 9px; line-height: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[400]};">
      <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 2px; background: ${ink[200]};"></span>cast</span>
      <span style="display: inline-flex; align-items: center; gap: 4px;">${diamond(8, ink[200], ink[100])}snap</span>
      <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 3px; background: ${amber};"></span>resolve</span>
    </div>

    ${grid}

    <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px;">
      ${btn("New Beat here", "A new Beat casting in the Step you are on. Say where it resolves, then drop its Parts in.", ink[600])}
      ${btn("New debuff Beat here", "A Beat that deals the fight's debuffs onto role pools.", ink[600])}
    </div>
    <div style="margin-top: 16px;">
      <div class="label" style="margin-bottom: 4px;">Step notes</div>
      <div style="height: 96px; border-radius: 4px; background: ${ink[900]}; border: 1px solid ${ink[600]};"></div>
    </div>
  </div>

  <div style="margin-top: 12px;">${btn("New mechanic", "A new section of the fight, with a step in it", ink[700])}</div>
</div>
` + tail;
  writeFileSync("Compact.dc.html", html);
}


/* ================================================================ Today */
{
  const html = head() + `
<div style="width: 520px; box-sizing: border-box; padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px;">
  <div>
    <div class="label">Today &middot; the rail as it renders &middot; 1:1</div>
    <div class="cap" style="margin-top: 4px;">Same plan, same Beats, a screenshot of the live build. Labels truncate at a word, every card spends a line on BOOM, the two Variant halves are unlabelled colour strips, the row hover is invisible on the open section, and the New Beat buttons are the section's own colour.</div>
  </div>
  <img src="today-rail.png" alt="The current Timeline Rail" style="display: block; width: 492px; height: 640px; border-radius: 4px; border: 1px solid ${ink[700]};">
</div>
` + tail;
  writeFileSync("Today.dc.html", html);
}

/* ========================================================== canvas.json */
writeFileSync(
  "canvas.json",
  JSON.stringify(
    {
      artboards: [
        { file: "Today.dc.html", x: 0, y: 0, w: 520, h: 800, title: "Today" },
        { file: "Main.dc.html", x: 620, y: 0, w: 480, h: 720, title: "Reworked rail" },
        { file: "Compact.dc.html", x: 1200, y: 0, w: 380, h: 720, title: "Numbered steps" },
        { file: "BeatCard.dc.html", x: 620, y: 940, w: 920, h: 800, title: "Beat card and Snap" },
      ],
      annotations: [
        { id: "changes", x: 620, y: -260, w: 480, text: "What changed in the rail\n• BOOM word gone. The amber edge alone is the resolve, and a one-line legend above the grid names cast / snap / resolve once.\n• Snap marker on Beats of 3+ steps: a diamond on a dashed seam, hollow tail = frozen on the snapshot. Default is the cast step, so existing Beats look the same.\n• Rows on a fixed 32px pitch with an aligned number gutter and a visible hover state; step actions as icons on any hovered row. Steps are not reorderable.\n• Beat labels wrap to two lines instead of truncating at a word.\n• Variant halves carry their letter on the colour strip.\n• New Beat buttons stand out from the section background.\n• Hovering a Beat draws its snap seam across the rail so the step it lands on is unmistakable.\n• Card body drags the whole Beat; the edges move one end each. Today only the halves resize." },
        { id: "compact-note", x: 1200, y: -180, w: 380, text: "Numbered steps, no names\nThe step column is a 24px number gutter and every per-row action is gone: add a step with the + under the list, delete with Del on the selected step, split from the Beat side. The rail drops from 480px to about 366px while the lanes grow from 66px to 92px, so labels fit on one line. Selected and hovered steps are bands across all lanes, which is how you read which step a card edge sits on without a name." },
      ],
      launch: { view: "canvas" },
    },
    null,
    2
  )
);
console.log("wrote Main, Compact, BeatCard, Today, canvas.json");
