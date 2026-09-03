/**
 * What a joint's slider can do, and what it looks like to run every one of them
 * in turn.
 *
 * The tour is the fastest reading of a description there is. A still render
 * says what a machine looks like; a panel of sixty sliders says how many joints
 * it has and where their limits are; only watching each of them travel says
 * which of the sixty is the shoulder roll and which the wrist, and how far the
 * description actually lets it go. It asks nothing of the reader but one press.
 *
 * Two views run it now — the detail page's joint tree and the compare stage's
 * floating window, where several machines may be touring at once — so it lives
 * here rather than in either. What it needs of a caller is small and stated as
 * hooks: which joints and in what order, how to read them, how to write one,
 * and where to put the pose back. Nothing here touches the DOM.
 *
 * The pose is borrowed, not spent: every joint is handed back the value it held
 * when its turn began, so the robot the tour finishes on is the robot it
 * started from — and so is the one it is stopped on part-way.
 */
import { angleUnit } from './angle-unit.js';

/**
 * How long one joint's turn lasts, start to finish — out to its upper limit,
 * across to its lower one, and back to where it stood. A second is long enough
 * to read what the joint does and short enough that a humanoid's sixty of them
 * are a minute rather than an afternoon.
 */
export const SWEEP_MS = 1000;

/** Under this the whole turn is a joint standing still — a range the URDF
 *  pins shut — and the tour spends its second on the next joint instead. */
const SWEEP_EPS = 1e-6;

const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Ease in and out across the whole of one joint's turn, so it sets off and
 *  arrives the way a joint driven by a controller would rather than snapping
 *  into motion at full speed. The three legs of the turn share the second in
 *  proportion to how far each one travels, so the speed is one speed. */
const sweepEase = (u) => (u < 0.5 ? 2 * u * u : 1 - (-2 * u + 2) ** 2 / 2);

/**
 * How far a slider may travel: what the description declares, or a working
 * range where it declares none — a joint whose `<limit>` carries only effort
 * and velocity is not a joint pinned at zero, and the panel is the only place
 * that can say so.
 */
export function sliderRange(joint) {
  if (joint.hasLimits) return [joint.lower, joint.upper];
  return joint.type === 'prismatic' ? [-0.5, 0.5] : [-Math.PI, Math.PI];
}

/**
 * The slider still travels in radians — only the readout changes unit — but its
 * step follows what is on screen, so one arrow key is a round 0.1° in degree
 * mode and 0.001 rad in radian mode rather than an odd number in either.
 */
export function sliderStep(joint) {
  if (joint.type === 'prismatic') return 0.001;
  return angleUnit() === 'rad' ? 0.001 : Math.PI / 1800;
}

/**
 * Where one joint stands part-way through its turn. `legs` is the path — out,
 * across, home — and `spans` how long each of them is; the eased progress is
 * distance along the whole path, so it is walked leg by leg until it runs out.
 */
function sweepValue(step, u) {
  let left = sweepEase(u) * step.total;
  for (let i = 0; i < step.legs.length; i += 1) {
    const [from, to] = step.legs[i];
    const span = step.spans[i];
    if (left <= span || i === step.legs.length - 1) {
      return span ? from + (to - from) * clamp01(left / span) : to;
    }
    left -= span;
  }
  return step.from;
}

export class JointSweep {
  /**
   * @param {{
   *   order: () => string[],
   *   read: () => Array<object>,
   *   write: (name: number|string, value: number) => void,
   *   pose: (pose: Record<string, number>) => void,
   *   onFrame?: () => void,
   *   onStep?: (name: ?string) => void,
   *   onStateChange?: () => void,
   * }} hooks `order` is which joints get a turn and in which order — the
   *   panel's own order, since reading down a branch is reading down the chain;
   *   `read` is the current joint list; `write` drives one; `pose` puts a whole
   *   configuration back, which is how the joints a closed loop solves for are
   *   returned. The three callbacks are for the panel: repaint, which row's
   *   turn it is, and whether the tour is running at all.
   */
  constructor(hooks) {
    this.hooks = hooks;
    /** @type {?{names: string[], index: number, frame: number, step: ?object}} */
    this.run = null;
  }

  get running() {
    return !!this.run;
  }

  toggle() {
    if (this.run) this.stop();
    else this.start();
  }

  start() {
    if (this.run) return;
    const names = this.hooks.order();
    if (!names.length) return;
    this.run = { names, index: -1, frame: 0, step: null };
    this.hooks.onStateChange?.();
    this.next();
  }

  /**
   * Stop, wherever the tour has got to. The joint in flight is put back first:
   * it was borrowed for the length of its turn, and a tour stopped half-way
   * through one would otherwise leave the robot in a pose nobody chose.
   */
  stop() {
    const run = this.run;
    if (!run) return;
    this.run = null;
    if (run.frame) cancelAnimationFrame(run.frame);
    if (run.step) this.restore(run.step);
    this.hooks.onStep?.(null);
    this.hooks.onFrame?.();
    this.hooks.onStateChange?.();
  }

  /**
   * One joint's turn, then the next. Each turn schedules its own frames and
   * hands over at the end of them, so the tour is a chain of animations rather
   * than one timer that has to know where every joint is.
   */
  next() {
    const run = this.run;
    const step = this.step();
    if (!step) {
      this.stop();
      return;
    }
    run.step = step;
    this.hooks.onStep?.(step.name);
    const start = performance.now();
    const tick = (now) => {
      // A tour that was stopped, or replaced by a newer one, no longer owns
      // this frame: the pose has already been handed back by whoever stopped it.
      if (this.run !== run) return;
      const u = Math.min(1, (now - start) / SWEEP_MS);
      this.hooks.write(step.name, sweepValue(step, u));
      // The whole panel, not just this row: a joint that mimics this one moves
      // with it in the model, and its readout is only honest if it says so.
      this.hooks.onFrame?.();
      if (u < 1) {
        run.frame = requestAnimationFrame(tick);
      } else {
        // The joint is home by now — `sweepValue` ends where it began — but the
        // loop it belongs to, if any, is not, and that is what this puts back.
        this.restore(step);
        this.hooks.onFrame?.();
        run.frame = 0;
        this.next();
      }
    };
    run.frame = requestAnimationFrame(tick);
  }

  /**
   * The next joint worth a turn, and the path its turn takes: out to the upper
   * limit, across to the lower one, home again. The bounds are the slider's own
   * rather than the URDF's, so the tour goes exactly as far as a hand dragging
   * that slider could — a continuous joint gets its full turn, and one whose
   * description declares no limit at all gets the working range the panel
   * invents for it instead of freezing at zero.
   *
   * A joint with nowhere to go is passed over rather than given a second of
   * stillness: a range pinned shut says all it has to say in the panel.
   */
  step() {
    const run = this.run;
    const joints = new Map(this.hooks.read().map((joint) => [joint.name, joint]));
    while ((run.index += 1) < run.names.length) {
      const name = run.names[run.index];
      const joint = joints.get(name);
      if (!joint) continue;
      const [lower, upper] = sliderRange(joint);
      if (!Number.isFinite(lower) || !Number.isFinite(upper)) continue;
      // Where it stands now, held inside its own travel: the loader can park a
      // joint outside the limits its description declares, and the tour has no
      // business ending it up somewhere its slider cannot reach.
      const from = Math.min(Math.max(joint.value, lower), upper);
      if (!Number.isFinite(from)) continue;
      const legs = [
        [from, upper],
        [upper, lower],
        [lower, from],
      ];
      const spans = legs.map(([a, b]) => Math.abs(b - a));
      const total = spans.reduce((sum, span) => sum + span, 0);
      if (total < SWEEP_EPS) continue;
      // Where the joints a closed loop solves for stand as this turn begins.
      // They are moved by this one without being driven by it, and a turn that
      // carries a five-bar leg through the configuration where it is exactly
      // straight comes back down the other branch of the mechanism — so the
      // tour hands them back too, or a robot it has finished with is not the
      // robot it started on.
      return { name, from, legs, spans, total, loop: this.loopPose() };
    }
    return null;
  }

  /**
   * Where every joint a closed loop solves for stands right now — the half of
   * the pose no slider writes. Null when the robot has no closed loop, which
   * is every robot in the gallery but one.
   */
  loopPose() {
    const pose = {};
    for (const joint of this.hooks.read()) {
      if (joint.loop) pose[joint.name] = joint.value;
    }
    return Object.keys(pose).length ? pose : null;
  }

  /** Put one turn's joint — and the loop it moved on the way — back where the
   *  turn found them. */
  restore(step) {
    this.hooks.write(step.name, step.from);
    if (step.loop) this.hooks.pose(step.loop);
  }
}
