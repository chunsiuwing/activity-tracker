# ActionLog — live action & speech tracker

> **Live:** <https://chunsiuwing.github.io/activity-tracker/>

Open the phone's **front camera**, follow the person in view, and write down
**what they do** and **what they say** — live, on one screen.

It is a plain web app / installable PWA. No build step, no server code, no
account, nothing uploaded.

```
camera  ──▶ MoveNet pose  ──▶ rule-based action labels ──▶ timeline
mic     ──▶ Web Speech API ──▶ transcript ───────────────▶ timeline
```

---

## Run it

Browsers block the camera on `file://` pages, so it must be served over
http(s):

```bash
cd activity-tracker
python -m http.server 8000        # or: npx serve .
```

Then open <http://localhost:8000/> and press **Start session**.

**On a phone**, the computer and phone must be on the same network — use the
LAN address printed by the server (e.g. `http://192.168.1.20:8000`). A plain
`http://192.168…` page is *not* a secure context, so the camera will still be
blocked; the options are:

| approach | notes |
|---|---|
| `https://` (recommended) | Any static host works — GitHub Pages, Netlify, Cloudflare Pages, your own nginx. |
| Chrome `chrome://flags/#unsafely-treat-insecure-origin-as-secure` | Add your `http://192.168…` origin. Dev only. |
| Port-forward over SSH/Tailscale so it is served on `https://localhost` | Good for local testing. |

Once served over https, the manifest makes it installable: **Add to Home
Screen** gives a full-screen app with its own icon.

---

## Deploy (GitHub Pages)

The site above is published from this repo:

```bash
gh repo create activity-tracker --public --source=. --push   # once
gh api repos/chunsiuwing/activity-tracker/pages -X POST \
    -f "source[branch]=main" -f "source[path]=/"             # once
```

Pushes to `main` republish automatically in ~1 minute. Every path in the app
is relative (`./…`), so it works unchanged at a domain root or a sub-path.

To publish from somewhere else (Netlify, Cloudflare Pages, your own nginx),
just serve the directory's contents — there is nothing to build. The only
requirements are HTTPS and serving `.webmanifest` as `application/manifest+json`.

---

## What it tracks

Actions are inferred from a single 2-D pose with plain geometry rules — no
cloud, no training data, deterministic and inspectable.

| group | labels |
|---|---|
| posture | Standing · Sitting · Idle |
| locomotion | Walking · Coming closer · Moving away |
| arms | Waving · Hand raised · Pointing (left / right arm) · Arms crossed |
| whole body | Jumping · Clapping · Bowing / leaning forward · Leaning sideways |
| fallback | Movement detected · Still (motion mode only) |

Each label needs to stay stable for its own hold time (400 ms for a jump, 1.6 s
for standing) before it is committed, so one noisy frame never flickers the
timeline.

Speech uses the browser's built-in recogniser (`webkitSpeechRecognition`),
streaming interim results while the person talks. Pick the language from the
dropdown; it is remembered.

### Displayed live

- mirrored camera preview with a skeleton overlay, bounding box and current label
- "now" card with the current action, a pending candidate and pose confidence
- session clock, pose frame-rate, motion meter
- **Timeline** — timestamped action changes (with how long the previous action
  lasted), speech and system events; filter by type
- **Transcript** — everything said, with live interim text
- **Stats** — recorded time, action counts, time-by-action bars, word count

### Export

**⬇ Export** → `TXT` (readable log), `CSV` (one row per event, Excel/Sheets),
`JSON` (full structured session), `SRT` (timed captions of the transcript).
There is also 📷 to save a snapshot of the preview with the overlay burned in.

---

## Files

```
index.html          UI shell
style.css           dark mobile-first styling
manifest.webmanifest  installable PWA metadata
sw.js               offline app shell + cached ML bundles
js/actions.js       pose features, action rules, skeleton drawing  ← the brain
js/pose-engine.js   MoveNet wrapper + frame-difference fallback
js/app.js           camera, timeline, speech, stats, export
icons/              SVG + generated PNGs (icons/make_icons.py)
test/actions.test.js  headless tests for the classifier
```

### Tests

```bash
node test/actions.test.js
```

15 checks drive the classifier with synthetic skeletons — standing, waving,
hand-raised, jumping, sitting, walking, person lost, noise rejection, and the
drawing helpers.

### Regenerate icons

```bash
pip install pillow
python icons/make_icons.py
```

---

## Graceful degradation

1. **Pose model unavailable** (offline first run, blocked CDN) → the app drops
   to *motion mode*: cheap frame differencing that reports movement instead of
   named actions, with a banner explaining why. Reload with a connection to
   re-enable MoveNet.
2. **No camera** → the session still runs for speech; the card says so plainly.
3. **No Web Speech API** (Firefox) → actions still work; the banner says speech
   is unavailable.

---

## Privacy & limits

Video frames and audio are processed **inside the browser**. Pose detection is
TensorFlow.js on the WebGL backend; speech is handed to your browser vendor's
recogniser, which is the one thing that needs a network connection.

- One person is tracked at a time (MoveNet SinglePose) — the main subject in
  frame.
- Labels are 2-D heuristics. Depth, occlusion and unusual camera angles will
  occasionally be wrong; treat them as a guide.
- Action labels are **not** identity, emotion or intent recognition.
