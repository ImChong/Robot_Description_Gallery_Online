/**
 * Which unit an angle is read in — degrees or radians — and nothing else.
 *
 * A joint value is a number of radians wherever it is stored, driven or
 * solved: the sliders travel in radians, the URDF declares its limits in
 * radians, and the loop solver works in them. Only the reading changes, and
 * the reader picks it once for the whole site rather than once per panel —
 * the detail page's joint tree and the compare stage's floating joint window
 * are two views of the same choice, remembered next to the theme and the
 * language.
 */
const ANGLE_UNITS = ['deg', 'rad'];
const KEY = 'cl-angle-unit';

export const DEG = 180 / Math.PI;

let unit = stored();

function stored() {
  try {
    const saved = localStorage.getItem(KEY);
    if (ANGLE_UNITS.includes(saved)) return saved;
  } catch {
    /* private mode — fall through to the default */
  }
  return 'deg';
}

/** @returns {'deg'|'rad'} */
export function angleUnit() {
  return unit;
}

export function setAngleUnit(next) {
  unit = ANGLE_UNITS.includes(next) ? next : 'deg';
  try {
    localStorage.setItem(KEY, unit);
  } catch {
    /* private mode — the choice just will not persist */
  }
  return unit;
}

/** One angle, in whichever unit is current. */
export function formatAngle(value) {
  return unit === 'rad' ? `${value.toFixed(3)} rad` : `${(value * DEG).toFixed(1)}°`;
}
