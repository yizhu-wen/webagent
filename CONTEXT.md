# Project Context

## Overview

This project is a browser-based sensing and behavior-tracking prototype. The
root page plays a looping ultrasound chirp, records microphone audio while
sensing is active, tracks user behavior only during active sensing, renders a
recorded spectrogram, and prepares session artifacts after sensing stops. Files
are downloaded automatically after Stop finishes preparing them.

There are also dummy experiment websites for collecting interaction behavior in simple task contexts:

- E-commerce and Shopping: `experiments/index.html`
- Travel and Tourism: `experiments/travel/index.html`

The current design goal is intentionally simple and functional, with minimal visual distraction.

## Primary Files

- `index.html`: Main sensing page. Contains UI, microphone capture, chirp playback, event tracking, WAV export, and spectrogram rendering.
- `recording-profile.js`: Shared strict/compatibility microphone profiles,
  supported-constraint construction, track qualification, and AudioContext
  sample-rate qualification.
- `server.py`: Lightweight Python HTTP server for local static serving and legacy audio endpoints.
- `analyze_webagent_recording.py`: Stop-time feature visualization and MLP
  inference pipeline used by `/api/analyze-recording`.
- `realtime_iq.py`: Streaming chirp alignment and live IQ feature extraction.
- `ultrasonic_feature_maps.py`: Shared reference-format matched-filter maps,
  top-10 variable-bin selection, mean aggregation, and median normalization.
- `tx_dual_triangle_chirp_19_205_215_23.wav`: Phase-continuous stereo sensing asset. The left channel sweeps 19.0-20.5 kHz and the right channel sweeps 21.5-23.0 kHz with a 12 ms period.
- `experiments/index.html`: Simple shopping dummy website.
- `experiments/travel/index.html`: Simple travel and tourism dummy website.
- `experiments/site.js`: Shared experiment-site behavior for sensing,
  microphone recording, spectrogram generation, product filtering/actions,
  forms, and automatic Stop-time session downloads.
- `experiments/tracker.js`: Shared gated client-side interaction tracker for experiment sites.
- `experiments/styles.css`: Shared experiment styles plus travel-specific scoped styles.
- `tests/*.spec.js`: Playwright tests for tracking, sensing controls, shopping, and travel.
- `scripts/train_signal_event_model.py`: MLP training for ultrasound, audible,
  and combined feature sets.
- `scripts/train_signal_event_cnn.py`: CNN training with modality-specific
  branches and late fusion.
- `scripts/predict_signal_event.py`, `scripts/predict_signal_event_cnn.py`:
  offline prediction helpers.
- `models/signal_event_model_audible_only.joblib`: Expected default path for
  the optional Stop-time MLP. The current checkout does not include `models/`;
  this artifact must be trained or supplied separately.
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

The requirements file installs the packages needed by the real-time IQ backend,
model training, and server-generated analysis figures: NumPy, SciPy, SoundFile,
Matplotlib, scikit-learn, Joblib, and PyTorch.

`python server.py` starts the website on `http://localhost:8000/` and serves the
real-time IQ WebSocket endpoint on the same public port at
`ws://localhost:8000/realtime`. On Render, the browser automatically uses
`wss://<your-service>.onrender.com/realtime`. Click `Start sensing` to stream
Float32 microphone frames to Python and update the live Stage-4 feature lines.
The same control changes to `Stop sensing` while sensing is active.
For manual debugging, `python realtime_server.py` can still run the older
standalone WebSocket backend by itself.

`python realtime.py` is an equivalent convenience launcher that calls
`server.py`'s `main()` function.

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
- Defaults to the `Ultrasound (strict)` recording profile. The selectable
  `Compatibility` profile preserves operation on browsers that cannot verify
  disabled speech processing or start an AudioWorklet.
- Loads `tx_dual_triangle_chirp_19_205_215_23.wav`, a 30-second phase-continuous stereo dual-band chirp asset with a 12 ms period.
- Start sensing decodes the chirp and schedules its loop 50 ms ahead on the same
  48 kHz Web Audio timeline used by microphone capture.
- Start sensing streams microphone frames to the same-origin `/realtime`
  WebSocket endpoint and updates the live Stage-4 amplitude/phase lines.
- Live IQ feature timestamps come from the processed audio sample index and the
  center of each 12 ms chirp window after chirp-boundary alignment, not from the
  time Python finishes calculating the feature.
- Live IQ uses latest-only transport: browser audio frames include timestamp and
  sequence metadata, the browser drops frames when the WebSocket send buffer is
  backed up, and Python drops stale queued frames before realigning on fresh
  audio. This keeps the chart current on low-CPU deployments.
- Stop sensing stops playback and recording.
- Behavioral data is tracked only while sensing is active.
- Stop prepares `keyboard_events.json`, `cursor_events.json`, `metadata.json`,
  the sensed microphone WAV, rendered spectrogram PNG, and standalone left/right
  live Micro-Doppler PNGs in browser memory.
- Stop automatically downloads all prepared session files. There is no separate
  session-download button.
- Stop uploads the recorded WAV, OS-style event log, and internal diagnostics to the
  local Python backend for offline processing. The page later displays exact
  Stage-4 amplitude/phase lines and an MLP prediction timeline when the required
  artifact is available. This backend upload is independent of the automatic
  browser downloads.
- When supplied, the default audible-only MLP predicts every overlapping `0.5`
  second signal window with a `0.25` second stride after Stop. The first and
  final `1.0` second are excluded. A scrollable table shows every window's
  start, end, predicted label, and confidence.
- Full per-class probabilities for every window are saved as
  `window_predictions.json`.
- Strict microphone capture requires browser controls for echo cancellation,
  noise suppression, and automatic gain control, requests each as
  `{ exact: false }`, disables voice isolation when exposed, applies the
  `music` content hint, and rejects capture when the resulting track settings
  do not confirm processing is off. Compatibility mode treats these as
  preferences and reports warnings instead.
- All pages prefer `AudioWorklet` capture. The main page and both experiment
  pages receive 2048-sample mono Float32 frames through a transferable
  `ArrayBuffer`; only Compatibility mode may fall back to the deprecated
  `ScriptProcessorNode`. A zero-gain node keeps the capture graph active without
  monitoring microphone input to the speaker.
- Captured float samples are buffered for mono 32-bit IEEE-float WAV export and
  are simultaneously packaged into the 20-byte `WAIQ` header plus Float32 PCM
  payload for the `/realtime` WebSocket.
- The internal diagnostics object records requested microphone constraints, browser-reported
  `MediaStreamTrack` settings/capabilities/constraints, `AudioContext` sample
  rate/latency and qualification, selected recording profile, actual capture
  method, clipping count/peak, worklet sequence gaps, WebSocket backpressure
  drops, playback buffer rate, exported WAV format, and an empirical
  autocorrelation check around the expected 12 ms / 576-sample chirp period.
- The spectrogram renderer includes axes and uses the same visual generation style expected by the tests.
- The main page links to both dummy experiment sites.

## Real-Time Python IQ

Real-time mode is implemented by:

- `audio-frame-worklet.js`: browser `AudioWorkletProcessor` that downmixes mic
  input and emits fixed-size Float32 frames with frame sequence and Web Audio
  start-frame metadata.
- `server.py`: HTTP static/API server plus the public `/realtime` WebSocket
  endpoint used locally and on Render.
- `realtime_server.py`: older standalone local WebSocket server at
  `ws://127.0.0.1:8765`, kept for manual debugging.
- `realtime_iq.py`: streaming IQ processor that performs causal bandpass,
  independent left/right chirp alignment, normalized matched filtering over
  lags `0-280`, and consecutive-chirp amplitude/phase change extraction. It
  discards the first 3 seconds like the batch reference. To limit WebSocket
  traffic, it retains the latest unmodified feature column from each four-chirp
  group, for an approximately `20.8 Hz` update rate.

The backend sends the four 281-bin change columns, not matplotlib images. For
each feature/channel, the browser applies the latest reference fallback:
select the 10 bins with the largest standard deviation over the accumulated
session, average them, and divide the trace by its median. The live canvas shows
raw microphone audio plus two Stage-4-style line panels. Each feature panel
contains a blue left-channel trace and orange right-channel trace. Completed
recordings use zero-phase filtering and the full unsampled feature map, so those
offline Stage-4 figures are the exact reference result; realtime uses causal
filtering and transport downsampling because future samples are unavailable.

The processor also emits `doppler` messages for a separate realtime
micro-Doppler panel. It maintains accumulated top-12 motion-bin statistics for
each band, removes the accumulated complex mean as causal MTI clutter
suppression, and applies a 64-chirp Hann window with an 8-chirp hop and
256-point slow-time FFT. Messages contain the shared Doppler-frequency axis and
left/right `-30..0 dB` power columns. This gives approximately `10.4 Hz`
updates, a `0.768 s` analysis window, and `0.384 s` window-center latency after
the existing 3-second trim. The browser renders separate stacked left and right
Turbo heatmaps on the same fixed 40-second time axis and overlays tracked event
markers and still regions.

The architecture review's `SharedArrayBuffer`, dedicated browser DSP worker,
and ONNX Runtime Web path is intentionally deferred. The current application
performs DSP and inference in Python over WebSocket, is not configured for
cross-origin isolation, and does not contain a browser-ready ONNX model. Moving
inference into the browser is a separate migration; it is not required for the
raw-PCM recording improvements above.

## Experiment Site Behavior

Both shopping and travel:

- Request microphone permission first.
- Expose the same `window.webAgentSensing` function surface as the main page,
  with `window.experimentSensing` retained as an alias.
- Expose the same strict and compatibility recording profiles as the main page.
- Have a single sensing toggle button that starts as `Start sensing` and changes
  to `Stop sensing` while sensing is active.
- Do not include manual data-collection label or marker controls.
- Track behavior only while sensing is active.
- Reset tracking data at the start of each sensing session.
- Stop sensing automatically after 40 seconds and cap captured PCM at 40
  seconds of frames, including when browser timers run late.
- Decode and loop the chirp through the 48 kHz Web Audio context.
- Prefer AudioWorklet mono Float32 capture and export mono 32-bit IEEE-float WAV;
  permit ScriptProcessor only in Compatibility mode.
- On Stop, prepare and automatically download:
  - `keyboard_events.json`
  - `cursor_events.json`
  - `metadata.json`, containing only `fs`, `chirp_samples`, `left_band_hz`,
    `right_band_hz`, `tx_amplitude`, `duration_sec`, `recording_name`, `capture`,
    `os`, `n_key_events`, and `n_cursor_events`
  - Sensed microphone audio WAV
  - Recorded spectrogram PNG
  - Standalone left/right live Micro-Doppler PNGs with axes, event markers,
    still regions, and the shared color scale
  - Stage-4 amplitude/phase and optional MLP prediction figures when the Python
    server endpoint is available
- Show the recorded spectrogram on the page after Stop.
- Show every MLP prediction window in a time-aligned table after Stop.
- Use the shared spectrogram generation code in `experiments/site.js`, including axes.
- Show the shared separate Live Micro-Doppler panel with left/right stacked
  heatmaps driven by the same `/realtime` WebSocket.

## Figure Generation

The Stop-time Python pipeline always generates these model-independent figures:

- `stage4_signal_events_amplitude_change.png`: median-normalized left/right
  amplitude-change lines from each channel's 10 most-variable lag bins, with
  time-aligned key, pointer-move, scroll, and click markers.
- `stage4_signal_events_phase_change.png`: median-normalized left/right wrapped
  phase-change lines from each channel's 10 most-variable lag bins, with the
  same action markers.
When `models/signal_event_model_audible_only.joblib` is available, it also
generates:

- `06_mlp_prediction_timeline.png`: audible-only MLP label and confidence for
  every overlapping `0.5` second analysis window.

The analysis also writes:

- `pipeline_features.npz`: reusable correlation arrays, all four 281-bin change
  maps, normalized Stage-4 traces, selected lag bins, channel medians, and time
  axes.
- `window_predictions.json`: one record per window with start/end/center time,
  predicted label, confidence, and every class probability.
- `analysis_summary.json`: processing configuration and session summary.

Positive and negative Doppler velocity indicate opposite radial directions.
The sign is not called toward/away until the phase convention is calibrated for
the specific speaker/microphone geometry.

Use these inputs:

- Recorded microphone WAV from Stop sensing.
- OS-style event log from the same Stop sensing session.
- Internal recording diagnostics, optional but uploaded when available and not
  included in the browser download list.

Start the Python backend with:

```text
python server.py
```

The endpoint `/api/analyze-recording` saves each uploaded sensing session under
`uploads/`, runs `analyze_webagent_recording.py`, and returns figure URLs,
descriptions, the reusable feature archive, and all per-window predictions. A
plain static server can still capture and explicitly download the browser
artifacts, but cannot run Python feature extraction or model inference. If the
default MLP file is missing, analysis still returns the model-independent
figures and archive but omits predictions.

## Tracked User Events

The behavioral tracker follows the standalone Python recorder's two-file
schema while sensing is active. Export preparation does not add synthetic
events.

`keyboard_events.json` is a JSON array. Keydown records use:

```json
{"event":"down","key":"a","t":1.25,"flight_sec":0.18}
```

Keyup records use:

```json
{"event":"up","key":"a","t":1.31,"dwell_sec":0.06}
```

Auto-repeat keydowns are ignored. The first keydown has `flight_sec: null`, and
an unmatched keyup has `dwell_sec: null`.

`cursor_events.json` is a JSON array containing exactly these record shapes:

```json
{"type":"move","x":180,"y":120,"t":1.25}
{"type":"click","x":180,"y":120,"button":"Button.left","pressed":true,"t":1.30}
{"type":"click","x":180,"y":120,"button":"Button.left","pressed":false,"t":1.36}
{"type":"scroll","x":180,"y":120,"dx":0,"dy":-640,"t":1.42}
```

All `t` values are seconds relative to sensing start. Pointer movement is not
throttled. Browser wheel events represent mouse-wheel and touchpad scrolling.
Browser APIs generally expose a touchpad as a mouse-like pointer, so they cannot
reliably label which physical device produced a move or click. Tracking remains
browser-page scoped; activity outside the page is not visible.

The legacy compatibility event stream remains internal for live chart markers
and the local analysis upload. It is not included in downloaded session files.

## Signal Event Models

Data processing rule: when extracting training windows, ignore or crop the first
`1.0` second after the start time and the final `1.0` second before the stop
time. This avoids contaminating the recording with start/stop-button or touchpad
events that often happen at the edges of a recording. The current model
uses `0.5` second detection windows with `0.25` second stride.

The signal-event dataset currently contains `2,767` overlapping windows:
`2,218` in the recording-session training split and `549` in the untouched
recording-session test split. All models use `0.5` second windows and `0.25`
second stride.

The reported model results below came from recordings made with the previous
20 ms mono chirp. Model artifacts are not checked into the current checkout.
Ultrasound-only and combined models must be retrained for the current 12 ms
stereo dual-band signal. An audible-only model can be supplied at the expected
path, but should be validated on newly collected recordings because the
playback signal changes the audible-noise distribution.

`scripts/train_signal_event_model.py` trains PCA + MLP models:

- Ultrasound only: pooled matched-filter log-amplitude and phase-change maps,
  `35.5%` test accuracy.
- Audible only: pooled `50 Hz` to `18 kHz` log spectrogram, `83.2%` test
  accuracy. This is the model deployed by the website.
- Audible + ultrasound: concatenated features, `76.3%` test accuracy.

`scripts/train_signal_event_cnn.py` trains regularized 2D CNN models with
modality-specific branches. The combined model uses late fusion:

- Ultrasound only CNN: `50.1%` test accuracy.
- Audible only CNN: `87.6%` test accuracy.
- Audible + ultrasound CNN: `86.9%` test accuracy.

CNN best-epoch selection uses a stratified validation subset of the training
windows. The `549` session-held-out test windows are not used for model
selection. Training curves, classification reports, confusion matrices, and
prediction helpers are stored under `models/` and `scripts/`.

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
- Add-to-cart, save, and checkout interactions populate only the Python-style keyboard and cursor event arrays.
- Download filename prefix: `shopping_recording`.

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
- Select trip, save, details, and booking interactions populate only the Python-style keyboard and cursor event arrays.
- Each trip has a `Details` button that expands details inline inside that same trip row, not in a shared bottom panel.
- Inline trip details show duration, route, included items, note, and price.
- Inline trip details include `Use this trip`, which adds that trip to the booking count and can prefill booking notes, plus `Close details`.
- Download filename prefix: `travel_recording`.

## Testing

Playwright is configured as a development dependency.

Run:

```bash
npm install
npx playwright install chromium
npm test
```

The browser tests use a fake microphone. Stop-time model results are mocked in
the visualization tests, so a trained `models/` directory is not required.

Additional syntax checks used during development:

```bash
node --check experiments/site.js
node --check experiments/tracker.js
node --check tests/experiment-sites.spec.js
awk '/<script>/{flag=1;next}/<\/script>/{flag=0}flag' index.html | node --check -
```

## Development Notes

- Keep behavior tracking gated by sensing state. Do not track user behavior while sensing is inactive.
- Keep Stop responsible for preparing and automatically downloading session
  files on the main and experiment pages.
- Do not re-add data-collection label or marker controls unless explicitly requested.
- The shopping and travel sites share `experiments/site.js`; prefer data attributes and scoped CSS over duplicating logic.
- Travel-specific visual styling should remain scoped under `body.travel-site`.
- Travel trip details should stay inline inside the corresponding trip item.
- Avoid adding image-heavy or visually distracting content to dummy sites unless the task explicitly changes direction.
- Browser microphone APIs require a secure context, but `localhost` is allowed by modern browsers.
- Do not commit `data/`, new `uploads/` sessions, spectrograms, or generated
  training outputs. If a deployment needs Stop-time inference, supply the
  audible-only MLP deliberately at
  `models/signal_event_model_audible_only.joblib` or through deployment storage.
