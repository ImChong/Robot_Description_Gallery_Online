/**
 * The UI's icons, drawn as inline SVG.
 *
 * They used to be single Unicode glyphs (⟳ ◐ ⤢ ⭳ ⬇ 📦), which makes the icon
 * row a font lottery: ⭳ (U+2B73) and ⤢ (U+2922) are absent from the default
 * families on Windows and most Android builds, where they come out as a tofu
 * box, and 📦 turns into a full-colour emoji beside a monochrome arrow. Drawn
 * here instead they render identically everywhere, take the button's own
 * colour through `currentColor`, and stay sharp at any zoom.
 *
 * One 24×24 grid, stroked rather than filled, so the whole set shares a weight
 * — the stroke itself is set in CSS (`.icon`), next to the sizes.
 */

const ICONS = {
  /** Reset pose: the standard "undo" loop, back the way it came. */
  reset: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',

  /**
   * Auto rotate: the two-axis mark for turning something in 3D, arrowed in the
   * direction of travel. It replaces the half-lit circle (◐) that stood here
   * and read as a brightness control, and it deliberately is not another ring
   * arrow — that shape belongs to `reset`, one button along.
   */
  rotate:
    '<path d="M16.47 7.5C15.64 4.24 13.95 2 12 2 9.24 2 7 6.48 7 12s2.24 10 5 10c.34 0 .68-.07 1-.2"/>' +
    '<path d="M19 15.57c-1.8.89-4.27 1.43-7 1.43-5.52 0-10-2.24-10-5s4.48-5 10-5c4.84 0 8.87 1.72 9.8 4"/>' +
    '<path d="m15.19 13.71 3.82 1.86-1.86 3.81"/>',

  /** Fit view: the subject sat squarely inside the frame. */
  fit:
    '<path d="M3 8.5V5a2 2 0 0 1 2-2h3.5"/><path d="M15.5 3H19a2 2 0 0 1 2 2v3.5"/>' +
    '<path d="M21 15.5V19a2 2 0 0 1-2 2h-3.5"/><path d="M8.5 21H5a2 2 0 0 1-2-2v-3.5"/>' +
    '<rect x="8.5" y="9.5" width="7" height="5" rx="1"/>',

  /**
   * Fullscreen: the diagonal pair of arrows pushing out to opposite corners.
   * Deliberately not the corner brackets — those are `fit`, two buttons along,
   * and the two marks would be told apart only by the rect in the middle.
   */
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7.5 7.5"/><path d="M3 21l7.5-7.5"/>',

  /** Leave fullscreen: the same arrows, coming back in. */
  minimize: '<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="M14 10l7-7"/><path d="M3 21l7-7"/>',

  /** Save PNG: a camera, because the file it saves is a picture of the stage. */
  camera:
    '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>' +
    '<circle cx="12" cy="13" r="3"/>',

  /**
   * Arrange: the four-way move mark, for the mode in which dragging a machine
   * slides it across the floor rather than orbiting the stage around it.
   */
  move:
    '<path d="M12 2v20"/><path d="M2 12h20"/>' +
    '<path d="m9 5 3-3 3 3"/><path d="m9 19 3 3 3-3"/>' +
    '<path d="m5 9-3 3 3 3"/><path d="m19 9 3 3-3 3"/>',

  /** Snap: a magnet, for placements that land on the floor grid's own lines. */
  magnet:
    '<path d="M6 3H3v8a9 9 0 0 0 18 0V3h-3v8a6 6 0 0 1-12 0z"/>' +
    '<path d="M3 8h3"/><path d="M18 8h3"/>',

  /**
   * Play: the tour of every joint, out to both its limits and back. A mode
   * rather than an action — the same button stops it — so it stays lit while
   * it runs, as `rotate` does.
   */
  play: '<path d="M7 4.5 19.5 12 7 19.5z"/>',

  /** Download: one mark for all three archives, which differ in payload only. */
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>',
};

/**
 * Icon markup, ready to drop into a template.
 * @param {keyof ICONS} name
 * @returns {string} SVG, hidden from assistive tech — every icon here sits
 *   beside a label or on a button that carries its own `aria-label`.
 */
export function icon(name) {
  const body = ICONS[name];
  if (!body) throw new Error(`unknown icon: ${name}`);
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Fill in every `data-icon` placeholder in static markup. */
export function paintIcons(root = document) {
  for (const host of root.querySelectorAll('[data-icon]')) {
    host.innerHTML = icon(host.dataset.icon);
  }
}
