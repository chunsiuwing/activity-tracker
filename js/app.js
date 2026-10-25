/* =====================================================================
 * app.js — ActionLog
 *
 *   camera  →  MoveNet pose  →  rule-based action labels  →  timeline
 *   microphone → Web Speech API → transcript
 *
 * Everything is processed locally; nothing is uploaded.
 * ===================================================================== */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var el = {};

  var IDS = [
    'clock', 'statusDot', 'secureWarn', 'camWarn', 'permWarn', 'modelBanner',
    'video', 'overlay', 'hudAction', 'hudFps', 'hudModel',
    'cam', 'camCenter', 'btnStartBig', 'btnStartLabel', 'camHint',
    'btnFlip', 'btnShot', 'btnFullscreen', 'recBadge',
    'nowIcon', 'nowLabel', 'nowSub', 'confBar',
    'btnMic', 'selLang', 'btnClear', 'btnExport',
    'qActions', 'qSpeech', 'qWords', 'qMotion',
    'cntEvents', 'cntSpeech', 'timeline', 'interimBox', 'interimText',
    'transcript', 'statsGrid', 'bars', 'statChips', 'autoScroll',
    'modal', 'modalClose', 'toast'
  ];

  /* ── runtime state ─────────────────────────────────────────────── */
  var running = false;
  var micOn = true;
  var facing = 'user';
  var stream = null;
  var cameraOn = false;

  var analyzer = null;
  var fallback = null;
  var usingFallback = false;
  var fbState = 'still';
  var fbSince = 0;
  var fbPending = null;
  var fbPendingSince = 0;

  var rafId = 0;
  var lastPoseMs = 0;
  var poseBusy = false;
  var lastKp = null;
  var lastMotion = 0;
  var poseFrames = 0;
  var poseFps = 0;
  var fpsWindow = 0;

  var session = null;
  var startPerf = 0;
  var eventSeq = 0;
  var domEvents = 0;
  var domUtts = 0;

  var segments = [];
  var openSeg = null;
  var utterances = [];
  var actionCounts = {};
  var filter = 'all';

  var rec = null;
  var recWanted = false;
  var recActive = false;
  var recLang = 'en-US';

  var clockTimer = 0;
  var statsTimer = 0;
  var toastTimer = 0;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;

  /* ================================================================= *
   *  helpers                                                          *
   * ================================================================= */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtClock(ms) {
    if (!(ms > 0)) ms = 0;
    var s = Math.floor(ms / 1000);
    return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function fmtShort(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60);
    if (m < 60) return m + 'm ' + (s % 60) + 's';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function fmtOffset(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  function fmtSrt(ms) {
    if (!(ms > 0)) ms = 0;
    var h = Math.floor(ms / 3600000);
    var m = Math.floor(ms / 60000) % 60;
    var s = Math.floor(ms / 1000) % 60;
    var x = Math.floor(ms % 1000);
    return pad(h) + ':' + pad(m) + ':' + pad(s) + ',' + ('00' + x).slice(-3);
  }

  function now() { return performance.now(); }
  function currentDuration() { return running ? now() - startPerf : (session ? session.duration : 0); }

  function countWords(text) {
    if (!text) return 0;
    var cjk = text.match(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g);
    var latin = text
      .replace(/[㐀-鿿豈-﫿぀-ヿ가-힯]/g, ' ')
      .split(/\s+/)
      .filter(function (w) { return w.length > 0; });
    return (cjk ? cjk.length : 0) + latin.length;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function toast(msg, kind) {
    clearTimeout(toastTimer);
    el.toast.textContent = msg;
    el.toast.className = 'toast' + (kind ? ' ' + kind : '');
    el.toast.hidden = false;
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, kind === 'err' ? 5200 : 2600);
  }

  function setStatus(mode, title) {
    el.statusDot.className = 'dot' + (mode ? ' ' + mode : '');
    el.statusDot.title = title || mode || 'Idle';
  }

  function banner(node, html) {
    if (!html) { node.hidden = true; node.innerHTML = ''; return; }
    node.innerHTML = html;
    node.hidden = false;
  }

  /* ================================================================= *
   *  session lifecycle                                                *
   * ================================================================= */
  function startSession() {
    if (running) return;

    if (!window.isSecureContext) {
      toast('Insecure page: the camera and microphone are blocked. Use https:// or http://localhost.', 'err');
      return;
    }

    /* continue the same log so offsets stay monotonic across restarts */
    startPerf = now() - (session.duration || 0);
    running = true;

    analyzer.reset();
    analyzer.startClock(startPerf);
    if (fallback) fallback.reset();
    fbState = 'still';
    fbSince = startPerf;
    fbPending = null;
    lastKp = null;
    fpsWindow = now();

    banner(el.secureWarn, null);
    setStatus('live', 'Recording');
    el.recBadge.hidden = false;
    el.camCenter.classList.add('gone');
    el.btnStartLabel.textContent = 'Stop session';
    el.btnStartBig.classList.add('stop');
    el.btnStartBig.querySelector('.big-ico').textContent = '■';
    el.camHint.textContent = 'Session running — actions and speech are being logged.';

    el.nowIcon.textContent = '🔍';
    el.nowLabel.textContent = 'Looking…';
    el.nowSub.textContent = 'Point the camera at one person';

    startClock();
    startStats();

    pushEvent({ type: 'system', text: 'Session started', icon: '🎬' });

    ensureCamera()
      .catch(handleCamError)
      .then(function () { if (micOn) startMic(); });

    frameLoop(now());
  }

  function stopSession() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;

    var dur = now() - startPerf;
    session.duration = dur;
    session.endedAt = Date.now();
    session.lang = recLang;

    closeSegment(now());
    stopMic();
    stopCamera();
    clearOverlay();

    pushEvent({ type: 'system', text: 'Session stopped after ' + fmtShort(dur), icon: '🏁' });

    setStatus('ready', 'Stopped');
    el.recBadge.hidden = true;
    el.camCenter.classList.remove('gone');
    el.btnStartLabel.textContent = 'Resume session';
    el.btnStartBig.classList.remove('stop');
    el.btnStartBig.querySelector('.big-ico').textContent = '▶';
    el.camHint.textContent = 'Log kept in memory — press Export to download it.';

    var totalWords = 0;
    utterances.forEach(function (u) { totalWords += countWords(u.text); });
    el.nowIcon.textContent = '✅';
    el.nowLabel.textContent = 'Session paused';
    el.nowSub.textContent = fmtShort(dur) + ' recorded · ' + segments.length +
      ' action blocks · ' + utterances.length + ' speeches · ' + totalWords + ' words';
    el.confBar.style.width = '0%';
    el.hudAction.textContent = '—';
    el.hudFps.textContent = '0 fps';
    setInterim('');

    clearInterval(clockTimer);
    clearInterval(statsTimer);
    el.clock.textContent = fmtClock(dur);
    updateStats();
  }

  function clearAll() {
    if (running) stopSession();

    segments = [];
    openSeg = null;
    utterances = [];
    actionCounts = {};
    eventSeq = 0;
    domEvents = 0;
    domUtts = 0;

    session = makeSession();
    startPerf = now();

    clearTimelineDom();
    clearTranscriptDom();
    rebuildTimeline();
    updateCounters();
    updateStats();
    el.clock.textContent = '00:00:00';
    el.nowIcon.textContent = '🙂';
    el.nowLabel.textContent = 'Waiting to start';
    el.nowSub.textContent = 'Nothing detected yet';
    el.btnStartLabel.textContent = 'Start session';
    toast('Cleared');
  }

  function makeSession() {
    return {
      startedAt: Date.now(),
      endedAt: null,
      duration: 0,
      lang: recLang,
      events: [],
      utterances: utterances,
      segments: segments
    };
  }

  /* ================================================================= *
   *  camera                                                           *
   * ================================================================= */
  function ensureCamera() {
    if (cameraOn && stream && stream.active) return Promise.resolve();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      banner(el.camWarn, 'This browser does not expose the camera API (<code>getUserMedia</code>). Try Chrome, Edge or Safari 14+.');
      return Promise.reject(new Error('getUserMedia unavailable'));
    }
    return startCamera();
  }

  function startCamera() {
    stopCamera();
    var constraints = {
      video: {
        facingMode: facing,
        width: { ideal: 1280 },
        height: { ideal: 960 },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: false
    };

    return navigator.mediaDevices.getUserMedia(constraints)
      .then(function (s) {
        stream = s;
        el.video.srcObject = s;
        var track = s.getVideoTracks()[0];
        if (track) {
          track.addEventListener('ended', function () {
            cameraOn = false;
            banner(el.camWarn, 'The camera stream stopped. Press start to open it again.');
          });
        }
        return el.video.play().catch(function () { /* autoplay muted is allowed */ });
      })
      .then(function () {
        cameraOn = true;
        banner(el.camWarn, null);
        banner(el.permWarn, null);
        sizeOverlay();
        if (fallback) fallback.reset();
        return true;
      });
  }

  function stopCamera() {
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
    }
    el.video.srcObject = null;
    cameraOn = false;
  }

  function clearOverlay() {
    var c = el.overlay;
    if (c && c.width) c.getContext('2d').clearRect(0, 0, c.width, c.height);
    lastKp = null;
  }

  function handleCamError(err) {
    var name = err && err.name ? err.name : '';
    var msg;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      msg = 'Camera permission was denied. Tap the 🔒 icon in the address bar, allow the camera, then press start.';
    } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      msg = 'No usable camera was found on this device.';
    } else if (name === 'NotReadableError') {
      msg = 'The camera is in use by another app. Close it and try again.';
    } else {
      msg = 'Could not open the camera: ' + (err && err.message ? err.message : err);
    }
    banner(el.camWarn, msg);
    toast(msg, 'err');
    if (running) {
      el.nowIcon.textContent = '🚫';
      el.nowLabel.textContent = 'No camera';
      el.nowSub.textContent = 'Speech is still being logged — fix the camera to track actions.';
    }
  }

  function sizeOverlay() {
    var w = el.video.videoWidth, h = el.video.videoHeight;
    if (w && h && (el.overlay.width !== w || el.overlay.height !== h)) {
      el.overlay.width = w;
      el.overlay.height = h;
    }
  }

  /* ================================================================= *
   *  pose loop                                                        *
   * ================================================================= */
  function frameLoop(ts) {
    if (!running) return;
    rafId = requestAnimationFrame(frameLoop);

    if (el.video.readyState >= 2) {
      if (!el.overlay.width) sizeOverlay();

      if (!poseBusy && ts - lastPoseMs >= 1000 / 12) {
        lastPoseMs = ts;
        poseFrames++;

        if (usingFallback) {
          fallbackTick(ts);
        } else {
          poseBusy = true;
          estimate(ts).then(function () { poseBusy = false; },
                            function () { poseBusy = false; });
        }
      }
      drawOverlay();
    }

    if (ts - fpsWindow >= 1000) {
      fpsWindow = ts;
      poseFps = poseFrames;
      poseFrames = 0;
      el.hudFps.textContent = poseFps + ' fps';
    }
  }

  function estimate(ts) {
    return PoseEngine.estimate(el.video).then(function (pose) {
      if (!running) return;
      var res = analyzer.update(pose, ts);
      lastKp = res.kp;
      lastMotion = res.motion || 0;
      paintNow(res);
    });
  }

  /* Motion-fallback path: cheap frame differencing, no model needed. */
  function fallbackTick(ts) {
    if (!fallback) return;
    var diff = fallback.sample(el.video);
    lastMotion = Math.min(1, diff * 4);

    var want = diff > 0.055 ? 'movement' : 'still';

    if (want !== fbState) {
      if (fbPending !== want) { fbPending = want; fbPendingSince = ts; }
      var need = want === 'movement' ? 700 : 1400;
      if (ts - fbPendingSince >= need) {
        var from = fbState;
        var dur = ts - fbSince;
        fbState = want;
        fbSince = ts;
        fbPending = null;
        onActionChange({ from: from, to: want, duration: dur, t: ts });
      }
    }

    paintNow({ action: fbState, pending: fbPending, person: true, conf: 0.5, motion: lastMotion });
    lastKp = null;
  }

  function paintNow(res) {
    var meta = PoseActions.META[res.action] || PoseActions.META.idle;
    var color = PoseActions.toneColor(meta.tone);

    el.nowIcon.textContent = meta.icon;
    el.nowIcon.style.background = color + '22';
    el.nowIcon.style.borderColor = color + '66';
    el.nowLabel.textContent = meta.label;

    var pend = res.pending ? (PoseActions.META[res.pending] || {}).label : null;
    var pct = Math.round((res.conf || 0) * 100);
    el.confBar.style.width = pct + '%';

    if (!res.person) {
      el.nowSub.textContent = 'Nobody in frame';
      el.confBar.style.width = '0%';
    } else if (usingFallback) {
      el.nowSub.textContent = 'Motion mode — pose model not loaded';
    } else if (pend && pend !== meta.label) {
      el.nowSub.textContent = 'detected: ' + pend + ' — holding…';
    } else {
      el.nowSub.textContent = 'confidence ' + pct + '% · ' +
        Math.round((res.motion || 0) * 100) + '% motion';
    }

    el.hudAction.textContent = meta.icon + ' ' + meta.label;
    el.hudAction.style.borderColor = color + '99';
    el.hudAction.style.color = color;
    el.qMotion.textContent = Math.round((res.motion || 0) * 100) + '%';
  }

  function drawOverlay() {
    var ctx = el.overlay.getContext('2d');
    var W = el.overlay.width, H = el.overlay.height;
    if (!W || !H) return;
    ctx.clearRect(0, 0, W, H);

    if (usingFallback) {
      if (lastMotion > 0.055) {
        var lw = Math.max(4, W / 160);
        ctx.strokeStyle = 'rgba(248,113,113,.85)';
        ctx.lineWidth = lw;
        ctx.strokeRect(lw / 2, lw / 2, W - lw, H - lw);
        PoseActions.drawTag(ctx, W / 2, H * 0.14, '🏃 movement', {
          size: Math.round(W / 34), border: 'rgba(248,113,113,.9)', color: '#ffe4e4'
        });
      }
      return;
    }

    if (!lastKp || lastKp.length !== 17) return;

    var box = PoseActions.drawSkeleton(ctx, lastKp, W, H, { mirror: true });
    var act = analyzer ? analyzer.action : 'idle';
    var meta = PoseActions.META[act] || PoseActions.META.idle;
    var color = PoseActions.toneColor(meta.tone);

    if (box) {
      var pad = W * 0.03;
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth = Math.max(2, W / 420);
      ctx.setLineDash([W / 60, W / 40]);
      PoseActions.roundRect(ctx, box.x0 - pad, box.y0 - pad,
                            (box.x1 - box.x0) + pad * 2, (box.y1 - box.y0) + pad * 2, W / 60);
      ctx.stroke();
      ctx.setLineDash([]);

      PoseActions.drawTag(ctx, box.x0 - pad, box.y0 - pad,
        meta.icon + ' ' + meta.label,
        { size: Math.round(W / 38), border: color + 'cc', color: '#ffffff' });
    }
  }

  /* ================================================================= *
   *  action events → timeline / segments                              *
   * ================================================================= */
  function onActionChange(e) {
    if (!session || !running) return;

    var fromMeta = PoseActions.META[e.from] || { label: e.from, icon: '❓' };
    var toMeta = PoseActions.META[e.to] || { label: e.to, icon: '❓' };

    if (e.from !== 'no-person') closeSegment(e.t);

    if (e.to === 'no-person') {
      pushEvent({ type: 'system', text: 'Person left the frame', icon: '🙈' });
    } else if (e.from === 'no-person') {
      openSegment(e.to, e.t);
      pushEvent({ type: 'system', text: 'Person in frame — ' + toMeta.label, icon: toMeta.icon });
    } else {
      openSegment(e.to, e.t);
      pushEvent({
        type: 'action',
        action: e.to,
        icon: toMeta.icon,
        label: toMeta.label,
        detail: 'was ' + fromMeta.label + ' for ' + fmtShort(e.duration),
        duration: e.duration
      });
    }
  }

  function openSegment(action, t) {
    if (openSeg) closeSegment(t);
    openSeg = { action: action, start: t };
    actionCounts[action] = (actionCounts[action] || 0) + 1;
  }

  function closeSegment(t) {
    if (!openSeg) return;
    if (t > openSeg.start) {
      openSeg.end = t;
      segments.push(openSeg);
    }
    openSeg = null;
  }

  function pushEvent(ev) {
    if (!session) return;
    ev.id = ++eventSeq;
    ev.ts = Date.now();
    ev.t = now() - startPerf;
    ev.off = fmtOffset(ev.t);
    session.events.push(ev);

    el.cntEvents.textContent = session.events.length;
    if (ev.type === 'speech') el.cntSpeech.textContent = utterances.length;

    if (filter !== 'all' && filter !== ev.type) return;

    var ul = el.timeline;
    var empty = ul.querySelector('.empty');
    if (empty) ul.removeChild(empty);
    ul.appendChild(renderEvent(ev));

    domEvents++;
    while (domEvents > 400 && ul.firstElementChild) {
      ul.removeChild(ul.firstElementChild);
      domEvents--;
    }
    if (el.autoScroll.checked) ul.scrollTop = ul.scrollHeight;
  }

  function renderEvent(ev) {
    var li = document.createElement('li');
    li.className = 't-' + ev.type;
    li.dataset.type = ev.type;

    var icon = ev.icon || (ev.type === 'speech' ? '💬' : '•');
    var title;
    if (ev.type === 'action') title = ev.label;
    else if (ev.type === 'speech') title = 'Speech captured';
    else title = ev.text;

    li.innerHTML =
      '<span class="t-time"></span>' +
      '<span class="t-ico"></span>' +
      '<span class="t-body"><b></b><span></span></span>' +
      (ev.duration ? '<span class="t-dur"></span>' : '');

    li.querySelector('.t-time').textContent = ev.off;
    li.querySelector('.t-ico').textContent = icon;
    li.querySelector('.t-body b').textContent = title;
    /* speech carries its words in the sub-line; system events already put
       the whole message in the title, so leave their sub-line empty */
    li.querySelector('.t-body span').textContent =
      ev.type === 'action' ? (ev.detail || '') :
      ev.type === 'speech' ? (ev.text || '') : '';
    if (ev.duration) li.querySelector('.t-dur').textContent = fmtShort(ev.duration);
    return li;
  }

  function rebuildTimeline() {
    clearTimelineDom();
    if (!session || !session.events.length) {
      el.timeline.innerHTML = '<li class="empty">Events will appear here once the session starts.</li>';
      return;
    }
    /* only the most recent events are materialised in the DOM */
    var all = session.events;
    var start = Math.max(0, all.length - 400);
    var frag = document.createDocumentFragment();
    for (var i = start; i < all.length; i++) {
      var ev = all[i];
      if (filter !== 'all' && filter !== ev.type) continue;
      frag.appendChild(renderEvent(ev));
      domEvents++;
    }
    el.timeline.appendChild(frag);
    if (!domEvents) {
      el.timeline.innerHTML = '<li class="empty">No events match this filter.</li>';
    } else {
      el.timeline.scrollTop = el.timeline.scrollHeight;
    }
  }

  function clearTimelineDom() {
    el.timeline.innerHTML = '';
    domEvents = 0;
  }

  /* ================================================================= *
   *  speech recognition                                               *
   * ================================================================= */
  function startMic() {
    if (!SR) {
      micOn = false;
      paintMic();
      return;
    }
    if (!rec) buildRecognizer();
    rec.lang = recLang;
    recWanted = true;
    if (!recActive) {
      try { rec.start(); } catch (e) { /* already running */ }
    }
  }

  function stopMic() {
    recWanted = false;
    setInterim('');
    if (rec) { try { rec.stop(); } catch (e) {} }
  }

  function buildRecognizer() {
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = recLang;

    rec.onstart = function () {
      recActive = true;
      paintMic();
    };

    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        var txt = ((r[0] && r[0].transcript) || '').trim();
        if (!txt) continue;
        if (r.isFinal) addUtterance(txt);
        else interim += txt + ' ';
      }
      setInterim(interim.trim());
    };

    rec.onerror = function (e) {
      recActive = false;
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        recWanted = false;
        micOn = false;
        paintMic();
        banner(el.permWarn,
          'Microphone permission denied — speech is not being recorded. ' +
          'Allow the microphone, then press the mic button.');
      } else if (e.error === 'language-not-supported') {
        recWanted = false;
        micOn = false;
        paintMic();
        toast('Language "' + recLang + '" is not supported by this recogniser.', 'err');
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        toast('Speech recogniser error: ' + e.error, 'err');
      }
    };

    rec.onend = function () {
      recActive = false;
      setInterim('');
      if (recWanted && running && micOn) {
        setTimeout(function () {
          if (recWanted && running && micOn) { try { rec.start(); } catch (e) {} }
        }, 350);
      } else {
        paintMic();
      }
    };
  }

  function addUtterance(text) {
    if (!text) return;
    setInterim('');

    var t = now() - startPerf;
    var u = { t: t, off: fmtOffset(t), ts: Date.now(), text: text, lang: recLang };
    utterances.push(u);

    pushEvent({ type: 'speech', icon: '💬', text: text });

    var tr = el.transcript;
    var empty = tr.querySelector('.empty');
    if (empty) tr.removeChild(empty);

    var div = document.createElement('div');
    div.className = 'uttr';
    var time = document.createElement('span');
    time.className = 'u-time';
    time.textContent = u.off;
    var body = document.createElement('span');
    body.className = 'u-text';
    body.textContent = text;
    div.appendChild(time);
    div.appendChild(body);
    tr.appendChild(div);

    domUtts++;
    while (domUtts > 300 && tr.firstElementChild) { tr.removeChild(tr.firstElementChild); domUtts--; }
    tr.scrollTop = tr.scrollHeight;

    el.cntSpeech.textContent = utterances.length;
    updateCounters();
  }

  function setInterim(txt) {
    if (txt) {
      el.interimBox.hidden = false;
      el.interimText.textContent = txt;
    } else {
      el.interimBox.hidden = true;
      el.interimText.textContent = 'listening…';
    }
  }

  function paintMic() {
    var on = micOn && !!SR;
    el.btnMic.className = 'pill ' + (on ? 'on' : 'off');
    el.btnMic.querySelector('span').textContent = on
      ? (recActive ? 'Listening…' : 'Mic on')
      : 'Mic off';
  }

  function toggleMic() {
    if (!SR) { toast('Speech recognition is not available in this browser.', 'err'); return; }
    micOn = !micOn;
    paintMic();
    if (micOn && running) startMic(); else stopMic();
  }

  function clearTranscriptDom() {
    el.transcript.innerHTML =
      '<p class="empty">Nothing has been said yet — or the microphone is off.</p>';
    domUtts = 0;
    el.cntSpeech.textContent = '0';
    setInterim('');
  }

  /* ================================================================= *
   *  clock + stats                                                    *
   * ================================================================= */
  function startClock() {
    clearInterval(clockTimer);
    clockTimer = setInterval(function () {
      el.clock.textContent = fmtClock(now() - startPerf);
    }, 250);
  }

  function startStats() {
    clearInterval(statsTimer);
    statsTimer = setInterval(updateStats, 1200);
  }

  function totalWords() {
    var w = 0;
    for (var i = 0; i < utterances.length; i++) w += countWords(utterances[i].text);
    return w;
  }

  function updateCounters() {
    var tracked = 0;
    for (var k in actionCounts) {
      if (Object.prototype.hasOwnProperty.call(actionCounts, k) && k !== 'no-person') tracked += actionCounts[k];
    }
    el.qActions.textContent = tracked;
    el.qSpeech.textContent = utterances.length;
    el.qWords.textContent = totalWords();
    el.cntSpeech.textContent = utterances.length;
    if (session) el.cntEvents.textContent = session.events.length;
  }

  function updateStats() {
    if (!session) return;
    updateCounters();

    var totals = {}, counts = {};
    var i;
    for (i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (!s.action || s.action === 'no-person') continue;
      totals[s.action] = (totals[s.action] || 0) + (s.end - s.start);
      counts[s.action] = (counts[s.action] || 0) + 1;
    }
    if (openSeg && openSeg.action !== 'no-person') {
      var live = Math.max(0, now() - openSeg.start);
      totals[openSeg.action] = (totals[openSeg.action] || 0) + live;
      counts[openSeg.action] = (counts[openSeg.action] || 0) + 1;
    }

    var changes = 0;
    for (i = 0; i < session.events.length; i++) if (session.events[i].type === 'action') changes++;

    el.statsGrid.innerHTML =
      stat(fmtClock(currentDuration()), 'recorded time') +
      stat(changes, 'action changes') +
      stat(Object.keys(counts).length, 'action types') +
      stat(utterances.length, 'speeches') +
      stat(totalWords(), 'words') +
      stat(poseFps + ' fps', 'pose rate');

    var keys = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; });
    if (!keys.length) {
      el.bars.innerHTML = '<p class="empty">No data yet.</p>';
      el.statChips.innerHTML = '<p class="empty">No data yet.</p>';
      return;
    }

    var max = totals[keys[0]] || 1;
    var html = '', chips = '';
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      var m = PoseActions.META[k] || { label: k, icon: '❓', tone: 'muted' };
      var pct = Math.max(3, (totals[k] / max) * 100);
      html += '<div class="bar">' +
        '<span class="bar-label">' + m.icon + ' ' + esc(m.label) + '</span>' +
        '<span class="bar-track"><i class="bar-fill" style="width:' + pct.toFixed(1) +
        '%;--c:' + PoseActions.toneColor(m.tone) + '"></i></span>' +
        '<span class="bar-val">' + fmtShort(totals[k]) + ' · ' + counts[k] + '×</span>' +
        '</div>';
      chips += '<span class="fchip active">' + m.icon + ' ' + esc(m.label) + ' · ' + counts[k] + '</span>';
    }
    el.bars.innerHTML = html;
    el.statChips.innerHTML = chips;
  }

  function stat(v, label) {
    return '<div class="stat"><b>' + esc(v) + '</b><span>' + esc(label) + '</span></div>';
  }

  /* ================================================================= *
   *  export                                                           *
   * ================================================================= */
  function download(name, mime, data) {
    var blob = new Blob([data], { type: mime + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
           pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return '"' + v.replace(/"/g, '""') + '"';
  }

  function actionTotals() {
    var t = {};
    segments.forEach(function (s) {
      if (!s.action || s.action === 'no-person') return;
      t[s.action] = (t[s.action] || 0) + (s.end - s.start);
    });
    if (openSeg && openSeg.action !== 'no-person') {
      t[openSeg.action] = (t[openSeg.action] || 0) + Math.max(0, now() - openSeg.start);
    }
    return t;
  }

  function exportAs(fmt) {
    if (!session || (!session.events.length && !utterances.length)) {
      toast('Nothing to export yet.', 'err');
      return;
    }
    var name = 'actionlog_' + stamp();
    var data;

    if (fmt === 'csv') {
      var rows = [['id', 'elapsed_ms', 'clock', 'epoch_iso', 'type', 'key', 'label', 'detail', 'duration_ms']];
      session.events.forEach(function (e) {
        rows.push([
          e.id, Math.round(e.t), e.off, new Date(e.ts).toISOString(), e.type,
          e.action || '', e.label || (e.type === 'speech' ? 'speech' : e.text) || '',
          e.detail || e.text || '', e.duration ? Math.round(e.duration) : ''
        ]);
      });
      data = '\ufeff' + rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
      download(name + '.csv', 'text/csv', data);

    } else if (fmt === 'json') {
      data = JSON.stringify({
        app: 'ActionLog',
        version: 1,
        startedAt: new Date(session.startedAt).toISOString(),
        endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : null,
        durationMs: Math.round(currentDuration()),
        speechLanguage: recLang,
        actionTimeMs: actionTotals(),
        actionChangeCounts: actionCounts,
        utterances: utterances.map(function (u) {
          return { atMs: Math.round(u.t), at: new Date(u.ts).toISOString(), text: u.text, lang: u.lang };
        }),
        segments: segments.map(function (s) {
          return { action: s.action, startMs: Math.round(s.start), endMs: Math.round(s.end) };
        }),
        events: session.events
      }, null, 2);
      download(name + '.json', 'application/json', data);

    } else if (fmt === 'srt') {
      if (!utterances.length) { toast('No speech to export yet.', 'err'); return; }
      var out = [];
      utterances.forEach(function (u, i) {
        var next = utterances[i + 1];
        var est = Math.max(1500, u.text.length * 70);
        var end = next ? Math.min(next.t, u.t + est) : u.t + est;
        if (end <= u.t) end = u.t + 1500;
        out.push(String(i + 1));
        out.push(fmtSrt(u.t) + ' --> ' + fmtSrt(end));
        out.push(u.text);
        out.push('');
      });
      download(name + '.srt', 'application/x-subrip', out.join('\n'));

    } else {
      var L = [];
      L.push('ActionLog session');
      L.push('==================');
      L.push('Started : ' + new Date(session.startedAt).toString());
      L.push('Length  : ' + fmtClock(currentDuration()));
      L.push('Language: ' + recLang);
      L.push('');

      var tot = actionTotals(), cnt = {};
      segments.forEach(function (s) {
        if (!s.action || s.action === 'no-person') return;
        cnt[s.action] = (cnt[s.action] || 0) + 1;
      });
      var ks = Object.keys(tot).sort(function (a, b) { return tot[b] - tot[a]; });
      if (ks.length) {
        L.push('TIME BY ACTION');
        L.push('--------------');
        ks.forEach(function (k) {
          var m = PoseActions.META[k] || { label: k };
          L.push('  ' + pad2(m.label, 30) + fmtShort(tot[k]).padStart(8) + '  (' + cnt[k] + 'x)');
        });
        L.push('');
      }

      L.push('TIMELINE');
      L.push('--------');
      session.events.forEach(function (e) {
        var head = '[' + e.off + '] ';
        if (e.type === 'action') L.push(head + 'ACTION  ' + e.label + (e.detail ? '  (' + e.detail + ')' : ''));
        else if (e.type === 'speech') L.push(head + 'SPEECH  ' + e.text);
        else L.push(head + 'SYSTEM  ' + e.text);
      });
      L.push('');

      L.push('TRANSCRIPT');
      L.push('----------');
      if (utterances.length) {
        utterances.forEach(function (u) { L.push('[' + u.off + '] ' + u.text); });
      } else {
        L.push('(nothing was captured)');
      }

      data = L.join('\r\n');
      download(name + '.txt', 'text/plain', data);
    }

    el.modal.hidden = true;
    toast('Exported ' + fmt.toUpperCase(), 'ok');
  }

  function pad2(s, n) {
    s = String(s);
    while (s.length < n) s += ' ';
    return s;
  }

  /* ================================================================= *
   *  snapshot                                                         *
   * ================================================================= */
  function snapshot() {
    if (!cameraOn) { toast('The camera is not running.', 'err'); return; }
    var W = el.video.videoWidth, H = el.video.videoHeight;
    if (!W) return;
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var x = c.getContext('2d');
    x.save();
    x.translate(W, 0);
    x.scale(-1, 1);                       // match the mirrored preview
    x.drawImage(el.video, 0, 0, W, H);
    x.restore();
    x.drawImage(el.overlay, 0, 0, W, H);
    c.toBlob(function (blob) {
      if (!blob) { toast('Snapshot failed.', 'err'); return; }
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'actionlog_' + stamp() + '.png';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('Snapshot saved', 'ok');
    }, 'image/png');
  }

  /* ================================================================= *
   *  model load (with graceful fallback)                              *
   * ================================================================= */
  function loadModel() {
    el.hudModel.textContent = 'model: …';
    banner(el.modelBanner,
      'Loading the pose model — a few MB once, then it is cached for offline use…');

    return PoseEngine.init(function (step) {
      el.camHint.textContent = step;
    }).then(function () {
      usingFallback = false;
      banner(el.modelBanner, null);
      el.hudModel.textContent = 'model: MoveNet';
      el.hudModel.style.borderColor = 'rgba(46,204,113,.55)';
      el.hudModel.style.color = '#9df5c4';
      el.camHint.textContent = running
        ? 'Session running — actions and speech are being logged.'
        : 'Opens the front camera, watches the person in view and writes down what they say.';
      toast('Pose model ready', 'ok');
    }).catch(function (err) {
      usingFallback = true;
      fallback = new MotionFallback(64, 48);
      el.hudModel.textContent = 'model: motion mode';
      el.hudModel.style.borderColor = 'rgba(245,166,35,.55)';
      el.hudModel.style.color = '#ffd894';
      banner(el.modelBanner,
        '<b>MoveNet could not be loaded</b> (' + esc((err && err.message) || err) + '). ' +
        'The app keeps working in <b>motion mode</b>: it reports movement instead of named actions. ' +
        'Reconnect and reload to enable full tracking.');
      if (running) el.camHint.textContent = 'Session running in motion mode.';
      toast('Pose model unavailable — using motion mode', 'err');
    });
  }

  /* ================================================================= *
   *  UI wiring                                                        *
   * ================================================================= */
  function switchTab(name) {
    ['timeline', 'transcript', 'stats'].forEach(function (t) {
      var btn = document.querySelector('.tab[data-tab="' + t + '"]');
      var panel = byId('panel-' + t);
      var on = t === name;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      if (panel) panel.classList.toggle('active', on);
    });
    if (name === 'stats') updateStats();
  }

  function applyFilter(f) {
    filter = f;
    Array.prototype.forEach.call(document.querySelectorAll('.fchip[data-filter]'), function (b) {
      b.classList.toggle('active', b.dataset.filter === f);
    });
    rebuildTimeline();
  }

  function guessLang() {
    var nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'en-US';
    var sel = el.selLang;
    var i;
    for (i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value.toLowerCase() === nav.toLowerCase()) return sel.options[i].value;
    }
    var base = nav.split('-')[0].toLowerCase();
    for (i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value.split('-')[0].toLowerCase() === base) return sel.options[i].value;
    }
    return 'en-US';
  }

  function bind() {
    el.btnStartBig.addEventListener('click', function () {
      if (running) stopSession(); else startSession();
    });

    el.btnFlip.addEventListener('click', function () {
      facing = facing === 'user' ? 'environment' : 'user';
      if (cameraOn) {
        startCamera()
          .then(function () { toast(facing === 'user' ? 'Front camera' : 'Rear camera'); })
          .catch(handleCamError);
      } else {
        toast(facing === 'user' ? 'Front camera selected' : 'Rear camera selected');
      }
    });

    el.btnShot.addEventListener('click', snapshot);

    el.btnFullscreen.addEventListener('click', function () {
      var n = el.cam;
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        (document.exitFullscreen || document.webkitExitFullscreen).call(document);
      } else if (n.requestFullscreen) n.requestFullscreen();
      else if (n.webkitRequestFullscreen) n.webkitRequestFullscreen();
    });

    el.btnMic.addEventListener('click', toggleMic);

    el.selLang.addEventListener('change', function () {
      recLang = el.selLang.value;
      try { localStorage.setItem('actionlog.lang', recLang); } catch (e) {}
      if (session) session.lang = recLang;
      if (rec) rec.lang = recLang;
      if (micOn && running) { stopMic(); setTimeout(startMic, 250); }
      toast('Speech language: ' + recLang);
    });

    el.btnClear.addEventListener('click', clearAll);

    el.btnExport.addEventListener('click', function () { el.modal.hidden = false; });
    el.modalClose.addEventListener('click', function () { el.modal.hidden = true; });
    el.modal.addEventListener('click', function (e) {
      if (e.target === el.modal) { el.modal.hidden = true; return; }
      var b = e.target.closest ? e.target.closest('.dl') : null;
      if (b && b.dataset.fmt) exportAs(b.dataset.fmt);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !el.modal.hidden) el.modal.hidden = true;
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab); });
    });

    Array.prototype.forEach.call(document.querySelectorAll('.fchip[data-filter]'), function (b) {
      b.addEventListener('click', function () { applyFilter(b.dataset.filter); });
    });

    el.video.addEventListener('loadedmetadata', sizeOverlay);
    window.addEventListener('resize', sizeOverlay);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && micOn && running && !recActive) startMic();
    });

    window.addEventListener('pagehide', function () {
      stopMic();
      stopCamera();
    });

    /* coming back from the bfcache / another app: reopen what we closed */
    window.addEventListener('pageshow', function () {
      if (running && !cameraOn) ensureCamera().catch(handleCamError);
      if (running && micOn && !recActive) startMic();
    });
  }

  /* ================================================================= *
   *  boot                                                             *
   * ================================================================= */
  function init() {
    IDS.forEach(function (id) { el[id] = byId(id); });

    analyzer = new PoseActions.Analyzer();
    analyzer.on(onActionChange);

    utterances = [];
    segments = [];
    session = makeSession();
    startPerf = now();

    try { recLang = localStorage.getItem('actionlog.lang') || guessLang(); }
    catch (e) { recLang = guessLang(); }
    el.selLang.value = recLang;

    if (!window.isSecureContext) {
      banner(el.secureWarn,
        '⚠️ Camera and microphone need a secure connection. Open this page over <b>https://</b> ' +
        'or <b>http://localhost</b> — a plain <code>file://</code> page will not work.');
    }
    if (!SR) {
      banner(el.permWarn,
        'This browser has no Web Speech API, so <b>speech capture is unavailable</b>. ' +
        'Use Chrome or Edge (Android / Windows / macOS), or Safari 16.4+.');
      micOn = false;
    }

    paintMic();
    bind();
    updateCounters();
    updateStats();
    setStatus('', 'Idle');
    rebuildTimeline();

    if (location.protocol === 'https:' || location.hostname === 'localhost') {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(function () {});
      }
    }

    loadModel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
