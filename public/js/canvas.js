/**
 * Functional canvas renderers.
 *
 * WHY a canvas module at all: PROMPT.md:1410 defines this app as "a clean
 * utility tool - like a well-made hardware app", and :1477 says no component
 * may use JavaScript when CSS alone is sufficient. So the canvas here is used
 * ONLY where CSS genuinely cannot do the job:
 *
 *   1. dropField   - the drag target. A dashed field with corner ticks and a
 *                    marching dash offset: motion CSS cannot express, and it
 *                    carries real information (is a drag in progress, and will
 *                    it be accepted).
 *   2. presence    - the header device cluster. N overlapping identity chips
 *                    whose count is unbounded; DOM would force the header to
 *                    resize and jitter every time a device joins or leaves.
 *   3. sparkline   - upload throughput over time. A live signal graph.
 *
 * It is deliberately NOT a background, and NOT decorative. Nothing animates
 * while the app is idle: every renderer stops its rAF loop when it has nothing
 * to animate (spec 19: idle CPU ~0%).
 *
 * Every renderer also honours `prefers-reduced-motion: reduce` (spec 1027) by
 * drawing a single static frame.
 * @module canvas
 */

// ===== Shared helpers =====

/** Live design-token lookup, so the canvas always matches the current theme. */
const tokenCache = { theme: null, map: null };

function readTokens() {
  const theme = document.documentElement.dataset.theme || "system";
  if (tokenCache.theme === theme && tokenCache.map) return tokenCache.map;
  const styles = getComputedStyle(document.documentElement);
  const names = [
    "color-accent",
    "color-error",
    "color-text-primary",
    "color-text-secondary",
    "color-border",
    "color-border-strong",
    "color-bg-surface",
    "color-success",
  ];
  // Fall back to the resolved element colour rather than a literal hex: the
  // canvas must never invent a colour the stylesheet did not choose.
  const fallback = styles.color || "currentColor";
  const map = { theme };
  for (const name of names) map[name] = styles.getPropertyValue(`--${name}`).trim() || fallback;
  tokenCache.theme = theme;
  tokenCache.map = map;
  return map;
}

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Size a canvas for the device pixel ratio and return its 2D context.
 * @param {HTMLCanvasElement} canvas
 * @param {number} cssWidth
 * @param {number} cssHeight
 * @returns {CanvasRenderingContext2D|null}
 */
function prepare(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssWidth * dpr));
  const h = Math.max(1, Math.round(cssHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  if (cssWidth) canvas.style.width = `${cssWidth}px`;
  if (cssHeight) canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth || canvas.width / dpr, cssHeight || canvas.height / dpr);
  return ctx;
}

/** Round a rectangle path with per-corner control. */
function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

// ===== 1. Drop field =====

/**
 * Drag-target field renderer.
 *
 * States: "active" (a drag is over the window) and "rejected" (a folder was
 * dropped, which this app cannot accept). Nothing runs while inactive.
 * @param {HTMLCanvasElement} canvas
 * @returns {{activate: (mode?: string) => void, deactivate: () => void, destroy: () => void}}
 */
export function createDropField(canvas) {
  let mode = "inactive";
  let raf = 0;
  let phase = 0;
  let last = 0;
  let width = 0;
  let height = 0;
  let visible = false;

  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    const changed = box.width !== width || box.height !== height;
    width = box.width;
    height = box.height;
    if (changed && mode !== "inactive") draw();
  });

  function draw() {
    if (!width || !height) return;
    const ctx = prepare(canvas, width, height);
    if (!ctx) return;
    const t = readTokens();
    const accepted = mode === "active";
    const stroke = accepted ? t["color-accent"] : t["color-error"];

    // Progressively "sealed" field: the ring draws itself in over the first
    // ~320ms so a drop reads as a confident, immediate state change rather
    // than a blink of the whole screen.
    const p = accepted ? Math.min(1, phase / 320) : 1;

    ctx.save();
    // The field insets from the overlay so the window edge never fights the
    // screen edge on a phone.
    const inset = 12;
    const w = width - inset * 2;
    const h = height - inset * 2;
    const r = 14;
    const perimeter = 2 * (w + h);

    ctx.lineWidth = 2;
    ctx.strokeStyle = stroke;
    ctx.globalAlpha = 0.28 + 0.72 * p;
    ctx.setLineDash([10, 8]);
    // A slow march reads as "live"; it is the only motion in the overlay.
    ctx.lineDashOffset = prefersReducedMotion() ? 0 : -phase * 0.04;
    roundRect(ctx, inset, inset, w, h, r);
    ctx.save();
    ctx.stroke();
    ctx.restore();

    // Second inner hairline, inset, gives the field depth without a gradient.
    ctx.globalAlpha = 0.14 * p;
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    roundRect(ctx, inset + 5, inset + 5, w - 10, h - 10, r - 4);
    ctx.stroke();

    // Corner ticks: the "measurement" motif that reads as instrumentation.
    ctx.globalAlpha = p;
    ctx.lineWidth = 3;
    ctx.setLineDash([]);
    ctx.strokeStyle = stroke;
    const tick = 22;
    const corners = [
      [inset, inset, 1, 1],
      [inset + w, inset, -1, 1],
      [inset, inset + h, 1, -1],
      [inset + w, inset + h, -1, -1],
    ];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * 2, cy + sy * tick);
      ctx.lineTo(cx + sx * 2, cy + sy * 2);
      ctx.quadraticCurveTo(cx + sx * 2, cy, cx + sx * 8, cy);
      ctx.quadraticCurveTo(cx + sx * tick, cy, cx + sx * tick, cy + sy * 2);
      ctx.stroke();
    }

    // Progress arc around the field: confirms the seal, then clears itself so
    // the dashed ring is the resting state.
    if (accepted && p < 1) {
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.strokeStyle = stroke;
      ctx.beginPath();
      ctx.arc(
        inset + w / 2,
        inset + h / 2,
        Math.max(w, h) / 2 - 1,
        -Math.PI / 2,
        -Math.PI / 2 + p * Math.PI * 2
      );
      ctx.stroke();
    }

    // Rejected state: a cross through the field centre.
    if (mode === "rejected") {
      const cx = inset + w / 2;
      const cy = inset + h / 2;
      const arm = 26;
      ctx.globalAlpha = 1;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.strokeStyle = stroke;
      const shake = prefersReducedMotion() ? 0 : Math.sin(phase / 40) * 3;
      ctx.beginPath();
      ctx.moveTo(cx - arm + shake, cy - arm);
      ctx.lineTo(cx + arm + shake, cy + arm);
      ctx.moveTo(cx + arm + shake, cy - arm);
      ctx.lineTo(cx - arm + shake, cy + arm);
      ctx.stroke();
    }

    ctx.restore();
    void perimeter;
  }

  function frame(now) {
    raf = 0;
    if (mode === "inactive" || !visible) return;
    const dt = last ? now - last : 16;
    last = now;
    phase += dt;
    draw();
    raf = window.requestAnimationFrame(frame);
  }

  function start() {
    visible = true;
    last = 0;
    if (prefersReducedMotion()) {
      phase = 400;
      draw();
      return;
    }
    if (!raf) raf = window.requestAnimationFrame(frame);
  }

  function stop() {
    if (raf) window.cancelAnimationFrame(raf);
    raf = 0;
    visible = false;
    last = 0;
    phase = 0;
  }

  observer.observe(canvas);

  return {
    /** @param {"active"|"rejected"} [next] */
    activate(next = "active") {
      mode = next;
      start();
    },
    deactivate() {
      mode = "inactive";
      stop();
    },
    destroy() {
      stop();
      observer.disconnect();
    },
  };
}

// ===== 2. Presence cluster =====

/**
 * Header device-presence cluster.
 *
 * Draws at most five identity chips plus a "+N" counter, so the header keeps a
 * fixed height and never reflows when a device joins. Repaints ONLY when the
 * set of devices actually changes - it is a static render, not an animation.
 * @param {HTMLCanvasElement} canvas
 * @param {{getDevices: () => Array<Object>, selfId: string}} opts
 * @returns {{repaint: () => void, destroy: () => void}}
 */
export function createPresenceCluster(canvas, { getDevices, selfId }) {
  let signature = "";

  function repaint() {
    const devices = getDevices() || [];
    const sorted = [...devices].sort((a, b) =>
      a.id === selfId ? -1 : b.id === selfId ? 1 : a.name?.localeCompare(b.name || "") || 0
    );
    const shown = sorted.slice(0, 5);
    const overflow = sorted.length - shown.length;

    // Cheap change detection: repaint only on a real membership change.
    const next = sorted.map((d) => `${d.id}:${d.name || ""}`).join("|") + `#${selfId}`;
    if (next === signature) return;
    signature = next;

    const size = 24;
    const gap = 2;
    const chip = 22;
    const offset = chip - 8;
    const width = shown.length === 0 ? 0 : shown.length * (chip - offset) + offset;
    const cssHeight = size;

    const ctx = prepare(canvas, width, cssHeight);
    if (!ctx) return;
    const t = readTokens();

    shown.forEach((device, i) => {
      const cx = i * (chip - offset) + chip / 2;
      const cy = cssHeight / 2;
      const isSelf = device.id === selfId;

      // Chip: 1px hairline + surface fill. Self gets the accent ring so the
      // user never has to guess which row on their own screen is "this one".
      ctx.beginPath();
      ctx.arc(cx, cy, chip / 2, 0, Math.PI * 2);
      ctx.fillStyle = device.color || t["color-accent"];
      ctx.fill();

      ctx.lineWidth = 2;
      ctx.strokeStyle = isSelf ? t["color-accent"] : t["color-bg-surface"];
      ctx.stroke();

      // Initials. Two characters, 8px, white, centred.
      const initials = (device.name || "?").trim().slice(0, 2).toUpperCase();
      ctx.fillStyle = "#ffffff";
      ctx.font = '600 8px "Inter", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(initials, cx, cy + 0.5);
    });

    if (overflow > 0) {
      const cx = shown.length * (chip - offset) + chip / 2;
      const cy = cssHeight / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, chip / 2, 0, Math.PI * 2);
      ctx.fillStyle = t["color-bg-surface"];
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = t["color-border-strong"];
      ctx.stroke();
      ctx.fillStyle = t["color-text-secondary"];
      ctx.font = '500 8px "Inter", system-ui, sans-serif';
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`+${overflow}`, cx, cy + 0.5);
    }
    void gap;
  }

  const observer = new ResizeObserver(() => {
    signature = "";
    repaint();
  });
  observer.observe(canvas);

  return {
    repaint,
    destroy() {
      observer.disconnect();
    },
  };
}

// ===== 3. Upload throughput sparkline =====

const SPARK_WINDOW = 10; // seconds of history

/**
 * Throughput sparkline for one upload row.
 *
 * Each sample is one 250ms window (matching the server's progress cadence, so
 * the graph and the numbers cannot disagree). Bars are drawn from the
 * baseline; a stalled transfer visibly flattens, which is the whole point -
 * a bare percentage cannot tell "slow" from "hung".
 * @param {HTMLCanvasElement} canvas
 * @returns {{push: (bytesPerSec: number) => void, destroy: () => void}}
 */
export function createSparkline(canvas) {
  const samples = [];
  let width = 0;
  let height = 0;

  function draw() {
    if (!width || !height) return;
    const ctx = prepare(canvas, width, height);
    if (!ctx) return;
    const t = readTokens();

    // Baseline hairline: the axis the bars grow from.
    ctx.strokeStyle = t["color-border"];
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 0.5);
    ctx.lineTo(width, height - 0.5);
    ctx.stroke();

    if (!samples.length) return;
    const peak = Math.max(1, ...samples);
    const slot = width / SPARK_WINDOW;
    const barW = Math.max(1, slot - 1);

    samples.forEach((value, i) => {
      // The newest sample sits at the right edge; older ones scroll left.
      const x = width - (samples.length - i) * slot;
      if (x < -slot) return;
      const h = Math.max(1.5, (value / peak) * (height - 2));
      ctx.fillStyle = t["color-accent"];
      ctx.globalAlpha = 0.35 + 0.65 * (i / Math.max(1, samples.length - 1));
      ctx.fillRect(Math.max(0, x), height - h - 1, barW, h);
    });
    ctx.globalAlpha = 1;
  }

  /**
   * Record one throughput sample.
   * @param {number} bytesPerSec
   */
  function push(bytesPerSec) {
    samples.push(Math.max(0, bytesPerSec || 0));
    while (samples.length > SPARK_WINDOW) samples.shift();
    draw();
  }

  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (!box) return;
    width = box.width;
    height = box.height;
    draw();
  });
  observer.observe(canvas);

  return {
    push,
    destroy() {
      observer.disconnect();
    },
  };
}
