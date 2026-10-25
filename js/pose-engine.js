/* =====================================================================
 * pose-engine.js
 *   1. MoveNet (TensorFlow.js) pose detector wrapper
 *   2. MotionFallback — frame-difference detector used when the model
 *      cannot be downloaded (offline, blocked CDN, old device)
 * ===================================================================== */
(function (global) {
  'use strict';

  var PoseEngine = {
    detector: null,
    ready: false,
    failed: null,

    init: function (onStep) {
      var self = this;
      onStep = onStep || function () {};

      if (!global.tf || !global.poseDetection) {
        self.failed = 'TensorFlow.js failed to load (no network or blocked CDN).';
        return Promise.reject(new Error(self.failed));
      }

      onStep('Starting WebGL backend…');

      var boot = function () {
        onStep('Downloading MoveNet pose model…');
        var detectorOpts = {
          modelType: global.poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING,
          enableTracking: false
        };
        return global.poseDetection.createDetector(
          global.poseDetection.SupportedModels.MoveNet,
          detectorOpts
        );
      };

      return global.tf.setBackend('webgl')
        .catch(function () { return global.tf.setBackend('cpu'); })
        .then(function () { return global.tf.ready(); })
        .then(function () { onStep('Backend ready: ' + global.tf.getBackend()); return boot(); })
        .then(function (d) {
          self.detector = d;
          self.ready = true;
          self.failed = null;
          onStep('Pose model ready');
          return d;
        })
        .catch(function (err) {
          self.failed = (err && err.message) ? err.message : String(err);
          self.ready = false;
          onStep('Pose model unavailable — using motion fallback');
          throw err;
        });
    },

    /* Returns a MoveNet pose or null. Throttled by the caller. */
    estimate: function (video) {
      if (!this.ready || !this.detector) return Promise.resolve(null);
      if (video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
      return this.detector.estimatePoses(video, { flipHorizontal: false })
        .then(function (poses) {
          if (!poses || !poses.length) return null;
          var best = null;
          for (var i = 0; i < poses.length; i++) {
            if (!best || (poses[i].score || 0) > (best.score || 0)) best = poses[i];
          }
          if (best && typeof best.score === 'number' && best.score < 0.2) return null;
          return best;
        })
        .catch(function () { return null; });
    },

    dispose: function () {
      if (this.detector && this.detector.dispose) { try { this.detector.dispose(); } catch (e) {} }
      this.detector = null;
      this.ready = false;
    }
  };

  /* ------------------------------------------------------------------ *
   *  MotionFallback — cheap "is anything moving" detector
   *  Draws the frame into a 64x48 buffer and compares pixel deltas.
   * ------------------------------------------------------------------ */
  function MotionFallback(w, h) {
    this.w = w || 64;
    this.h = h || 48;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.prev = null;
    this.diff = 0;
    this.peak = 0;
    this.frame = 0;
  }

  MotionFallback.prototype.sample = function (video) {
    if (!video || video.readyState < 2 || !video.videoWidth) return this.diff;
    this.ctx.drawImage(video, 0, 0, this.w, this.h);
    var cur = this.ctx.getImageData(0, 0, this.w, this.h).data;

    if (this.prev) {
      var hits = 0, total = this.w * this.h;
      for (var i = 0; i < cur.length; i += 4) {
        var d = Math.abs(cur[i] - this.prev[i]) +
                Math.abs(cur[i + 1] - this.prev[i + 1]) +
                Math.abs(cur[i + 2] - this.prev[i + 2]);
        if (d > 72) hits++;
      }
      this.diff = hits / total;
      this.peak = Math.max(this.peak * 0.9, this.diff);
    }
    this.prev = cur;
    this.frame++;
    return this.diff;
  };

  MotionFallback.prototype.reset = function () { this.prev = null; this.diff = 0; this.peak = 0; };

  global.PoseEngine = PoseEngine;
  global.MotionFallback = MotionFallback;
})(window);
