/* =====================================================================
 * actions.js — Pose feature extraction + rule-based action recognition
 *
 * Input : MoveNet keypoints (COCO 17 point skeleton), normalised in
 *         video pixel space, each with a confidence score.
 * Output: a labelled action, a confidence score and typed events.
 *
 * Everything runs locally in the browser. No frames leave the device.
 * ===================================================================== */
(function (global) {
  'use strict';

  /* ---- COCO keypoint indices (MoveNet order) ------------------------- */
  var KP = {
    NOSE: 0, LEYE: 1, REYE: 2, LEAR: 3, REAR: 4,
    LSHO: 5, RSHO: 6, LELB: 7, RELB: 8, LWR: 9, RWR: 10,
    LHIP: 11, RHIP: 12, LKNE: 13, RKNE: 14, LANK: 15, RANK: 16
  };

  /* ---- Skeleton links used for drawing ------------------------------ */
  var SKELETON = [
    [5, 7], [7, 9], [6, 8], [8, 10],            // arms
    [5, 6], [5, 11], [6, 12], [11, 12],          // torso
    [11, 13], [13, 15], [12, 14], [14, 16],      // legs
    [0, 1], [0, 2], [1, 3], [2, 4], [0, 5], [0, 6]
  ];

  /* ---- Display metadata for every known action ---------------------- */
  var META = {
    'no-person':     { label: 'No person',                icon: '⬜', tone: 'muted'  },
    'idle':          { label: 'Idle',                     icon: '😶', tone: 'muted'  },
    'standing':      { label: 'Standing',                 icon: '🧍', tone: 'blue'   },
    'walking':       { label: 'Walking',                  icon: '🚶', tone: 'green'  },
    'sitting':       { label: 'Sitting',                  icon: '🪑', tone: 'amber'  },
    'waving':        { label: 'Waving',                   icon: '👋', tone: 'cyan'   },
    'hand-raised':   { label: 'Hand raised',              icon: '✋', tone: 'cyan'   },
    'pointing-left': { label: 'Pointing (left arm)',      icon: '☝️', tone: 'violet' },
    'pointing-right':{ label: 'Pointing (right arm)',     icon: '👉', tone: 'violet' },
    'clapping':      { label: 'Clapping',                 icon: '👏', tone: 'pink'   },
    'jumping':       { label: 'Jumping',                  icon: '🤸', tone: 'orange' },
    'arms-crossed':  { label: 'Arms crossed',             icon: '🙅', tone: 'pink'   },
    'bowing':        { label: 'Bowing / leaning forward', icon: '🙇', tone: 'amber'   },
    'leaning':       { label: 'Leaning sideways',         icon: '🧘', tone: 'amber'   },
    'moving-closer': { label: 'Coming closer',            icon: '🔽', tone: 'green'   },
    'moving-away':   { label: 'Moving away',              icon: '🔼', tone: 'muted'   },
    /* fallback (frame-diff) mode only */
    'movement':      { label: 'Movement detected',        icon: '🏃', tone: 'orange' },
    'still':         { label: 'Still',                    icon: '🧍', tone: 'blue'   }
  };

  /* Minimum time an action must be stable before it is committed.
     Short gestures get a fast trigger, postures a slower one. */
  var HOLD = {
    'no-person': 700, 'idle': 1400, 'standing': 1600, 'walking': 900,
    'sitting': 1400, 'waving': 500, 'hand-raised': 800,
    'pointing-left': 700, 'pointing-right': 700, 'clapping': 450,
    'jumping': 400, 'arms-crossed': 1200, 'bowing': 1200,
    'leaning': 1400, 'moving-closer': 1600, 'moving-away': 1600,
    'movement': 700, 'still': 1400
  };

  var SCORE_FLOOR = 0.45;

  /* ---------------- small maths helpers ------------------------------ */
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function ok(p) { return !!p && typeof p.score === 'number' && p.score >= 0.3; }
  function mean(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : NaN; }

  function angleAt(a, b, c) {
    var v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
    var m1 = Math.hypot(v1x, v1y), m2 = Math.hypot(v2x, v2y);
    if (!m1 || !m2) return NaN;
    var cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
    return Math.acos(clamp(cos, -1, 1)) * 57.2957795;
  }

  function torsoOf(kp) {
    if (!kp || kp.length < 13) return 0;
    var a = kp[KP.LSHO], b = kp[KP.RSHO], c = kp[KP.LHIP], d = kp[KP.RHIP];
    if (!ok(a) || !ok(b) || !ok(c) || !ok(d)) return 0;
    return dist(mid(a, b), mid(c, d));
  }

  /* Count direction reversals of one joint over a recent time window.
     amp is returned normalised by torso length. */
  function oscillation(hist, idx, windowMs, now, torso) {
    var xs = [];
    for (var i = hist.length - 1; i >= 0; i--) {
      if (now - hist[i].t > windowMs) break;
      var k = hist[i].kp[idx];
      if (k && k.score >= 0.3) xs.unshift(k.x);
    }
    if (xs.length < 6) return { cycles: 0, amp: 0, n: xs.length };

    var amp = Math.max.apply(null, xs) - Math.min.apply(null, xs);

    var sm = [];
    for (var j = 0; j < xs.length; j++) {
      var lo = Math.max(0, j - 2), hi = Math.min(xs.length - 1, j + 2), s = 0;
      for (var m = lo; m <= hi; m++) s += xs[m];
      sm.push(s / (hi - lo + 1));
    }

    var cycles = 0, dir = 0;
    for (var n = 3; n < sm.length; n++) {
      var d = sm[n] - sm[n - 3];
      var nd = d > 0 ? 1 : (d < 0 ? -1 : 0);
      if (nd !== 0) { if (dir !== 0 && nd !== dir) cycles++; dir = nd; }
    }
    return { cycles: cycles, amp: torso ? amp / torso : amp, n: xs.length };
  }

  function seriesDist(hist, ia, ib, windowMs, now) {
    var out = [];
    for (var i = hist.length - 1; i >= 0; i--) {
      if (now - hist[i].t > windowMs) break;
      var kp = hist[i].kp, a = kp[ia], b = kp[ib];
      if (a && b && a.score >= 0.3 && b.score >= 0.3) out.unshift(dist(a, b));
    }
    return out;
  }

  function laggedTorso(hist, lagMs, now) {
    for (var i = hist.length - 1; i >= 0; i--) {
      if (now - hist[i].t >= lagMs) return torsoOf(hist[i].kp);
    }
    return 0;
  }

  /* How far a joint has travelled from its most recent position, over a
     recent window. A single fixed lag reads near zero twice per gait
     cycle, so we take the furthest excursion instead. */
  function maxDisplacement(hist, idxs, windowMs, now, torso) {
    var total = 0, used = 0;
    for (var a = 0; a < idxs.length; a++) {
      var idx = idxs[a], newest = null, best = 0, samples = 0;
      for (var i = hist.length - 1; i >= 0; i--) {
        if (now - hist[i].t > windowMs) break;
        var k = hist[i].kp[idx];
        if (!k || k.score < 0.3) continue;
        if (!newest) { newest = k; continue; }
        var d = dist(k, newest);
        if (d > best) best = d;
        samples++;
      }
      if (samples >= 2) { total += best / torso; used++; }
    }
    return used ? total / used : 0;
  }

  /* =================================================================== *
   *  Analyzer                                                            *
   * =================================================================== */
  function Analyzer(opts) {
    opts = opts || {};
    this.window = opts.window || 6000;      // ms of history kept
    this.history = [];
    this.smoothed = null;
    this.action = 'no-person';
    this.since = 0;
    this.pending = null;
    this.pendingSince = 0;
    this.listeners = [];
    this.missed = 0;
    this.prev = null;

    this.torsoVBase = 0;     // vertical shoulder→hip span while upright
    this.legSpanBase = 0;    // hip→ankle span while legs are extended
    this.hipBase = null;     // grounded hip height
    this.airborne = false;
    this.legMotion = null;   // smoothed leg-travel signal
    this.warmupUntil = 0;
    this.lastResult = { action: 'no-person', kp: null, scores: {}, person: false, motion: 0, conf: 0 };
  }

  Analyzer.prototype.on = function (fn) { this.listeners.push(fn); return this; };
  Analyzer.prototype.emit = function (e) {
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](e); } catch (err) { console.warn(err); }
    }
  };

  Analyzer.prototype.startClock = function (now) { this.warmupUntil = now + 2500; };

  Analyzer.prototype.reset = function () {
    this.history = [];
    this.smoothed = null;
    this.action = 'no-person';
    this.since = 0;
    this.pending = null;
    this.pendingSince = 0;
    this.missed = 0;
    this.prev = null;
    this.torsoVBase = 0;
    this.legSpanBase = 0;
    this.hipBase = null;
    this.airborne = false;
    this.legMotion = null;
    this.warmupUntil = 0;
    this.lastResult = { action: 'no-person', kp: null, scores: {}, person: false, motion: 0, conf: 0 };
    return this;
  };

  Analyzer.prototype._trim = function (now) {
    var h = this.history;
    while (h.length > 2 && now - h[0].t > this.window) h.shift();
  };

  Analyzer.prototype._switch = function (to, now) {
    var from = this.action;
    if (from === to) return;
    var dur = now - this.since;
    this.action = to;
    this.since = now;
    this.pending = null;
    this.emit({ type: 'change', from: from, to: to, duration: dur, t: now });
  };

  Analyzer.prototype.actionMeta = function (id) {
    return META[id] || { label: id, icon: '❓', tone: 'muted' };
  };

  /* Main per-frame entry point. `pose` may be null when nobody is found. */
  Analyzer.prototype.update = function (pose, now) {
    var i, j;

    if (this.warmupUntil === 0) this.startClock(now);

    var raw = null;
    if (pose && pose.keypoints && pose.keypoints.length) {
      raw = [];
      for (i = 0; i < pose.keypoints.length; i++) {
        var p = pose.keypoints[i];
        raw.push({ x: p.x, y: p.y, score: typeof p.score === 'number' ? p.score : 1 });
      }
    }

    var strong = 0;
    if (raw) for (i = 0; i < raw.length; i++) if (ok(raw[i])) strong++;

    /* ---- nobody visible ------------------------------------------- */
    if (!raw || strong < 6) {
      this.missed++;
      this.history.push({ t: now, kp: this.smoothed || [] });
      this._trim(now);
      if (this.missed > 14 && this.action !== 'no-person') this._switch('no-person', now);
      if (this.missed > 4) { this.prev = null; this.legMotion = null; }
      this.lastResult = {
        action: this.action, pending: this.pending, kp: this.smoothed,
        scores: {}, person: false, motion: 0, conf: 0
      };
      return this.lastResult;
    }
    this.missed = 0;

    /* ---- exponential smoothing ------------------------------------ */
    if (!this.smoothed || this.smoothed.length !== raw.length) {
      this.smoothed = raw;
    } else {
      var out = new Array(raw.length);
      for (i = 0; i < raw.length; i++) {
        var cur = raw[i], old = this.smoothed[i] || cur;
        if (cur.score < 0.25) out[i] = { x: old.x, y: old.y, score: cur.score };
        else if (!old || old.score < 0.25) out[i] = cur;
        else out[i] = {
          x: old.x + (cur.x - old.x) * 0.4,
          y: old.y + (cur.y - old.y) * 0.4,
          score: cur.score
        };
      }
      this.smoothed = out;
    }

    var K = this.smoothed;
    this.history.push({ t: now, kp: K });
    this._trim(now);

    /* ---- core geometry -------------------------------------------- */
    var P = {
      lsho: K[KP.LSHO], rsho: K[KP.RSHO], lelb: K[KP.LELB], relb: K[KP.RELB],
      lwr: K[KP.LWR], rwr: K[KP.RWR], lhip: K[KP.LHIP], rhip: K[KP.RHIP],
      lkne: K[KP.LKNE], rkne: K[KP.RKNE], lank: K[KP.LANK], rank: K[KP.RANK]
    };

    var torso = torsoOf(K);
    if (!(torso > 4)) {
      this.lastResult = { action: this.action, pending: this.pending, kp: K, scores: {}, person: true, motion: 0, conf: 0.3 };
      return this.lastResult;
    }

    var midSho = mid(P.lsho, P.rsho);
    var midHip = mid(P.lhip, P.rhip);
    var torsoV = Math.abs(midSho.y - midHip.y);

    /* upright reference — decays slowly so a sustained bend can recover */
    this.torsoVBase = torsoV > this.torsoVBase ? torsoV : this.torsoVBase * 0.999;

    /* leg extension reference — only grows */
    var spans = [];
    if (ok(P.lhip) && ok(P.lank)) spans.push(P.lank.y - P.lhip.y);
    if (ok(P.rhip) && ok(P.rank)) spans.push(P.rank.y - P.rhip.y);
    var legSpan = spans.length ? mean(spans) : null;
    if (legSpan != null && legSpan > 0) {
      this.legSpanBase = this.legSpanBase ? Math.max(this.legSpanBase * 0.999, legSpan) : legSpan;
    }

    /* joint angles */
    var knees = [];
    if (ok(P.lhip) && ok(P.lkne) && ok(P.lank)) knees.push(angleAt(P.lhip, P.lkne, P.lank));
    if (ok(P.rhip) && ok(P.rkne) && ok(P.rank)) knees.push(angleAt(P.rhip, P.rkne, P.rank));
    var kv = knees.filter(function (v) { return typeof v === 'number' && !isNaN(v); });
    var knee = kv.length ? Math.min.apply(null, kv) : null;

    /* motion, normalised by torso length */
    var motion = 0;
    if (this.prev && this.prev.length === K.length) {
      var acc = 0, n = 0;
      for (i = 0; i < K.length; i++) {
        if (ok(K[i]) && ok(this.prev[i])) { acc += dist(K[i], this.prev[i]); n++; }
      }
      if (n) motion = clamp((acc / n) / torso, 0, 1);
    }
    this.prev = K;

    var legMotion = maxDisplacement(this.history, [KP.LANK, KP.RANK], 700, now, torso);
    /* The raw excursion dips once per gait cycle; a one-frame trough must
       not be read as "stopped", so smooth it before classifying. */
    this.legMotion = this.legMotion == null ? legMotion : this.legMotion * 0.5 + legMotion * 0.5;
    legMotion = this.legMotion;

    var oscL = oscillation(this.history, KP.LWR, 700, now, torso);
    var oscR = oscillation(this.history, KP.RWR, 700, now, torso);
    var clap = seriesDist(this.history, KP.LWR, KP.RWR, 900, now);

    var warm = now >= this.warmupUntil;
    var S = {};

    /* ---- clapping: wrists repeatedly meet then separate ------------ */
    if (clap.length >= 8) {
      var lo = 0, hi = 0;
      for (i = 0; i < clap.length; i++) {
        if (clap[i] < 0.22 * torso) lo++;
        else if (clap[i] > 0.60 * torso) hi++;
      }
      if (lo >= 2 && hi >= 2) S.clapping = clamp(Math.min(lo, hi) / 3, 0, 1) * 0.9 + 0.1;
    }

    /* ---- jumping: hips rise sharply then fall back ------------------ */
    var hipY = midHip.y;
    if (this.hipBase == null) this.hipBase = hipY;
    if (!this.airborne) {
      if (hipY < this.hipBase - 0.30 * torso) this.airborne = true;
    } else if (hipY > this.hipBase - 0.12 * torso) {
      this.airborne = false;
    }
    if (this.airborne) S.jumping = 1;
    else this.hipBase = this.hipBase * 0.94 + hipY * 0.06;

    /* ---- waving / hand raised -------------------------------------- */
    var wristUp = function (sho, wr) { return ok(sho) && ok(wr) && wr.y < sho.y - 0.03 * torso; };
    if (wristUp(P.lsho, P.lwr) && oscL.cycles >= 2 && oscL.amp > 0.13) S.waving = 0.95;
    if (wristUp(P.rsho, P.rwr) && oscR.cycles >= 2 && oscR.amp > 0.13) S.waving = Math.max(S.waving || 0, 0.95);

    if (!S.waving) {
      if (ok(P.lsho) && ok(P.lwr) && P.lwr.y < P.lsho.y - 0.14 * torso && oscL.cycles < 2) S['hand-raised'] = 0.8;
      if (ok(P.rsho) && ok(P.rwr) && P.rwr.y < P.rsho.y - 0.14 * torso && oscR.cycles < 2) S['hand-raised'] = Math.max(S['hand-raised'] || 0, 0.8);
    }

    /* ---- pointing: straight arm held roughly horizontal ------------ */
    function pointScore(sho, elb, wr) {
      if (!ok(sho) || !ok(elb) || !ok(wr)) return 0;
      var a = angleAt(sho, elb, wr);
      if (isNaN(a) || a < 155) return 0;
      if (Math.abs(wr.y - sho.y) > 0.5 * torso) return 0;
      if (dist(sho, wr) < 0.75 * torso) return 0;
      return 0.85;
    }
    if (!S.waving && !S['hand-raised']) {
      var pl = pointScore(P.lsho, P.lelb, P.lwr);
      var pr = pointScore(P.rsho, P.relb, P.rwr);
      if (pl > 0) S['pointing-left'] = pl;
      if (pr > 0) S['pointing-right'] = pr;
    }

    /* ---- arms crossed ---------------------------------------------- */
    if (ok(P.lwr) && ok(P.rwr) && ok(P.lelb) && ok(P.relb)) {
      var eL = angleAt(P.lsho, P.lelb, P.lwr);
      var eR = angleAt(P.rsho, P.relb, P.rwr);
      var dw = dist(P.lwr, P.rwr);
      var inTorso = P.lwr.y > midSho.y + 0.10 * torso && P.rwr.y > midSho.y + 0.10 * torso &&
                    P.lwr.y < midHip.y - 0.05 * torso && P.rwr.y < midHip.y - 0.05 * torso;
      if (!isNaN(eL) && !isNaN(eR) && inTorso && dw < 0.55 * torso && eL < 115 && eR < 115) {
        S['arms-crossed'] = 0.8;
      }
    }

    /* ---- bowing / leaning ----------------------------------------- */
    if (warm && this.torsoVBase > 0 && torsoV < 0.72 * this.torsoVBase) S.bowing = 0.82;

    var tilt = Math.atan2(Math.abs(midSho.x - midHip.x), Math.max(1, Math.abs(midSho.y - midHip.y))) * 57.2957795;
    if (tilt > 30) S.leaning = 0.72;

    /* ---- walking ---------------------------------------------------- */
    if (legMotion > 0.10) {
      /* always clear the score floor once the legs are moving, otherwise a
         narrow band produces "idle" and resets the stability timer */
      S.walking = (knee == null || knee > 125)
        ? 0.47 + 0.53 * clamp((legMotion - 0.10) / 0.30, 0, 1)
        : 0.55;
    }

    /* ---- sitting ---------------------------------------------------- */
    if (warm && knee != null && legSpan != null && this.legSpanBase > 0 &&
        knee < 135 && legSpan < 0.88 * this.legSpanBase) {
      S.sitting = 0.85;
    }
    if (knee != null && knee < 100) S.sitting = Math.max(S.sitting || 0, 0.75);

    /* ---- standing --------------------------------------------------- */
    if (knee != null && knee > 150 && legMotion < 0.10 && !S.sitting) S.standing = 0.7;

    /* ---- moving towards / away from the lens ------------------------ */
    if (warm) {
      var t4 = laggedTorso(this.history, 4000, now);
      if (t4 > 0) {
        var ratio = torso / t4;
        if (ratio > 1.4) S['moving-closer'] = 0.65;
        else if (ratio < 0.7) S['moving-away'] = 0.65;
      }
    }

    /* ---- pick the winner ------------------------------------------- */
    var best = 'idle', bs = 0;
    for (var key in S) {
      if (Object.prototype.hasOwnProperty.call(S, key) && S[key] > bs) { bs = S[key]; best = key; }
    }
    if (bs < SCORE_FLOOR) { best = 'idle'; bs = Math.max(bs, 0.2); }

    /* ---- hysteresis so labels do not flicker ------------------------ */
    if (best === this.action) {
      this.pending = null;
    } else {
      if (this.pending !== best) { this.pending = best; this.pendingSince = now; }
      if (now - this.pendingSince >= (HOLD[best] || 1100)) this._switch(best, now);
    }

    var confAcc = 0, confN = 0;
    for (i = 0; i < K.length; i++) if (ok(K[i])) { confAcc += K[i].score; confN++; }

    this.lastResult = {
      action: this.action,
      pending: this.pending,
      kp: K,
      scores: S,
      best: best,
      bestScore: bs,
      person: true,
      motion: motion,
      legMotion: legMotion,
      conf: confN ? confAcc / confN : 0,
      torso: torso
    };
    return this.lastResult;
  };

  /* =================================================================== *
   *  Skeleton rendering (mirrors the front-camera preview)              *
   * =================================================================== */
  function drawSkeleton(ctx, kp, W, H, opts) {
    opts = opts || {};
    if (!kp || !W || !H) return null;
    var mirror = opts.mirror !== false;
    var mx = mirror ? function (x) { return W - x; } : function (x) { return x; };

    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, n = 0;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (var i = 0; i < SKELETON.length; i++) {
      var a = kp[SKELETON[i][0]], b = kp[SKELETON[i][1]];
      if (!a || !b || a.score < 0.25 || b.score < 0.25) continue;
      var s = Math.min(a.score, b.score);
      ctx.strokeStyle = 'rgba(34,211,238,' + (0.25 + s * 0.75) + ')';
      ctx.lineWidth = Math.max(2, W / 340);
      ctx.beginPath();
      ctx.moveTo(mx(a.x), a.y);
      ctx.lineTo(mx(b.x), b.y);
      ctx.stroke();
    }

    for (var j = 0; j < kp.length; j++) {
      var p = kp[j];
      if (!p || p.score < 0.25) continue;
      ctx.fillStyle = p.score > 0.5 ? '#e2f6fb' : 'rgba(226,246,251,0.45)';
      ctx.beginPath();
      ctx.arc(mx(p.x), p.y, Math.max(2, W / 300), 0, Math.PI * 2);
      ctx.fill();

      var X = mx(p.x);
      if (X < minX) minX = X; if (X > maxX) maxX = X;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      n++;
    }

    if (n < 4) return null;
    return { x0: minX, y0: minY, x1: maxX, y1: maxY };
  }

  function drawTag(ctx, x, y, text, opts) {
    opts = opts || {};
    var pad = Math.max(6, (opts.size || 14) * 0.5);
    ctx.font = '600 ' + (opts.size || 14) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    var w = ctx.measureText(text).width + pad * 2;
    var h = (opts.size || 14) + pad * 1.6;
    var bx = Math.max(4, Math.min(x, ctx.canvas.width - w - 4));
    var by = Math.max(4, y - h - 6);

    ctx.fillStyle = 'rgba(8,14,26,0.78)';
    roundRect(ctx, bx, by, w, h, h / 2);
    ctx.fill();
    ctx.strokeStyle = opts.border || 'rgba(34,211,238,0.85)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = opts.color || '#e6faff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + pad, by + h / 2 + 0.5);
    return { w: w, h: h, x: bx, y: by };
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  var TONE_COLOR = {
    blue: '#4f8cff', green: '#2ecc71', amber: '#f5a623', cyan: '#22d3ee',
    violet: '#a78bfa', pink: '#f472b6', orange: '#fb923c', muted: '#8fa1b8'
  };

  global.PoseActions = {
    KP: KP,
    SKELETON: SKELETON,
    META: META,
    HOLD: HOLD,
    Analyzer: Analyzer,
    drawSkeleton: drawSkeleton,
    drawTag: drawTag,
    roundRect: roundRect,
    toneColor: function (tone) { return TONE_COLOR[tone] || TONE_COLOR.muted; }
  };
})(window);
