/*
 * Dechonk blackhole: node_modules falls in, nothing comes back.
 *
 * A Gargantua-style renderer in vanilla canvas 2D:
 *   - turbulent filamentary accretion disk with Keplerian shear
 *   - relativistic Doppler beaming (approaching side bright/white,
 *     receding side dim/red) via a radius x doppler color LUT
 *   - gravitationally lensed far-side arcs over and under the shadow
 *   - nested photon rings hugging a true-black shadow
 *   - node_modules folders that spaghettify at the horizon
 *
 * Transparent canvas (page background shows through), DPR-aware,
 * pauses when hidden/offscreen, static frame under reduced motion,
 * adaptive particle tiers if the frame budget slips.
 */
(function () {
  'use strict';

  var canvas = document.getElementById('blackhole');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var TAU = Math.PI * 2;
  var TILT = 0.21;            // disk inclination (near-edge-on)
  var RS = 0.118;             // shadow radius as fraction of scene size
  var R_IN = 1.55;            // disk inner edge (ISCO), in shadow radii
  var R_OUT = 4.1;            // disk outer edge
  var BETA = 0.45;            // doppler strength
  var OMEGA_K = 2.05;         // keplerian constant: omega = K / r^1.5 rad/s
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var W = 0, H = 0, dpr = 1, cx = 0, cy = 0, rsp = 0;
  var stars = [], disk = [], topArc = [], underArc = [], folders = [];
  var tier = 0, frame = 0, emaDt = 16, running = false, visible = true, rafId = 0, lastT = 0;

  function rand(min, max) { return min + Math.random() * (max - min); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- color: radius band x doppler band LUT ---------- */

  var RAMP = [ // hot inner -> cool outer
    [255, 246, 224], [255, 233, 184], [255, 210, 138], [255, 180, 94],
    [251, 146, 60], [249, 115, 55], [236, 96, 64], [211, 76, 64]
  ];
  var HOT = [255, 250, 240], COOL = [186, 62, 52];
  var LUT = [];

  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  (function buildLUT() {
    for (var rb = 0; rb < 8; rb++) {
      LUT[rb] = [];
      for (var db = 0; db < 12; db++) {
        var t = db / 11;                                   // 0 receding .. 11 approaching
        var base = RAMP[rb];
        var col = mix(mix(COOL, base, 0.55 + 0.45 * t), HOT, t * t * 0.55);
        var alpha = clamp((0.55 + 0.4 * (7 - rb) / 7) * (0.3 + 1.0 * Math.pow(t, 1.4)), 0.05, 0.95);
        LUT[rb][db] = 'rgba(' + (col[0] | 0) + ',' + (col[1] | 0) + ',' + (col[2] | 0) + ',' + alpha.toFixed(3) + ')';
      }
    }
  })();

  function radiusBand(r) { return clamp(((r - R_IN) / (R_OUT - R_IN) * 8) | 0, 0, 7); }
  function dopplerBand(a) {
    var d = 1 - BETA * Math.cos(a);                        // approaching = left limb
    return clamp(((d - 0.55) / 0.9 * 11) | 0, 0, 11);
  }

  /* ---------- scene ---------- */

  function makeFilament(scale) {
    var r0 = rand(R_IN + 0.08, R_OUT - 0.15);
    if (Math.random() < 0.55) r0 = rand(R_IN + 0.05, R_IN + 0.9); // denser inner disk
    var life = rand(4, 9);
    var f = {
      r0: r0, dr: rand(0.03, 0.1),
      phi: rand(0, TAU),
      L0: rand(0.12, 0.34),
      life: life, age: rand(0, life),
      pts: [], w: r0 < 2.3 ? 2.3 : 1.6,
      flick: rand(0, TAU), flickSpd: rand(0.4, 1.3)
    };
    var n = Math.round(20 * scale) + 4;
    for (var j = 0; j < n; j++) {
      f.pts.push({ u: j / (n - 1) - 0.5, rj: rand(-1, 1), z: rand(-1, 1), ja: rand(-0.02, 0.02) });
    }
    return f;
  }

  function makeArcChain(isTop, scale) {
    var n = Math.round((isTop ? 18 : 13) * scale) + 3;
    var pts = [];
    for (var j = 0; j < n; j++) pts.push({ u: j / (n - 1), z: rand(-0.02, 0.02), ja: rand(-0.015, 0.015) });
    return {
      pts: pts, isTop: isTop,
      phi: rand(-0.1, 0.1),
      spd: rand(0.01, 0.035) * (Math.random() < 0.5 ? -1 : 1),
      len: rand(0.55, 1.0),                         // fraction of the arc it covers
      off: Math.random(),                           // position along the arc
      flick: rand(0, TAU), flickSpd: rand(0.3, 1.1),
      r: isTop ? rand(1.36, 1.5) : rand(1.42, 1.56),
      tilt: isTop ? rand(0.5, 0.58) : rand(0.54, 0.62)
    };
  }

  function buildScene() {
    var S = Math.min(W, H);
    rsp = S * RS;
    cx = W / 2; cy = H / 2;

    stars = [];
    var starCount = Math.round(S * 0.2);
    for (var i = 0; i < starCount; i++) {
      stars.push({
        x: Math.random() * W, y: Math.random() * H,
        s: Math.random() < 0.85 ? 1 : 1.6,
        a: rand(0.12, 0.65), ph: Math.random() * TAU
      });
    }

    var scale = [1, 0.62, 0.42][tier];
    disk = [];
    var count = Math.round(S * 0.19 * scale) + 20;
    for (var k = 0; k < count; k++) disk.push(makeFilament(scale));

    topArc = []; underArc = [];
    var nTop = Math.round(24 * scale) + 6, nUnder = Math.round(14 * scale) + 4;
    for (k = 0; k < nTop; k++) topArc.push(makeArcChain(true, scale));
    for (k = 0; k < nUnder; k++) underArc.push(makeArcChain(false, scale));

    folders = [];
    for (k = 0; k < 5; k++) {
      folders.push({
        a: rand(0, TAU), r: rand(2.1, 3.6),
        drift: rand(0.16, 0.3), ph: Math.random() * TAU,
        // deterministic per slot: two npm, one cargo, one Go build
        // cache, one Gradle caches (Maven repo lives on the scanboard)
        label: k === 1 ? 'target' : k === 3 ? 'go-build' : k === 4 ? 'caches' : 'node_modules'
      });
    }
  }

  function resize() {
    var box = canvas.parentElement.getBoundingClientRect();
    if (!box.width || !box.height) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.round(box.width); H = Math.round(box.height);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    buildScene();
    if (reduced) draw(46000);
  }

  /* ---------- primitives ---------- */

  function drawStars(t) {
    ctx.clearRect(0, 0, W, H);
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      var tw = reduced ? 1 : 0.7 + 0.3 * Math.sin(t * 0.0012 + s.ph);
      ctx.globalAlpha = s.a * tw;
      ctx.fillStyle = '#e4e4e7';
      ctx.fillRect(s.x, s.y, s.s, s.s);
    }
    ctx.globalAlpha = 1;
  }

  function drawHalo() {
    ctx.globalCompositeOperation = 'lighter';
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, TILT * 1.7);
    var g = ctx.createRadialGradient(0, 0, rsp, 0, 0, 3.6 * rsp);
    g.addColorStop(0, 'rgba(255, 178, 96, 0.20)');
    g.addColorStop(0.45, 'rgba(249, 115, 55, 0.09)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(-3.7 * rsp, -3.7 * rsp, 7.4 * rsp, 7.4 * rsp);
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawShadow() {
    // silhouette + light-bending moat around it
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.arc(cx, cy, rsp, 0, TAU); ctx.fill();
    var g = ctx.createRadialGradient(cx, cy, rsp, cx, cy, rsp * 1.7);
    g.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, rsp * 1.7, 0, TAU); ctx.fill();
  }

  function drawPhotonRing() {
    ctx.globalCompositeOperation = 'lighter';
    var rings = [
      [1.03, 0.13, 'rgba(255, 240, 214, 0.07)'],
      [1.03, 0.045, 'rgba(255, 236, 196, 0.30)'],
      [1.03, 0.009, 'rgba(255, 249, 233, 0.95)'],
      [1.16, 0.03, 'rgba(255, 230, 190, 0.12)']
    ];
    for (var i = 0; i < rings.length; i++) {
      ctx.strokeStyle = rings[i][2];
      ctx.lineWidth = rings[i][1] * rsp;
      ctx.beginPath(); ctx.arc(cx, cy, rings[i][0] * rsp, 0, TAU); ctx.stroke();
    }
    // doppler-bright left limb of the ring
    ctx.strokeStyle = 'rgba(255, 252, 242, 0.45)';
    ctx.lineWidth = 0.02 * rsp;
    ctx.beginPath(); ctx.arc(cx, cy, 1.03 * rsp, Math.PI * 0.6, Math.PI * 1.4); ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------- accretion disk filaments ---------- */

  function filamentPoints(f, t, dt) {
    f.age += dt;
    if (f.age > f.life) { f.age = 0; f.phi = rand(0, TAU); }
    f.phi += (OMEGA_K / Math.pow(f.r0, 1.5)) * dt;
    var u2 = f.age / f.life;
    var L = f.L0 * (1 + 2.4 * u2);
    var env = Math.pow(Math.sin(Math.PI * Math.min(u2, 1)), 0.7);
    var flick = 0.72 + 0.28 * Math.sin(t * 0.001 * f.flickSpd + f.flick);
    var pts = [], segs = [];
    for (var j = 0; j < f.pts.length; j++) {
      var p = f.pts[j];
      var r = (f.r0 + f.dr * p.rj) * rsp;
      var a = f.phi + p.u * L + p.ja;
      var x = cx + Math.cos(a) * r;
      var y = cy + Math.sin(a) * r * TILT + p.z * 0.035 * (f.r0 - 1.1) * rsp;
      pts.push({ x: x, y: y, near: Math.sin(a) >= 0, rb: radiusBand(f.r0), db: dopplerBand(a), a: a });
    }
    // split into contiguous near/far runs, then into doppler sub-segments
    var run = null;
    for (j = 0; j < pts.length; j++) {
      if (!run || run.near !== pts[j].near) {
        run = { near: pts[j].near, pts: [] };
        segs.push(run);
      }
      run.pts.push(pts[j]);
    }
    var envL = 0.16 + 0.84 * env;
    var out = [];
    for (j = 0; j < segs.length; j++) {
      var sgm = segs[j];
      var sub = Math.max(1, Math.round(sgm.pts.length / 7));
      for (var q = 0; q < sgm.pts.length; q += sub) {
        var chunk = sgm.pts.slice(q, q + sub + 1);
        if (chunk.length < 2) {
          if (q > 0) chunk = sgm.pts.slice(q - 1, q + 1);
          else if (sgm.pts.length > 1) chunk = sgm.pts.slice(0, 2);
          else continue;
        }
        var mid = chunk[(chunk.length / 2) | 0];
        out.push({
          pts: chunk, near: sgm.near,
          style: LUT[mid.rb][mid.db],
          alpha: envL * flick * (0.7 + 0.3 * (1 - (f.r0 - R_IN) / (R_OUT - R_IN))),
          w: f.w
        });
      }
    }
    return out;
  }

  function strokeSegments(segs) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      var pts = s.pts;
      ctx.globalAlpha = s.alpha;
      ctx.strokeStyle = s.style;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (var j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  function drawDisk(dt, t, wantNear) {
    for (var i = 0; i < disk.length; i++) {
      var segs = filamentPoints(disk[i], t, dt);
      var pass = [];
      for (var j = 0; j < segs.length; j++) {
        if (segs[j].near === wantNear) pass.push(segs[j]);
      }
      if (pass.length) strokeSegments(pass);
    }
  }

  /* ---------- lensed far-side arcs ---------- */

  function drawArcChains(chains, t, dt) {
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (var i = 0; i < chains.length; i++) {
      var c = chains[i];
      c.phi += c.spd * dt;
      c.off = (c.off + 0.008 * dt + 1) % 1;
      var flick = 0.7 + 0.3 * Math.sin(t * 0.001 * c.flickSpd + c.flick);
      // top arc lives in [185deg, 355deg] (through 270deg = screen-up),
      // under arc in [5deg, 175deg] (through 90deg = screen-down)
      var full = (170 * Math.PI) / 180;
      var span = full * c.len;
      var lo = c.isTop ? (185 * Math.PI) / 180 : (5 * Math.PI) / 180;
      var baseA = lo + c.off * (full - span);
      var dir = 1;
      var rx = c.r * rsp, ry = c.r * c.tilt * rsp;
      var pts = [];
      for (var j = 0; j < c.pts.length; j++) {
        var p = c.pts[j];
        var a = baseA + dir * p.u * span * c.len;
        pts.push({
          x: cx + Math.cos(a) * rx,
          y: cy + Math.sin(a) * ry + p.z * rsp,
          t: c.off + p.u
        });
      }
      // brightness peaks at the left limb (continuation of the doppler side)
      var bright = 0.3 + 0.7 * Math.pow(1 - clamp(c.off, 0, 1), 1.2);
      var env = 0.5 + 0.5 * Math.sin(clamp(c.off, 0, 1) * Math.PI);
      var alpha = (c.isTop ? 0.6 : 0.3) * bright * (0.55 + 0.45 * env) * flick;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = LUT[2][11];
      ctx.lineWidth = c.isTop ? 1.1 : 0.9;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (j = 1; j < pts.length; j++) ctx.lineTo(pts[j].x, pts[j].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---------- infalling folders (the meme) ---------- */

  function drawFolder(f, t, dt) {
    if (dt > 0) {
      f.a += (OMEGA_K / Math.pow(f.r, 1.5)) * dt * 0.8;
      f.r -= f.drift * dt;
      if (f.r < 1.12) { f.r = rand(3.1, 3.6); f.a = rand(0, TAU); }
    }
    var x = cx + Math.cos(f.a) * f.r * rsp;
    var y = cy + Math.sin(f.a) * f.r * rsp * TILT;
    var s = 0.5 + 0.5 * Math.min(1, f.r / 3);
    var alpha = clamp((f.r - 1.12) / 0.5, 0, 1);
    if (alpha <= 0.02) return;
    // spaghettification: tidal stretch along the orbit near the horizon
    var sagg = clamp((1.7 - f.r) / 0.6, 0, 1);
    var sx = s * (1 + 1.7 * sagg), sy = s * (1 - 0.55 * sagg);
    var rot = Math.atan2(Math.cos(f.a) * rsp * TILT, -Math.sin(f.a) * rsp) + Math.sin(t * 0.0006 + f.ph) * 0.1;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.scale(sx, sy);
    ctx.globalAlpha = alpha;

    var fw = 13, fh = 9.5;
    ctx.fillStyle = '#18181b';
    ctx.strokeStyle = 'rgba(252, 211, 77, 0.95)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-fw / 2, fh / 2);
    ctx.lineTo(-fw / 2, -fh / 2 + 2.5);
    ctx.lineTo(-fw / 2 + 4, -fh / 2 + 2.5);
    ctx.lineTo(-fw / 2 + 5.5, -fh / 2);
    ctx.lineTo(fw / 2, -fh / 2);
    ctx.lineTo(fw / 2, fh / 2);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    ctx.fillStyle = 'rgba(252, 211, 77, ' + 0.85 * alpha + ')';
    ctx.font = '8px "SF Mono", ui-monospace, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.fillText(f.label, 0, fh / 2 + 9);

    ctx.restore();
    ctx.globalAlpha = 1;
  }

  /* ---------- frame ---------- */

  function draw(t) {
    var dt = reduced ? 0 : Math.min((t - lastT) / 1000, 0.1);
    lastT = t;

    drawStars(t);
    drawHalo();
    drawDisk(dt, t, false);      // far half (behind the shadow)
    drawShadow();
    drawPhotonRing();
    drawArcChains(topArc, t, dt);    // far side bent over the top
    drawArcChains(underArc, t, dt);  // secondary image under the shadow
    drawDisk(dt, t, true);       // near half (in front)
    for (var i = 0; i < folders.length; i++) drawFolder(folders[i], t, dt);

    // adaptive quality: shed particles if the frame budget slips
    if (!reduced && dt > 0) {
      emaDt = emaDt * 0.95 + dt * 1000 * 0.05;
      if (++frame % 120 === 0 && emaDt > 27 && tier < 2) {
        tier++;
        buildScene();
      }
    }
  }

  function loop(t) {
    if (!running) return;
    draw(t);
    rafId = requestAnimationFrame(loop);
  }

  function setRunning(on) {
    var should = on && visible && !reduced;
    if (should && !running) {
      running = true;
      lastT = performance.now();
      rafId = requestAnimationFrame(loop);
    } else if (!should && running) {
      running = false;
      cancelAnimationFrame(rafId);
    }
  }

  document.addEventListener('visibilitychange', function () {
    visible = !document.hidden;
    setRunning(true);
  });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      setRunning(entries[0].isIntersecting);
    }, { threshold: 0.05 }).observe(canvas);
  }

  if ('ResizeObserver' in window) {
    new ResizeObserver(function () { resize(); }).observe(canvas.parentElement);
  } else {
    window.addEventListener('resize', resize);
  }

  window.addEventListener('load', resize);
  resize();
  setRunning(true);

  // capture/debug hook: freeze on a deterministic frame
  window.__dechonkHole = {
    tier: function () { return tier; },
    freeze: function (seconds) {
      running = false;
      cancelAnimationFrame(rafId);
      draw((seconds || 46) * 1000);
    }
  };
})();
