// Emits the Timeline modes artboards (Collapsed / Normal / Expanded). Values lifted from src/client/styles.css
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

/* ============================================================ shared bits */
const modeSwitch = (on) => `<div title="Timeline size" style="display: inline-flex; border-radius: 4px; background: ${ink[900]}; border: 1px solid ${ink[600]}; padding: 1px; flex-shrink: 0;">
  ${["Collapsed", "Normal", "Expanded"].map((m) => `<span style="padding: 1px 6px; border-radius: 3px; font-size: 10px; line-height: 14px; ${m === on ? `background: ${ink[600]}; color: #fff;` : `color: ${ink[400]};`}">${m}</span>`).join("")}
</div>`;
const legend = `<div style="display: flex; align-items: center; gap: 10px; padding: 2px 4px 6px; font-size: 9px; line-height: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[400]};">
  <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 2px; background: ${ink[200]};"></span>cast</span>
  <span style="display: inline-flex; align-items: center; gap: 4px;">${diamond(8, ink[200], ink[100])}snap</span>
  <span style="display: inline-flex; align-items: center; gap: 4px;"><span style="width: 10px; height: 3px; background: ${amber};"></span>resolve</span>
</div>`;
const sectionHead = (name, count) => `<div style="display: flex; align-items: center;">
  <div style="flex: 1; min-width: 0; display: flex; align-items: center; gap: 4px; padding: 4px; border-radius: 4px; font-size: 14px; line-height: 20px; color: ${ink[200]}; cursor: grab;">
    <span style="display: inline-flex; color: ${ink[400]}; transform: rotate(90deg);">${icon.chevron}</span>
    <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${name}</span>
    <span style="font-size: 11px; color: ${ink[400]}; flex-shrink: 0;">${count}</span>
  </div>
  <span title="Delete this mechanic and its steps" style="display: grid; place-items: center; width: 24px; height: 24px; color: ${ink[400]};">${icon.x}</span>
</div>`;
const encounterHead = (mode) => `<div class="label">Encounter</div>
<div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px;">
  <span style="font-size: 14px; color: ${ink[200]}; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Paradeigma 1</span>
  <span style="margin-left: auto;">${modeSwitch(mode)}</span>
</div>`;

const beats = [
  { name: "Add cast", parts: "Stack ×1", color: "#b8632f", lo: 0, hi: 4, snap: 2 },
  { name: "Ring", parts: "Donut ×1", color: "#b03a3a", lo: 1, hi: 2 },
  { name: "Line", parts: "Beam ×2", color: "#8c3a6e", lo: 4, hi: 4 },
];
const notes = ["Tanks north, healers south.", "", "", "Bait the ring on the outer edge, then step in.", "", "Swap sides if the line is on the wrong half.", ""];
const SEL = 3;

// The step note as it lives on the arena: NotesCard in Editor.tsx — rounded,
// ink-600/70 border, ink-900/85 fill, 8px padding, 12px text, a shadow, and a
// grab cursor. The rail shows the same card, so what you drag on the arena is
// what you read in the rail.
const noteCard = (text, { focus = false, lines = 0, grip = true, extra = "" } = {}) => {
  const clamp = lines ? `display: -webkit-box; -webkit-line-clamp: ${lines}; -webkit-box-orient: vertical; overflow: hidden;` : "white-space: pre-wrap;";
  const empty = !text;
  return `<div title="Drag to move it on the arena. Double-click to edit" style="display: flex; align-items: flex-start; gap: 6px; box-sizing: border-box; border-radius: 4px; border: 1px solid ${focus ? accent : empty ? "rgba(46,53,67,0.5)" : "rgba(46,53,67,0.7)"}; background: rgba(20,23,28,0.85); padding: 6px 8px 6px 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.35); cursor: grab; ${extra}">
    ${grip ? `<span style="display: inline-flex; flex-shrink: 0; margin-top: 2px; color: ${ink[400]};">${icon.grip}</span>` : ""}
    <span style="flex: 1; min-width: 0; font-size: 12px; line-height: 16px; color: ${empty ? ink[400] : ink[100]}; ${clamp}">${text || "Step notes…"}</span>
  </div>`;
};

// New Beat, Debuff Beat and New Step share one row under the grid: a primary
// and two quieter twins. This replaces the lone "+" row in the gutter.
const addBtn = (text, title, primary) =>
  `<div title="${title}" style="flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; height: 32px; border-radius: 4px; ${primary ? `background: ${ink[600]}; color: #e6ebf2;` : `border: 1px solid ${ink[600]}; color: ${ink[200]};`} font-size: 13px; white-space: nowrap;">${icon.plus}${text}</div>`;
const beatButtons = `<div style="margin-top: 8px; display: flex; gap: 4px;">
  ${addBtn("Beat", "A new Beat casting in the Step you are on. Say where it resolves, then drop its Parts in.", true)}
  ${addBtn("Debuff Beat", "A Beat that deals the fight's debuffs onto role pools.", false)}
  ${addBtn("Step", "A new step after the last one", false)}
</div>`;
// A step that carries a note shows a dot beside its number; the note itself
// lives on the arena card.
const noteDot = (i, gridRow) => notes[i]
  ? `<div aria-hidden="true" title="${notes[i]}" style="grid-column: 1; grid-row: ${gridRow}; justify-self: end; align-self: start; margin: 4px 2px 0 0; width: 4px; height: 4px; border-radius: 50%; background: ${accent}; pointer-events: none;"></div>`
  : "";

/* =============================================================== Normal */
// The rail that shipped on 2026-09-08: numbered gutter, 92px lanes, bands.
{
  const LANE = 92, VLANE = LANE + 12;
  const rowsHtml = steps.map((_, i) => stepRow({ n: i + 1, gridRow: i + 1, compact: true, state: i === SEL ? "selected" : i === 5 ? "hover" : "idle" })).join("\n");
  const band = (i, a) => `<div aria-hidden="true" style="grid-column: 1 / -1; grid-row: ${i + 1}; border-radius: 4px; background: ${a ? ink[600] : "rgba(46,53,67,0.6)"}; pointer-events: none;"></div>`;
  const stackCard = card({ name: "Stack", count: 1, color: "#3f8a3f", lo: 2, hi: 5, snap: 2, gridCol: 1, gridRow: "1 / 5", width: "auto", snapLabel: false });
  const grid = `<div style="display: grid; grid-template-columns: 24px ${LANE}px ${LANE}px ${VLANE}px; column-gap: 4px; row-gap: 4px; grid-auto-rows: ${ROW}px;">
    ${band(SEL, 1)}${band(5, 0)}
    ${rowsHtml}
    ${card({ ...beats[0], count: 1, gridCol: 2, gridRow: "1 / 6", width: LANE })}
    ${card({ ...beats[1], count: 1, gridCol: 3, gridRow: "2 / 4", width: LANE })}
    ${card({ ...beats[2], count: 2, gridCol: 3, gridRow: "5 / 6", width: LANE })}
    ${variantBox({ lo: 2, hi: 5, gridCol: 4, gridRow: "3 / 7", halves: [{ name: "A", color: "#93c5fd", on: true }, { name: "B", color: "#c084fc", on: false }], beat: stackCard })}
    ${steps.map((_, i) => noteDot(i, i + 1)).join("")}
  </div>`;
  const W = 8 * 2 + 4 * 2 + 24 + LANE * 2 + VLANE + 4 * 3 + 2;
  const html = head() + `
<div style="width: ${W}px; min-height: 700px; box-sizing: border-box; background: ${ink[800]}; border-right: 1px solid ${ink[700]}; padding: 8px; display: flex; flex-direction: column;">
  ${encounterHead("Normal")}
  <div style="margin-top: 4px; border-radius: 4px; background: ${ink[700]}; padding: 4px;">
    ${sectionHead("Mechanic 1", 7)}
    ${legend}
    ${grid}
    ${beatButtons}
  </div>
  <div style="margin-top: 12px;">${btn("New mechanic", "A new section of the fight, with a step in it", ink[700])}</div>
</div>
` + tail;
  writeFileSync("Normal.dc.html", html);
}

/* ============================================================= Expanded */
// For editors working the timeline: 40px rows so edges and the diamond are easy
// to grab, 120px lanes so a card carries its Parts, the step note inline on
// its row, and the row's actions visible on the selected row.
{
  const ROWX = 40, GAPX = 4, PITCHX = ROWX + GAPX, LANE = 120, VLANE = LANE + 12, NOTE = 168;
  const xrow = (i) => {
    const st = i === SEL ? "selected" : i === 5 ? "hover" : "idle";
    const bg = st === "selected" ? ink[600] : st === "hover" ? "rgba(46,53,67,0.6)" : "transparent";
    return `<div aria-hidden="true" style="grid-column: 1 / -1; grid-row: ${i + 1}; border-radius: 4px; background: ${bg}; pointer-events: none;"></div>
      <div style="grid-column: 1; grid-row: ${i + 1}; display: grid; place-items: center; height: ${ROWX}px; font-size: 13px; font-weight: ${st === "selected" ? 600 : 400}; color: ${st === "selected" ? "#fff" : ink[400]};">${i + 1}</div>`;
  };
  const noteCell = (i) => {
    const sel = i === SEL;
    const text = notes[i];
    // Every row carries its note as the arena's own card; an empty one is a
    // faint outline you can start typing into on the selected step.
    if (!text && !sel) return `<div style="grid-column: 5; grid-row: ${i + 1};"></div>`;
    return `<div style="grid-column: 5; grid-row: ${i + 1}; display: flex; align-items: center; height: ${ROWX}px;">${noteCard(text, { focus: sel, lines: 2, extra: "width: 100%; height: 34px; padding-top: 1px; padding-bottom: 1px; align-items: center;" })}</div>`;
  };
  const xcard = ({ name, parts, color, lo, hi, snap = lo, hover = false, active = false, gridCol, gridRow, width = LANE, snapLabel = true }) => {
    const rows = hi - lo + 1;
    const height = rows * PITCHX - GAPX;
    const hasSnap = rows >= 3;
    const cut = (snap - lo + 1) * PITCHX - GAPX / 2;
    const frozen = hasSnap && snap < hi;
    const ring = hover ? "box-shadow: 0 0 0 1px rgba(255,255,255,0.25);" : "";
    const w = typeof width === "number" ? `${width}px` : width;
    const grip = (top) => `<div style="position: absolute; left: 50%; ${top ? "top: 3px" : "bottom: 4px"}; transform: translateX(-50%); width: 18px; height: 3px; border-radius: 2px; background: rgba(255,255,255,${top ? 0.55 : 0.75});"></div>`;
    return `<div title="${name} — casts in step ${lo + 1}, resolves in step ${hi + 1}." style="grid-column: ${gridCol}; grid-row: ${gridRow}; position: relative; width: ${w}; height: ${height}px; box-sizing: border-box; border-radius: 4px; border-top: 2px solid ${color}; border-bottom: 3px solid ${amber}; background: ${tint(color, active ? 0.4 : 0.18)}; ${ring} cursor: grab;">
      <div style="position: absolute; inset: 0; border-radius: 2px; overflow: hidden;">
        ${frozen ? `<div style="position: absolute; left: 0; right: 0; top: ${cut}px; bottom: 0; background: rgba(20,23,28,0.35); box-shadow: inset 1px 0 0 ${tint(color, 0.55)}, inset -1px 0 0 ${tint(color, 0.55)};"></div>` : ""}
        <div style="padding: ${hover ? 9 : 6}px 8px 0; font-size: 11px; line-height: 14px; font-weight: 600; color: ${active ? "#fff" : ink[100]}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
        <div style="padding: 1px 8px 0; font-size: 10px; line-height: 13px; color: ${ink[400]}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${parts}</div>
        ${hasSnap && snapLabel ? `<div style="position: absolute; right: 6px; top: ${cut - 14}px; font-size: 9px; line-height: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[200]};">snap</div>` : ""}
      </div>
      ${hover ? grip(true) + grip(false) : ""}
      ${hasSnap ? `<div style="position: absolute; left: 0; right: 0; top: ${cut - 0.5}px; height: 0; border-top: 1px dashed rgba(255,255,255,${hover ? 0.75 : 0.45});"></div>
        <div style="position: absolute; left: -6px; top: ${cut - 6}px; width: 12px; height: 12px; cursor: ns-resize;">${diamond(12, hover ? ink[100] : color, "#e6ebf2")}</div>` : ""}
    </div>`;
  };
  const xvariant = ({ lo, hi, gridCol, gridRow, halves, beat }) => {
    const rows = hi - lo + 1;
    return `<div style="grid-column: ${gridCol}; grid-row: ${gridRow}; position: relative; margin: -4px 0 -4px -2px; display: flex; flex-direction: column; border-radius: 4px; border: 1px solid rgba(107,118,134,0.7); background: rgba(20,23,28,0.7); overflow: hidden; box-sizing: border-box;">
      <div style="display: grid; grid-template-columns: 1fr 1fr; flex: 1; min-height: 0;">
        ${halves.map((h, i) => `<div style="display: flex; flex-direction: column; min-height: 0; ${i ? "border-left: 1px solid rgba(46,53,67,0.6);" : ""} ${h.on ? `background: ${tint(h.color, 0.12)};` : "opacity: 0.6;"}">
          <div style="height: 16px; flex-shrink: 0; background: ${h.color}; display: flex; align-items: center; padding: 0 6px; font-size: 9px; line-height: 16px; font-weight: 700; color: ${ink[900]}; letter-spacing: 0.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${h.name}</div>
          <div style="flex: 1; min-height: 0; padding: 2px; display: grid; grid-template-rows: repeat(${rows}, minmax(0, 1fr)); gap: 4px;">${i === 0 && beat ? beat : ""}</div>
        </div>`).join("")}
      </div>
      <div style="height: 4px; flex-shrink: 0; background: rgba(251,191,36,0.7); border-top: 1px solid rgba(46,53,67,0.6);"></div>
    </div>`;
  };
  const stackCard = xcard({ name: "Stack", parts: "Stack ×1 · Tower ×4", color: "#3f8a3f", lo: 2, hi: 5, snap: 2, gridCol: 1, gridRow: "1 / 5", width: "auto", snapLabel: false });
  const actions = `<div style="grid-column: 6; grid-row: ${SEL + 1}; display: flex; align-items: center; gap: 2px; height: ${ROWX}px;">
    ${[[icon.split, "Add Variant here"], [icon.dup, "Duplicate step"], [icon.plus, "Add step after"], [icon.x, "Delete step"]].map(([ic, t]) => `<span title="${t}" style="display: grid; place-items: center; width: 24px; height: 24px; border-radius: 4px; color: #e6ebf2;">${ic}</span>`).join("")}
  </div>`;
  const grid = `<div style="display: grid; grid-template-columns: 28px ${LANE}px ${LANE}px ${VLANE}px ${NOTE}px 104px; column-gap: 4px; row-gap: ${GAPX}px; grid-auto-rows: ${ROWX}px;">
    ${steps.map((_, i) => xrow(i) + noteCell(i)).join("\n")}
    ${xcard({ ...beats[0], hover: true, gridCol: 2, gridRow: "1 / 6" })}
    ${xcard({ ...beats[1], gridCol: 3, gridRow: "2 / 4" })}
    ${xcard({ ...beats[2], gridCol: 3, gridRow: "5 / 6" })}
    ${xvariant({ lo: 2, hi: 5, gridCol: 4, gridRow: "3 / 7", halves: [{ name: "A · Left", color: "#93c5fd", on: true }, { name: "B · Right", color: "#c084fc", on: false }], beat: stackCard })}
    ${actions}
  </div>`;
  const colHead = `<div style="display: grid; grid-template-columns: 28px ${LANE * 2 + VLANE + 8}px ${NOTE}px 104px; column-gap: 4px; padding: 0 0 4px; font-size: 9px; line-height: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: ${ink[400]};">
    <span></span><span style="padding-left: 4px;">Beats</span><span style="padding-left: 6px;">Step notes</span><span></span>
  </div>`;
  const W = 8 * 2 + 4 * 2 + 28 + LANE * 2 + VLANE + NOTE + 104 + 4 * 5 + 2;
  const html = head() + `
<div style="width: ${W}px; min-height: 760px; box-sizing: border-box; background: ${ink[800]}; border-right: 1px solid ${ink[700]}; padding: 8px; display: flex; flex-direction: column;">
  ${encounterHead("Expanded")}
  <div style="margin-top: 4px; border-radius: 4px; background: ${ink[700]}; padding: 4px;">
    ${sectionHead("Mechanic 1", 7)}
    ${legend}
    ${colHead}
    ${grid}
    ${beatButtons}
  </div>
  <div style="margin-top: 12px;">${btn("New mechanic", "A new section of the fight, with a step in it", ink[700])}</div>
</div>
` + tail;
  writeFileSync("Main.dc.html", html);
  console.log("expanded width", W);
}

/* ============================================================ Collapsed */
// A phone viewing the arena: the rail turns sideways into a strip under the
// arena. Step pills are 40×44 hit targets; each Beat is one thin bar across
// the steps it spans, amber at its resolve end, the diamond on its snap seam.
function collapsedFrame({ file, PW, PH, PAD, AR, laptop = false }) {
  const PILL = 40, PGAP = 4, STEPS = steps.length;
  const stripW = STEPS * PILL + (STEPS - 1) * PGAP; // 304
  const left = Math.round((AR - stripW) / 2);
  const x = (i) => left + i * (PILL + PGAP);
  const pills = steps.map((_, i) => {
    const sel = i === SEL;
    return `<div title="Step ${i + 1}" style="position: absolute; left: ${x(i)}px; top: 0; width: ${PILL}px; height: 44px; display: grid; place-items: center; border-radius: 6px; background: ${sel ? ink[600] : "transparent"}; font-size: 14px; font-weight: ${sel ? 600 : 400}; color: ${sel ? "#fff" : ink[400]};">${i + 1}</div>`;
  }).join("");
  const bar = ({ color, lo, hi, snap = lo }, lane) => {
    const l = x(lo), r = x(hi) + PILL;
    const rows = hi - lo + 1, hasSnap = rows >= 3;
    const cut = hasSnap ? x(snap) + PILL + PGAP / 2 : 0;
    const frozen = hasSnap && snap < hi;
    return `<div style="position: absolute; left: ${l}px; top: ${lane * 12}px; width: ${r - l}px; height: 8px; box-sizing: border-box; border-radius: 2px; border-left: 2px solid ${color}; border-right: 3px solid ${amber}; background: ${tint(color, 0.3)}; overflow: visible;">
      ${frozen ? `<div style="position: absolute; left: ${cut - l - 2}px; right: 0; top: 0; bottom: 0; background: rgba(20,23,28,0.5); box-shadow: inset 0 1px 0 ${tint(color, 0.55)}, inset 0 -1px 0 ${tint(color, 0.55)};"></div>` : ""}
      ${hasSnap ? `<div style="position: absolute; left: ${cut - l - 6}px; top: -2px; width: 12px; height: 12px;">${diamond(12, color, "#e6ebf2")}</div>` : ""}
    </div>`;
  };
  const stackBar = bar({ color: "#3f8a3f", lo: 2, hi: 5, snap: 2 }, 3);
  const band = `<div aria-hidden="true" style="position: absolute; left: ${x(SEL)}px; top: -4px; width: ${PILL}px; height: 52px; border-radius: 4px; background: rgba(46,53,67,0.5);"></div>`;
  const chip = (cx, cy, color, txt) => `<div style="position: absolute; left: ${cx - 14}px; top: ${cy - 14}px; width: 28px; height: 28px; border-radius: 6px; background: ${tint(color, 0.35)}; border: 1.5px solid ${color}; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff;">${txt}</div>`;
  const arena = `<div style="position: relative; width: ${AR}px; height: ${AR}px; border-radius: 8px; background: ${ink[700]}; border: 1px solid ${ink[600]}; overflow: hidden;">
    <div aria-hidden="true" style="position: absolute; inset: 0; background: linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px) 0 0 / 100% 25%, linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px) 0 0 / 25% 100%;"></div>
    <div aria-hidden="true" style="position: absolute; left: ${AR / 2 - 60}px; top: ${AR / 2 - 60}px; width: 120px; height: 120px; border-radius: 50%; border: 2px solid #b03a3a; background: rgba(176,58,58,0.18);"></div>
    <div aria-hidden="true" style="position: absolute; left: ${AR / 2 - 70}px; top: ${AR / 2 - 22}px; width: 44px; height: 44px; border-radius: 50%; border: 2px solid #3f8a3f; background: rgba(63,138,63,0.25);"></div>
    ${chip(AR / 2, 40, "#3b82f6", "MT")}${chip(AR / 2, AR - 40, "#3b82f6", "OT")}
    ${chip(52, AR / 2, "#22c55e", "H1")}${chip(AR - 52, AR / 2, "#22c55e", "H2")}
    ${chip(90, 90, "#ef4444", "M1")}${chip(AR - 90, 90, "#a855f7", "R2")}
    ${chip(90, AR - 90, "#ef4444", "M2")}${chip(AR - 90, AR - 90, "#eab308", "R1")}
    <div style="position: absolute; left: 8px; top: 8px; font-size: 10px; line-height: 14px; color: ${ink[400]};">N</div>
  </div>`;
  const strip = `<div style="border-radius: 6px; background: ${ink[800]}; border: 1px solid ${ink[700]}; padding: 8px 0 10px;">
    <div style="display: flex; align-items: center; gap: 6px; padding: 0 12px 8px;">
      <span style="display: inline-flex; color: ${ink[400]}; transform: rotate(180deg);">${icon.chevron}</span>
      <span style="flex: 1; min-width: 0; text-align: center; font-size: 12px; line-height: 16px; color: ${ink[200]}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Mechanic 1</span>
      <span style="display: inline-flex; color: ${ink[400]};">${icon.chevron}</span>
      ${laptop ? "" : `<span style="margin-left: 6px;">${modeSwitch("Collapsed")}</span>`}
    </div>
    <div style="position: relative; height: 44px;">${pills}</div>
    <div style="position: relative; height: 48px; margin-top: 6px;">
      ${band}
      ${bar(beats[0], 0)}${bar(beats[1], 1)}${bar(beats[2], 1)}${stackBar}
    </div>
    <div style="display: flex; align-items: center; gap: 8px; padding: 0 ${left}px; margin-top: 2px;">
      <div title="Step Variant on steps 3–6" style="display: inline-flex; border-radius: 4px; overflow: hidden; border: 1px solid rgba(107,118,134,0.7); font-size: 10px; line-height: 18px; font-weight: 700; letter-spacing: 0.04em;">
        <span style="padding: 0 8px; background: #93c5fd; color: ${ink[900]};">A</span><span style="padding: 0 8px; color: ${ink[200]};">B</span>
      </div>
      <div style="flex: 1; min-width: 0;">${noteCard(notes[SEL], { lines: 1, grip: false, extra: "padding: 4px 8px;" })}</div>
    </div>
  </div>`;
  const nav = `<div style="display: flex; gap: 8px;">
    <div style="flex: 1; height: 44px; border-radius: 6px; background: ${ink[700]}; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; color: ${ink[200]};"><span style="display: inline-flex; transform: rotate(180deg);">${icon.chevron}</span>Step 3</div>
    <div style="flex: 1; height: 44px; border-radius: 6px; background: ${ink[700]}; display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 14px; color: ${ink[200]};">Step 5<span style="display: inline-flex;">${icon.chevron}</span></div>
  </div>`;
  const phone = `
<div style="width: ${PW}px; min-height: ${PH}px; box-sizing: border-box; background: ${ink[900]}; padding: 56px ${PAD}px 24px; display: flex; flex-direction: column; gap: 12px;">
  <div style="display: flex; align-items: baseline; gap: 8px;">
    <span style="font-size: 16px; font-weight: 600; color: #e6ebf2;">Paradeigma 1</span>
    <span style="font-size: 11px; color: ${ink[400]};">P12S · viewing</span>
    <span style="margin-left: auto; font-size: 12px; color: ${ink[400]};">Step 4 / 7</span>
  </div>
  ${arena}
  ${strip}
  ${nav}
</div>`;
  // A small laptop: the app's own top bar, the arena as tall as the window
  // allows, the strip under it at the arena's width. W and S walk the steps, so
  // the big prev/next buttons stay on the phone.
  const topbar = `<div style="display: flex; align-items: center; gap: 10px; height: 44px; padding: 0 12px; background: ${ink[800]}; border-bottom: 1px solid ${ink[700]};">
    <span style="padding: 4px 8px; border-radius: 4px; background: ${ink[700]}; font-size: 12px; color: ${ink[200]};">← Plans</span>
    <span style="font-size: 13px; font-weight: 600; color: #e6ebf2;">Paradeigma 1</span>
    <span style="font-size: 11px; color: ${ink[400]};">rev 22 · live · viewing</span>
    <span style="margin-left: auto;">${modeSwitch("Collapsed")}</span>
    <span style="padding: 4px 8px; border-radius: 4px; background: ${ink[700]}; font-size: 12px; color: ${ink[200]};">Share</span>
  </div>`;
  const desk = `
<div style="width: ${PW}px; height: ${PH}px; box-sizing: border-box; background: ${ink[900]}; display: flex; flex-direction: column; overflow: hidden;">
  ${topbar}
  <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 10px ${PAD}px;">
    ${arena}
    <div style="width: ${AR}px;">${strip}</div>
  </div>
</div>`;
  writeFileSync(file, head() + (laptop ? desk : phone) + tail);
}
collapsedFrame({ file: "Collapsed.dc.html", PW: 390, PH: 844, PAD: 16, AR: 358 });
collapsedFrame({ file: "Laptop.dc.html", PW: 1280, PH: 720, PAD: 16, AR: 500, laptop: true });

/* ========================================================== canvas.json */
writeFileSync(
  "canvas.json",
  JSON.stringify(
    {
      artboards: [
        { file: "Collapsed.dc.html", x: 0, y: 0, w: 390, h: 844, title: "Collapsed · phone, viewing" },
        { file: "Normal.dc.html", x: 500, y: 0, w: 366, h: 720, title: "Normal · today" },
        { file: "Main.dc.html", x: 960, y: 0, w: 780, h: 780, title: "Expanded · editing" },
        { file: "Laptop.dc.html", x: 0, y: 1000, w: 1280, h: 720, title: "Collapsed · small laptop, viewing" },
      ],
      annotations: [
        { id: "collapsed-note", x: 0, y: -260, w: 390, text: "Collapsed = viewing\nA non-editing mode for any screen, not only phones: a shared link, a raider reading the plan mid-prog, an old laptop. The rail turns sideways under the arena so the arena takes the whole width. Step pills are 40×44 taps; each Beat is one 8px bar across the steps it spans, cast colour on the left, amber on the right, the diamond on its snap seam and the hollow tail after it. Variants are an A/B pill; the step note strip stands in for the arena card, which is hidden here. Tapping a bar jumps to its cast step." },
        { id: "laptop-note", x: 1320, y: 1000, w: 300, text: "Same mode on a 1280×720 laptop\nThe app's top bar, then the arena as tall as the window allows, and the strip under it at the arena's width. No prev/next buttons: W and S walk the steps, or click a pill. Nothing in the strip edits." },
        { id: "normal-note", x: 500, y: -190, w: 366, text: "Normal = edit\nThe shipped rail plus: the mode switch in the header, one Beat · Debuff Beat · Step row under the grid instead of the lone + in the gutter, and no notes pane, since the arena card is the note. A step that carries one shows a dot by its number; hover reads it." },
        { id: "expanded-note", x: 960, y: -260, w: 780, text: "Expanded\nFor working the timeline: 40px rows so the cast and resolve edges, the body and the diamond are easy to grab, and the hovered card shows its grips. 120px lanes let a card carry its Parts under its name and label the snap seam. The step note sits on its own row as a column, editable in place on the selected step, so you read the whole mechanic top to bottom without switching panes. Variant strips carry their full names. The selected row also shows its actions, since there is room and right-click is invisible; drop them if you would rather keep the menu as the only path." },
      ],
      launch: { view: "canvas" },
    },
    null,
    2
  )
);
console.log("wrote Collapsed, Normal, Main(Expanded), canvas.json");
