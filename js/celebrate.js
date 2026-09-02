// ---------------------------------------------------------------------------
//  Clearing a balance is the whole point of the app, and it used to just
//  turn grey. A short burst of confetti and a haptic tap is the one place a
//  flourish earns its keep.
//
//  Hand-drawn on a canvas rather than pulled from a library: the app is meant
//  to work offline, and a CDN script is exactly the thing that would not.
// ---------------------------------------------------------------------------

window.SW = window.SW || {};

(function () {
  const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  function palette() {
    // Read the live theme tokens, so the burst matches light and dark.
    const css = getComputedStyle(document.documentElement);
    return ['--teal', '--owed', '--cat-2', '--cat-3', '--cat-6']
      .map(function (name) { return css.getPropertyValue(name).trim(); })
      .filter(Boolean);
  }

  SW.celebrate = function (message) {
    if (message) SW.toast(message, 'ok');

    // A short, sharp buzz. Unsupported on iOS Safari, where it is a no-op.
    if (navigator.vibrate) { try { navigator.vibrate([12, 40, 18]); } catch (e) {} }

    if (REDUCED.matches) return;

    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText =
      'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:300';
    document.body.appendChild(canvas);

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.width = Math.floor(window.innerWidth * dpr);
    const h = canvas.height = Math.floor(window.innerHeight * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return; }

    const colours = palette();
    const pieces = [];
    const COUNT = 90;

    // Two fountains from the lower corners, which reads as celebration
    // rather than as something falling apart.
    for (let i = 0; i < COUNT; i++) {
      const fromLeft = i % 2 === 0;
      const spread = (Math.random() - 0.5) * 1.1;
      pieces.push({
        x: fromLeft ? w * 0.12 : w * 0.88,
        y: h * 1.02,
        vx: (fromLeft ? 1 : -1) * (2.2 + Math.random() * 3.4) * dpr + spread * dpr,
        vy: -(11 + Math.random() * 7) * dpr,
        size: (4 + Math.random() * 5) * dpr,
        spin: (Math.random() - 0.5) * 0.34,
        angle: Math.random() * Math.PI,
        colour: colours[i % colours.length],
        life: 0,
      });
    }

    const GRAVITY = 0.34 * dpr;
    const DRAG = 0.988;
    const MAX_FRAMES = 150;
    let frame = 0;

    function tick() {
      ctx.clearRect(0, 0, w, h);
      frame++;

      let alive = 0;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        p.vy += GRAVITY;
        p.vx *= DRAG;
        p.x += p.vx;
        p.y += p.vy;
        p.angle += p.spin;
        p.life++;

        if (p.y > h + 40 * dpr) continue;
        alive++;

        // Fade out over the last third, so nothing vanishes mid-air.
        const fade = frame > MAX_FRAMES * 0.66
          ? Math.max(0, 1 - (frame - MAX_FRAMES * 0.66) / (MAX_FRAMES * 0.34))
          : 1;

        ctx.save();
        ctx.globalAlpha = fade;
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle = p.colour;
        // Thin rectangles tumble more convincingly than dots.
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }

      if (alive > 0 && frame < MAX_FRAMES) {
        requestAnimationFrame(tick);
      } else {
        canvas.remove();
      }
    }

    requestAnimationFrame(tick);
  };

  // Fire only when a balance has actually just reached zero from somewhere
  // else, so recording a ₹0 payment does not set off fireworks.
  SW.celebrateIfCleared = function (before, after, message) {
    if (before !== 0 && after === 0) SW.celebrate(message);
  };
})();
