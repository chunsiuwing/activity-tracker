/* Headless tests for the rule-based action classifier.
   Run:  node test/actions.test.js                                     */
'use strict';

global.window = global;
require('../js/actions.js');

var PA = global.PoseActions;
var FRAME = 1000 / 12;

var pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  → ' + extra : '')); }
}

/* ---- synthetic skeleton, 1280x960 frame --------------------------- */
function basePose() {
  return [
    { x: 640, y: 240, score: .95 },  // 0 nose
    { x: 628, y: 230, score: .95 },  // 1 l eye
    { x: 652, y: 230, score: .95 },  // 2 r eye
    { x: 614, y: 240, score: .90 },  // 3 l ear
    { x: 666, y: 240, score: .90 },  // 4 r ear
    { x: 580, y: 300, score: .95 },  // 5 l shoulder
    { x: 700, y: 300, score: .95 },  // 6 r shoulder
    { x: 570, y: 400, score: .92 },  // 7 l elbow
    { x: 710, y: 400, score: .92 },  // 8 r elbow
    { x: 565, y: 500, score: .90 },  // 9 l wrist
    { x: 715, y: 500, score: .90 },  // 10 r wrist
    { x: 600, y: 520, score: .95 },  // 11 l hip
    { x: 680, y: 520, score: .95 },  // 12 r hip
    { x: 598, y: 680, score: .93 },  // 13 l knee
    { x: 682, y: 680, score: .93 },  // 14 r knee
    { x: 596, y: 830, score: .90 },  // 15 l ankle
    { x: 684, y: 830, score: .90 }   // 16 r ankle
  ];
}

function clone(p) { return p.map(function (k) { return { x: k.x, y: k.y, score: k.score }; }); }

/* Run a scripted sequence of pose-mutating steps. */
function run(steps, opts) {
  opts = opts || {};
  var a = new PA.Analyzer();
  var changes = [];
  a.on(function (e) { if (e.type === 'change') changes.push(e); });
  a.startClock(0);

  var t = 0;
  var pose = basePose();

  function apply(name) {
    var fn = steps.steps[name];
    if (fn) fn(pose, t);
  }

  // warm-up in the neutral pose
  var warmFrames = opts.warmFrames == null ? 45 : opts.warmFrames;
  for (var i = 0; i < warmFrames; i++) {
    a.update({ keypoints: pose }, t);
    t += FRAME;
  }

  apply('base');

  var seen = {};
  var seq = opts.seq || [];
  seq.forEach(function (step) {
    var frames = step.frames == null ? 40 : step.frames;
    for (var i = 0; i < frames; i++) {
      apply(step.name);
      var r = a.update({ keypoints: pose }, t);
      t += FRAME;
      seen[step.name + '@' + i] = r.action;
    }
    seen['final:' + step.name] = a.action;
  });

  return { action: a.action, changes: changes, seen: seen, analyzer: a, t: t };
}

/* ------------------------------------------------------------------ *
 * 1. neutral standing
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n1. neutral pose → standing');
  var r = run({ steps: {} }, { seq: [{ name: 'none', frames: 60 }] });
  check('settles on "standing"', r.action === 'standing', 'got ' + r.action);
  var starts = r.changes.filter(function (c) { return c.to === 'standing'; });
  check('emits a change event', starts.length >= 1);
})();

/* ------------------------------------------------------------------ *
 * 2. waving — wrist above shoulder oscillating
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n2. raised + oscillating wrist → waving');
  var r = run({
    steps: {
      wave: function (p, t) {
        p[5] = { x: 580, y: 300, score: .95 };   // l shoulder fixed
        var ph = Math.sin(t / 53);              // ~3 Hz, a real wave speed
        p[7] = { x: 545, y: 235, score: .92 };   // l elbow
        p[9] = { x: 505 + ph * 55, y: 205, score: .92 };
      }
    }
  }, { seq: [{ name: 'wave', frames: 60 }] });
  check('settles on "waving"', r.action === 'waving', 'got ' + r.action);
})();

/* ------------------------------------------------------------------ *
 * 3. static raised hand → hand-raised (not waving)
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n3. static raised hand → hand-raised');
  var r = run({
    steps: {
      raise: function (p) {
        p[5] = { x: 580, y: 300, score: .95 };
        p[7] = { x: 560, y: 230, score: .92 };
        p[9] = { x: 555, y: 165, score: .92 };
      }
    }
  }, { seq: [{ name: 'raise', frames: 60 }] });
  check('settles on "hand-raised"', r.action === 'hand-raised', 'got ' + r.action);
})();

/* ------------------------------------------------------------------ *
 * 4. jumping — whole body lifts then lands
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n4. body lifts and lands → jumping');
  var r = run({
    steps: {
      up: (function () {
        var snap = null;
        return function (p) {
          if (!snap) snap = p.map(function (k) { return { x: k.x, y: k.y }; });
          for (var i = 0; i < p.length; i++) { p[i].x = snap[i].x; p[i].y = snap[i].y - 120; }
        };
      })()
    }
  }, {
    seq: [{ name: 'up', frames: 24 }],
    warmFrames: 60
  });
  var jumped = r.changes.some(function (c) { return c.to === 'jumping'; });
  check('emits a "jumping" change', jumped,
        'changes: ' + r.changes.map(function (c) { return c.to; }).join(','));
})();

/* ------------------------------------------------------------------ *
 * 5. sitting — knees bend, hips drop
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n5. bent knees + lowered hips → sitting');
  var r = run({
    steps: {
      sit: function (p) {
        p[11] = { x: 600, y: 520, score: .95 };  // l hip
        p[12] = { x: 680, y: 520, score: .95 };  // r hip
        p[13] = { x: 642, y: 662, score: .93 };  // l knee  (~119°)
        p[14] = { x: 638, y: 662, score: .93 };  // r knee
        p[15] = { x: 566, y: 742, score: .90 };  // l ankle
        p[16] = { x: 714, y: 742, score: .90 };  // r ankle
      }
    }
  }, { seq: [{ name: 'sit', frames: 70 }], warmFrames: 60 });
  check('settles on "sitting"', r.action === 'sitting', 'got ' + r.action);
})();

/* ------------------------------------------------------------------ *
 * 6. walking — legs swing
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n6. swinging legs → walking');
  var r = run({
    steps: {
      walk: function (p, t) {
        var ph = t / 1000 * 2 * Math.PI * 2.4;   // 2.4 steps per second
        p[15] = { x: 596 + Math.sin(ph) * 62, y: 830, score: .90 };
        p[16] = { x: 684 - Math.sin(ph) * 62, y: 830, score: .90 };
        p[13] = { x: 598 + Math.sin(ph) * 30, y: 680, score: .93 };
        p[14] = { x: 682 - Math.sin(ph) * 30, y: 680, score: .93 };
      }
    }
  }, { seq: [{ name: 'walk', frames: 70 }], warmFrames: 60 });
  check('settles on "walking"', r.action === 'walking', 'got ' + r.action);
})();

/* ------------------------------------------------------------------ *
 * 7. no person → no-person
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n7. pose disappears → no-person');
  var a = new PA.Analyzer();
  var changes = [];
  a.on(function (e) { if (e.type === 'change') changes.push(e); });
  a.startClock(0);
  var t = 0, pose = basePose();
  for (var i = 0; i < 60; i++) { a.update({ keypoints: pose }, t); t += FRAME; }
  var before = a.action;
  for (var j = 0; j < 40; j++) { a.update(null, t); t += FRAME; }
  check('was ' + before + ' before the person left', before !== 'no-person');
  check('ends on "no-person"', a.action === 'no-person', 'got ' + a.action);
  var lost = changes.some(function (c) { return c.to === 'no-person'; });
  check('emits a change to no-person', lost);
})();

/* ------------------------------------------------------------------ *
 * 8. flicker resistance — one bad frame must not change the label
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n8. single noisy frame does not flip the label');
  var a = new PA.Analyzer();
  a.startClock(0);
  var t = 0, pose = basePose();
  for (var i = 0; i < 70; i++) { a.update({ keypoints: pose }, t); t += FRAME; }
  var stable = a.action;

  var glitch = clone(pose);
  glitch[9] = { x: 505, y: 120, score: .99 };    // one frame with a raised wrist
  a.update({ keypoints: glitch }, t); t += FRAME;

  for (var j = 0; j < 6; j++) { a.update({ keypoints: pose }, t); t += FRAME; }
  check('still "' + stable + '" right after the glitch', a.action === stable,
        'got ' + a.action);
})();

/* ------------------------------------------------------------------ *
 * 9. drawing helpers
 * ------------------------------------------------------------------ */
(function () {
  console.log('\n9. rendering helpers');
  var calls = [];
  var ctx = {
    canvas: { width: 1280, height: 960 },
    beginPath: function () { calls.push('begin'); },
    moveTo: function () {}, lineTo: function () {},
    stroke: function () { calls.push('stroke'); },
    fill: function () { calls.push('fill'); },
    arc: function () {}, fillText: function () {},
    closePath: function () {}, strokeRect: function () {},
    roundRect: function () {},
    setLineDash: function () {}, arcTo: function () {},
    measureText: function (s) { return { width: s.length * 8 }; },
    save: function () {}, restore: function () {}
  };
  var box = PA.drawSkeleton(ctx, basePose(), 1280, 960, { mirror: true });
  check('returns a bounding box', !!box && box.x0 < box.x1 && box.y0 < box.y1,
        JSON.stringify(box));
  check('drew lines and points', calls.indexOf('stroke') > -1 && calls.indexOf('fill') > -1);
  check('mirror maps left shoulder to the right half', box.x1 > 1280 - 700);
  check('META covers every HOLD id',
        Object.keys(PA.HOLD).every(function (k) { return !!PA.META[k]; }),
        Object.keys(PA.HOLD).filter(function (k) { return !PA.META[k]; }).join(','));
})();

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
