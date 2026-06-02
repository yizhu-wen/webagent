# Project Context

## Overview

This project is a browser-based sensing and behavior-tracking prototype. The root page plays a looping ultrasound chirp, records microphone audio while sensing is active, tracks user behavior only during active sensing, renders a recorded spectrogram, and downloads session artifacts when sensing stops.

There are also dummy experiment websites for collecting interaction behavior in simple task contexts:

- E-commerce and Shopping: `experiments/index.html`
- Travel and Tourism: `experiments/travel/index.html`

The current design goal is intentionally simple and functional, with minimal visual distraction.

## Primary Files

- `index.html`: Main sensing page. Contains UI, microphone capture, chirp playback, event tracking, WAV export, and spectrogram rendering.
- `server.py`: Lightweight Python HTTP server for local static serving and legacy audio endpoints.
- `triangle_fmcw_20-23kHz_20ms_48kHz_loop.wav`: One-chirp ultrasound loop file used for sensing playback and Python IQ reference.
- `experiments/index.html`: Simple shopping dummy website.
- `experiments/travel/index.html`: Simple travel and tourism dummy website.
- `experiments/site.js`: Shared experiment-site behavior for sensing, microphone recording, spectrogram generation, filtering, selection buttons, forms, and downloads.
- `experiments/tracker.js`: Shared gated client-side interaction tracker for experiment sites.
- `experiments/styles.css`: Shared experiment styles plus travel-specific scoped styles.
- `tests/*.spec.js`: Playwright tests for tracking, sensing controls, shopping, and travel.
- `package.json`, `playwright.config.js`: Playwright test setup.

## Running The Website

From the project root:

```bash
python -m pip install -r requirements.txt
python server.py
```

Then open:

```text
http://localhost:8000/
```

Current experiment URLs:

```text
http://localhost:8000/experiments/
http://localhost:8000/experiments/travel/
```

The requirements file installs the packages needed by the real-time IQ backend
and server-generated analysis figures: NumPy, SciPy, SoundFile, and Matplotlib.

`python server.py` starts the website on `http://localhost:8000/` and serves the
real-time IQ WebSocket endpoint on the same public port at
`ws://localhost:8000/realtime`. On Render, the browser automatically uses
`wss://<your-service>.onrender.com/realtime`. Click `Start sensing` to stream
Float32 microphone frames to Python and update the live amplitude/phase chart.
For manual debugging, `python realtime_server.py` can still run the older
standalone WebSocket backend by itself.

Keyboard and mouse markers on the live chart are shifted by
`webagentAudioEventOffsetMs` to account for audio capture, buffering, and chirp
window latency. The default is `80` ms and can be changed in the browser console:

```js
localStorage.setItem("webagentAudioEventOffsetMs", "120");
```

Use `localStorage.removeItem("webagentAudioEventOffsetMs")` to return to the
default. Tune this with repeated key taps or mouse clicks on the target laptop.

The browser defaults to the same-origin `/realtime` WebSocket endpoint. To test
with a different public backend, set an override:

```js
localStorage.setItem("webagentRealtimeWebSocketUrl", "wss://your-backend.example/ws");
```

Use `localStorage.removeItem("webagentRealtimeWebSocketUrl")` to return to the
same-origin default.

## Render Deployment

`render.yaml` is a Render Blueprint for the web service:

- Build command: `pip install -r requirements.txt`
- Start command: `python server.py`
- Health check: `/healthz`

Render provides the `PORT` environment variable automatically. Locally, the
server defaults to port `8000`; override it with `PORT=8124 python server.py`
on shells that support inline environment variables.

The upload and analysis outputs under `uploads/` are local instance files. Use a
Render persistent disk or object storage if uploaded sessions must survive free
instance restarts or redeploys. The `/api/analyze-recording` route also needs
`analyze_webagent_recording.py` available with the deployed code before online
Python figures can be generated.

## Main Site Behavior

- Requests microphone permission on load.
- Loads `triangle_fmcw_20-23kHz_20ms_48kHz_loop.wav`, a 20 ms one-chirp asset instead of the old 600 s WAV.
- Start sensing decodes and loops the chirp through the 48 kHz Web Audio context, producing the same repeated chirp sequence with much less network loading.
- Start sensing streams microphone frames to the same-origin `/realtime`
  WebSocket endpoint and updates the live amplitude/phase chart.
- Live IQ feature timestamps come from the processed audio sample index and the
  center of each 20 ms chirp window after chirp-boundary alignment, not from the
  time Python finishes calculating the feature.
- Live IQ uses latest-only transport: browser audio frames include timestamp and
  sequence metadata, the browser drops frames when the WebSocket send buffer is
  backed up, and Python drops stale queued frames before realigning on fresh
  audio. This keeps the chart current on low-CPU deployments.
- Live Python IQ defaults to 25 Hz feature output, 96 range bins, 4 chirps for
  alignment, and a 0.6 s alignment search window so hosted Render instances can
  keep up. Override with `REALTIME_FEATURE_HZ`, `REALTIME_RANGE_BINS`,
  `REALTIME_REF_CHIRPS`, and `REALTIME_ALIGN_SEARCH_SECONDS` when using a larger
  machine.
- Stop sensing stops playback and recording.
- Behavioral data is tracked only while sensing is active.
- Stop automatically downloads the tracking JSON and OS-style event log for that sensing period.
- Stop also downloads the sensed microphone audio WAV, rendered spectrogram PNG,
  and recording diagnostics JSON.
- Stop can generate an input-event analysis PNG from the recorded WAV, keydown
  events, and touchpad-style events when the app is served by `server.py`.
  The browser uploads the recorded WAV, OS-style event log, and diagnostics to
  the Python backend, which runs the full IQ processing chain in
  `analyze_webagent_recording.py`.
- Microphone capture is constrained toward 48 kHz mono with browser DSP disabled,
  buffered as float samples, and exported as mono 32-bit IEEE-float WAV to match
  the Python `sounddevice`/`soundfile` capture path as closely as browser APIs allow.
- The diagnostics JSON records requested microphone constraints, browser-reported
  `MediaStreamTrack` settings/capabilities/constraints, `AudioContext` sample
  rate/latency, playback buffer rate, exported WAV format, and an empirical
  autocorrelation check around the expected 20 ms / 960-sample chirp period.
- The spectrogram renderer includes axes and uses the same visual generation style expected by the tests.
- The main page links to both dummy experiment sites.

## Real-Time Python IQ

Real-time mode is implemented by:

- `audio-frame-worklet.js`: browser `AudioWorkletProcessor` that downmixes mic
  input and emits fixed-size Float32 frames.
- `server.py`: HTTP static/API server plus the public `/realtime` WebSocket
  endpoint used locally and on Render.
- `realtime_server.py`: older standalone local WebSocket server at
  `ws://127.0.0.1:8765`, kept for manual debugging.
- `realtime_iq.py`: streaming IQ processor that performs causal bandpass,
  chirp alignment, dechirp/range-bank matching, and live amplitude/phase
  extraction. Feature messages include chirp-window sample/timing metadata so
  the browser can place amplitude/phase points on the audio timeline. The
  startup alignment intentionally uses a short valid-lag FFT correlation window
  so Render free instances can start producing live features quickly.

The real-time backend intentionally sends feature numbers, not matplotlib
images. The browser draws the live chart so updates stay responsive. The
existing Stop-time WAV upload and matplotlib figure generation remain available
for offline validation.

## Experiment Site Behavior

Both shopping and travel:

- Request microphone permission first.
- Have Start sensing and Stop buttons.
- Track behavior only while sensing is active.
- Reset tracking data at the start of each sensing session.
- Decode and loop the chirp through the 48 kHz Web Audio context.
- Capture mono float microphone samples and export mono 32-bit IEEE-float WAV.
- On Stop, automatically download:
  - Tracking JSON
  - Pipe-delimited OS-style event log
  - Sensed microphone audio WAV
  - Recorded spectrogram PNG
  - Recording diagnostics JSON
  - Input-event amplitude/phase analysis PNG, when the Python server endpoint is available
- Show the recorded spectrogram on the page after Stop.
- Use the shared spectrogram generation code in `experiments/site.js`, including axes.

## Figure Generation

The exact Python pipeline generates only the input-event amplitude/phase figure on
Stop when the app is served by the Python backend:

- `input_events_amplitude_phase.png`

This figure has two panels:

- Normalized matched-filter amplitude from the full IQ chain with `keydown`
  and touchpad-style markers and labels.
- Unwrapped matched-filter phase from the full IQ chain with the same
  `keydown` and touchpad-style markers and labels.

Use these inputs:

- Recorded microphone WAV from Stop sensing.
- OS-style event log from the same Stop sensing session.
- Recording diagnostics JSON, optional but uploaded when available.

Start the Python backend with:

```text
python server.py
```

The endpoint `/api/analyze-recording` saves each uploaded sensing session under
`webagent/uploads/`, runs `analyze_webagent_recording.py --figure-set
input-amplitude-phase`, and returns a link to the generated figure. If a
plain static server is used, the regular WAV, browser spectrogram, diagnostics,
and tracking downloads still work, but the exact Python figure cannot be
generated.

For manual analysis without using the website backend, run the local GUI from
the project root:

```text
python webagent_analysis_gui.py
```

Choose the recorded WAV and matching `os_event_log_*.txt`. The diagnostics JSON
is optional. The GUI runs the same analyzer and writes `input_events_amplitude_phase.png`
to `analysis_outputs/<recording-name>/` unless another output folder is selected.

## Tracked User Events

The behavioral tracker records gesture-focused events plus key-down events:

- `pointer_down`
- `pointer_up`
- `pointer_cancel`
- `keydown`
- `tap`
- `tap_to_click`
- `double_tap`
- `double_tap_to_click`
- `click`
- `double_click`
- `press`
- `press_to_click`
- `double_press`
- `double_press_to_click`
- `long_press`
- `long_press_to_click`
- `drag_start`
- `drag_move`
- `drag_end`
- `swipe`
- `two_finger_swipe`
- `wheel_swipe`
- `wheel_pinch`
- `pinch_start`
- `pinch_change`
- `pinch_end`
- `range_input`
- `range_change`
- `native_drag_start`
- `native_drop`
- `native_drag_end`
- `form_submit`

The downloadable log may also include an internal download marker event such as `tracking_data_downloaded`.
Each JSON event includes both an ISO `timestamp` and numeric `epochSeconds`.
The extra `os_event_log_*.txt` download uses the same broad shape as the Python capture logs:

```text
# start_epoch | 1710000000.000000
# format | EVENT | VALUE | EPOCH_SECONDS
TAP | gesture=tap pointerType=mouse x=120 y=80 | 1710000001.234567
KEYDOWN | key=Tab code=Tab location=0 button#stopSensingBtn label=Stop | 1710000001.300000
DRAG_END | gesture=drag pointerType=mouse dx=90 dy=40 | 1710000001.345678
CLICK | button=0 x=120 y=80 button#stopSensingBtn label=Stop | 1710000002.000000
```

This is browser-page scoped, not a global OS hook; events outside the page are not visible to the browser.

The tracker intentionally no longer logs generic page views, raw mousemove,
scroll, key-up, or visibility events. Printable `keydown` values are logged as
`key=character`; browser `code` is still included so physical key identity is available.

## Shopping Experiment

Route:

```text
/experiments/
```

Topic: E-commerce and Shopping.

Features:

- Simple product list with five products.
- Search input, category select, and checkbox filters.
- Filters do not apply immediately; they apply only after clicking `Apply search`.
- Product rows include labels/tags so filtering is visible and testable.
- Add-to-cart, save, checkout form, pointer/touch gestures, drag-like movement, wheel gestures, and form-submit actions are available for tracking.
- Download filename prefix: `shopping_recording`.
- Tracking JSON slug: `simple-shopping`.

## Travel Experiment

Route:

```text
/experiments/travel/
```

Topic: Travel and Tourism.

Features:

- Simple travel-planner style distinct from the shopping page.
- Five trip rows with numbered itinerary-style layout.
- Search input, trip type select, and checkbox filters.
- Filters apply only after clicking `Apply search`.
- Select trip, save, details, booking form, pointer/touch gestures, drag-like movement, wheel gestures, and form-submit actions are available for tracking.
- Each trip has a `Details` button that expands details inline inside that same trip row, not in a shared bottom panel.
- Inline trip details show duration, route, included items, note, and price.
- Inline trip details include `Use this trip`, which adds that trip to the booking count and can prefill booking notes, plus `Close details`.
- Download filename prefix: `travel_recording`.
- Tracking JSON slug: `travel-tourism`.

## Testing

Playwright is installed and configured.

Run:

```bash
npm test
```

Latest known result after moving travel details inline:

```text
5 passed
```

Additional syntax checks used during development:

```bash
node --check experiments/site.js
node --check experiments/tracker.js
node --check tests/experiment-sites.spec.js
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' index.html | node --check -
```

## Development Notes

- Keep behavior tracking gated by sensing state. Do not track user behavior while sensing is inactive.
- Keep Stop as the only user action that triggers behavior-data download in the experiment sites.
- Do not re-add manual download tracking buttons unless explicitly requested.
- The shopping and travel sites share `experiments/site.js`; prefer data attributes and scoped CSS over duplicating logic.
- Travel-specific visual styling should remain scoped under `body.travel-site`.
- Travel trip details should stay inline inside the corresponding trip item.
- Avoid adding image-heavy or visually distracting content to dummy sites unless the task explicitly changes direction.
- Browser microphone APIs require a secure context, but `localhost` is allowed by modern browsers.
- Avoid committing generated recordings, spectrograms, large datasets, or model artifacts unless intentionally part of the project.
