# WebAgent Realtime Sensing Local Deployment

This guide shows how to run the ultrasound realtime sensing website locally.
The site loops a stereo ultrasonic chirp, captures mono microphone audio, streams
raw microphone frames to Python for live IQ processing, tracks page interactions
during sensing, and prepares session files for an explicit user-initiated download.

Run the commands below from the cloned repository directory:

```bash
cd /path/to/webagent
```

On Windows, use the corresponding path, such as `cd C:\path\to\webagent`.

## 1. Create A Minimal Conda Environment

Create a small Python environment for the realtime sensing backend:

```bash
conda create -n webagent-realtime python=3.12 -y
conda activate webagent-realtime
```

## 2. Install Python Dependencies

Install all required packages:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## 3. Run The Realtime Deployment

Start the local realtime sensing website:

```bash
python realtime.py
```

`realtime.py` is a small local launcher for `server.py`; running
`python server.py` starts the same application directly.

Then open:

```text
http://localhost:8000/
```

Experiment pages:

```text
http://localhost:8000/experiments/
http://localhost:8000/experiments/travel/
```

The local server provides both the website and the realtime Python IQ WebSocket endpoint:

```text
ws://localhost:8000/realtime
```

## Optional: Use Another Local Port

In Windows Anaconda Prompt:

```bash
set PORT=8124
python realtime.py
```

On macOS, Linux, or WSL:

```bash
PORT=8124 python realtime.py
```

Then open:

```text
http://localhost:8124/
```

## Notes

- Click **Start sensing** to play the ultrasound chirp, capture microphone audio, and stream live mic frames to Python. The same button changes to **Stop sensing** while sensing is active.
- Every sensing session stops automatically after 40 seconds. Captured PCM is
  also capped by sample count, so an exported WAV cannot exceed 40 seconds.
- Stopping sensing automatically downloads the Python-style
  `keyboard_events.json`, `cursor_events.json`, and `metadata.json` files
  together with the received-audio WAV, spectrogram, and available processed
  figures. `metadata.json` follows the
  standalone Python recorder's field names and includes the signal parameters,
  actual duration, recording name, capture method, browser-visible OS
  information, and event counts.
- While sensing is active, `keyboard_events.json` records key down/up events,
  dwell time, and keydown-to-keydown flight time. `cursor_events.json` records
  pointer movement, click press/release, and wheel/touchpad scrolling. All `t`
  values are seconds relative to sensing start.
- The completed WAV, internal diagnostics, and an internal compatibility event stream are also sent to the local
  `/api/analyze-recording` endpoint for post-processing. This backend upload is
  separate from the automatic browser downloads; neither the internal diagnostics
  nor the compatibility stream is included in downloaded session files.
- After Stop, Python produces the same Stage-4 amplitude-change and phase-change
  line charts as `extract_feature_maps_demo.py`, with time-aligned key,
  pointer-move, scroll, and click markers. When a compatible MLP model is
  available, it predicts overlapping 0.5-second windows and displays their
  labels and confidence.
- This checkout does not currently contain `models/`. Train or provide
  `models/signal_event_model_audible_only.joblib` to enable the Stop-time Python
  prediction timeline and table. The Stage-4 figures do not require the model.
- The main page, shopping experiment, and travel experiment all use the same realtime `/realtime` backend.
- Shopping and travel expose the same `window.webAgentSensing` function surface
  as the main page; `window.experimentSensing` remains an alias on those pages.
- Use `Ctrl+C` in the terminal to stop the local server.
- For browser microphone access, `localhost` is the recommended local URL.

## Recording Path And Profiles

The sensing path does not use `MediaRecorder` or an encoded browser format. It
uses the following raw-PCM flow on the main and experiment pages:

```text
getUserMedia microphone track
  -> 48 kHz Web Audio MediaStreamAudioSourceNode
  -> AudioWorklet (2048-sample mono Float32 frames)
  -> in-memory WAV buffer + WAIQ WebSocket frames
  -> Python /realtime IQ processor
```

The worklet output is connected through a zero-gain node only to keep the Web
Audio graph active; microphone input is never monitored to the speaker. WAV
export remains mono 32-bit IEEE-float PCM. Chirp playback is scheduled 50 ms
ahead on the same AudioContext timeline after capture is ready. The browser also
collects clipping, worklet sequence gaps, WebSocket backpressure drops, actual
track settings, and capture-method diagnostics for the local analysis request;
this detailed diagnostics object is not a user download.

Use the **Recording profile** selector before sensing:

- **Ultrasound (strict)** is the default. It requires browser controls for echo
  cancellation, noise suppression, and automatic gain control; requests each
  as `{ exact: false }`; disables voice isolation when exposed; sets the track
  content hint to `music`; confirms the reported settings; requires a 48 kHz
  `AudioContext`; and requires `AudioWorklet` capture.
- **Compatibility** requests the same settings as preferences, reports anything
  the browser cannot confirm, permits a non-48-kHz context with a warning, and
  permits the deprecated `ScriptProcessorNode` only when AudioWorklet cannot be
  started.

The selected profile is shared across pages through
`localStorage.webagentRecordingProfile`. Browser settings cannot prove that the
operating system, driver, or audio hardware performs no additional processing,
so use the recorded spectrum to qualify each device.

## Realtime Stage-4 Feature Lines

The realtime backend follows `ultrasonic_feature_maps.py`, which mirrors the
latest `extract_feature_maps_demo.py`. It splits the microphone signal into
`18.8-20.7 kHz` and `21.3-23.2 kHz` bands, aligns the repeated 12 ms chirps, and
calculates normalized complex matched-filter values over lag bins `0-280`.
Consecutive chirps produce left/right amplitude-change and absolute wrapped
phase-change maps.

For each feature and channel, the live chart selects the 10 lag bins with the
largest temporal standard deviation, averages those bins, and divides the
resulting trace by its full-trace median. It displays two panels: amplitude
change and phase change, with separate blue left-channel and orange
right-channel lines. The selection and median update from the accumulated live
session; the completed recording is recalculated offline using the full trace.
Realtime filtering is causal, while completed-recording processing uses the
reference script's zero-phase filter.

## Realtime Micro-Doppler

The same realtime processor retains the complex matched-filter maps needed for
micro-Doppler processing. It follows the supplied `doppler.py` configuration:

- 12 motion-sensitive lag bins per ultrasonic band
- 64-chirp Hann window (`0.768 s`)
- 8-chirp hop (`0.096 s`, approximately `10.4 Hz` updates)
- 256-point slow-time FFT
- fixed `-30 dB` to `0 dB` relative-power color scale

The website displays this output in a separate **Live Micro-Doppler** panel with
stacked left-band and right-band heatmaps. Time is horizontal, Doppler frequency
is vertical, and Turbo color represents relative motion power. Event markers
and the beginning/end still regions share the same 40-second timeline as the
raw audio and Stage-4 lines.

The sample script selects bins and removes clutter using the complete
recording. Realtime mode instead maintains exact accumulated statistics up to
the current chirp and subtracts the accumulated complex mean from the trailing
64-chirp window. Consequently, the first Doppler column appears about `3.8 s`
after sensing starts with the existing 3-second trim, and its window-center
timestamp has `0.384 s` latency. This Doppler visualization is realtime-only;
the Stop-time Doppler velocity PNG is not generated.

`SharedArrayBuffer`, a browser DSP worker, and ONNX Runtime Web are not part of
the current path: live IQ and model processing run in the Python backend. Those
changes require cross-origin isolation and a browser-deployable model and should
be treated as a separate inference migration rather than a recording fallback.

## Train The Signal Event Model

After preparing labeled recording sessions under `data/`, select one of the
three feature sets. The current website no longer includes manual label buttons;
training therefore expects labels to come from the existing dataset layout and
its event logs.

```bash
python scripts/train_signal_event_model.py --feature-set ultrasound --model-out models/signal_event_model_ultrasound_only.joblib --report-out models/signal_event_report_ultrasound_only.json --manifest-out models/window_manifest_ultrasound_only.csv
python scripts/train_signal_event_model.py --feature-set audible --model-out models/signal_event_model_audible_only.joblib --report-out models/signal_event_report_audible_only.json --manifest-out models/window_manifest_audible_only.csv
python scripts/train_signal_event_model.py --feature-set combined --model-out models/signal_event_model_combined.joblib --report-out models/signal_event_report_combined.json --manifest-out models/window_manifest_combined.csv
```

The training script crops the first and last `1.0` seconds, builds `0.5` second
windows with `0.25` second stride, and splits by recording session. The
`ultrasound` feature set uses pooled cross-correlation amplitude and
phase-change maps. The `audible` feature set uses a pooled log spectrogram from
`50 Hz` to `18 kHz`, excluding the sensing chirp. The `combined` feature set
concatenates both representations.

The current sensing asset uses a phase-continuous `12 ms` stereo dual-band
chirp (`19.0-20.5 kHz` on the left channel and `21.5-23.0 kHz` on the right).
Ultrasound-only and combined checkpoints trained with the previous `20 ms`
mono chirp are not signal-compatible and must be retrained before prediction.
The audible-only checkpoints can still be loaded, but should be revalidated on
recordings collected with the new playback signal.

The explicit output paths prevent one feature-set run from overwriting another.
The audible-only path above is also the default model location expected by the
Stop-time web analysis pipeline.

To train binary interaction models, use `--label-scheme interaction`. This
keeps the original seven-class label in each manifest and adds a coarse target:
`body_motion`, `hand_wave`, and `no_event` become `no_interaction`; `click_tap`,
`keydown`, `pointer_move`, and `scroll` become `interaction`. For example:

```bash
python scripts/train_signal_event_model.py --feature-set audible --label-scheme interaction --model-out models/signal_interaction_model_audible_only.joblib --report-out models/signal_interaction_report_audible_only.json --manifest-out models/window_manifest_interaction_audible_only.csv
python scripts/train_signal_event_model.py --feature-set ultrasound --label-scheme interaction --model-out models/signal_interaction_model_ultrasound_only.joblib --report-out models/signal_interaction_report_ultrasound_only.json --manifest-out models/window_manifest_interaction_ultrasound_only.csv
python scripts/train_signal_event_model.py --feature-set combined --label-scheme interaction --model-out models/signal_interaction_model_combined.joblib --report-out models/signal_interaction_report_combined.json --manifest-out models/window_manifest_interaction_combined.csv
```

Generate full train/evaluation curves with:

```bash
python scripts/plot_training_curves.py --feature-set ultrasound --history-out models/training_curves_ultrasound_only.csv --plot-out models/training_curves_ultrasound_only.png
python scripts/plot_training_curves.py --feature-set audible --history-out models/training_curves_audible_only.csv --plot-out models/training_curves_audible_only.png
python scripts/plot_training_curves.py --feature-set combined --history-out models/training_curves_combined.csv --plot-out models/training_curves_combined.png
python scripts/plot_feature_set_comparison.py
```

Run prediction on a new sensed WAV recording with:

```bash
python scripts/predict_signal_event.py path/to/recording.wav --model models/signal_event_model_audible_only.joblib --out models/predictions.csv
```

### CNN models

PyTorch is included in `requirements.txt`. Train all three 2D CNN variants with
the same windows and recording-level split:

```bash
python -m pip install -r requirements.txt
python scripts/train_signal_event_cnn.py
```

This preserves the MLP artifacts and writes separate
`models/signal_event_cnn_*.pt` checkpoints, per-model reports and curves, plus
`models/training_curves_cnn_comparison.png`. The combined CNN uses independent
ultrasound and audible convolution branches followed by late fusion.

Run a saved CNN on a recording:

```bash
python scripts/predict_signal_event_cnn.py path/to/recording.wav --model models/signal_event_cnn_audible_only.pt --out models/cnn_predictions.csv
```

## Test The Website

Install the JavaScript test dependency and Playwright's Chromium runtime:

```bash
npm install
npx playwright install chromium
npm test
```

The tests use a local static test server and a fake browser microphone. Python
model inference is mocked where needed, so the browser tests do not require a
trained `models/` artifact.

To use an already-installed Chromium-compatible browser instead of Playwright's
downloaded runtime, set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable
before running `npm test`.

## Generated Data

The Python analysis endpoint stores server-side session inputs and generated
outputs under `uploads/`. These files are local runtime data and are separate
from the automatic browser downloads after Stop. Avoid
committing new recordings or generated model outputs unless they are deliberate
fixtures.
