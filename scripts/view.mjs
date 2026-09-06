/**
 * The canvas draws the arena inside a margin so anything on or just past a wall
 * keeps drawing instead of being clipped at the stage edge. Every pixel <-> arena
 * unit conversion in these tests has to use the same factor the canvas does.
 *
 * Mirrors VIEW_MARGIN in src/client/canvas/Scene.tsx.
 */
export const VIEW_MARGIN = 1.18;

/** Pixels per arena unit for a stage `px` wide showing an arena `span` across. */
export const viewScale = (px, span = 1000) => px / (span * VIEW_MARGIN);
