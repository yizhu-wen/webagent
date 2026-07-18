# WebAgent Realtime Sensing Local Deployment

This guide shows how to run the ultrasound realtime sensing website on a local machine with a minimal Anaconda environment.

## 1. Open Anaconda Prompt

Open **Anaconda Prompt** on Windows, then go to the folder where you cloned this repository:

```bash
cd path\to\webagent
```

## 2. Create A Minimal Conda Environment

Create a small Python environment for the realtime sensing backend:

```bash
conda create -n webagent-realtime python=3.12 -y
conda activate webagent-realtime
```

## 3. Install Python Dependencies

The project includes `requirements.txt`:

```text
numpy
scipy
soundfile
matplotlib
scikit-learn
joblib
```

Install all required packages:

```bash
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
```

## 4. Run The Realtime Deployment

Start the local realtime sensing website:

```bash
python realtime.py
```

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

In Anaconda Prompt:

```bash
set PORT=8124
python realtime.py
```

Then open:

```text
http://localhost:8124/
```

## Notes

- Click **Start sensing** to play the ultrasound chirp, capture microphone audio, and stream live mic frames to Python. The same button changes to **Stop sensing** while sensing is active.
- After sensing stops, the local Python analysis pipeline calculates and displays
  two full-width feature views: a Doppler velocity-time map and derived
  motion/band-energy traces. It also runs the saved audible-only MLP on
  overlapping 0.5-second windows and displays its predicted event labels and
  confidence along the recording timeline. These figures are intentionally
  post-processed rather than real-time.
- The main page, shopping experiment, and travel experiment all use the same realtime `/realtime` backend.
- Use `Ctrl+C` in the terminal to stop the local server.
- For browser microphone access, `localhost` is the recommended local URL.

## Train The Signal Event Model

After collecting labeled recordings under `data/`, select one of the three
feature sets:

```bash
python scripts\train_signal_event_model.py --feature-set ultrasound
python scripts\train_signal_event_model.py --feature-set audible
python scripts\train_signal_event_model.py --feature-set combined
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

Use explicit `--model-out`, `--report-out`, and `--manifest-out` paths when
keeping multiple trained variants.

To train binary interaction models, use `--label-scheme interaction`. This
keeps the original seven-class label in each manifest and adds a coarse target:
`body_motion`, `hand_wave`, and `no_event` become `no_interaction`; `click_tap`,
`keydown`, `pointer_move`, and `scroll` become `interaction`. For example:

```bash
python scripts\train_signal_event_model.py --feature-set audible --label-scheme interaction --model-out models\signal_interaction_model_audible_only.joblib --report-out models\signal_interaction_report_audible_only.json --manifest-out models\window_manifest_interaction_audible_only.csv
python scripts\train_signal_event_model.py --feature-set ultrasound --label-scheme interaction --model-out models\signal_interaction_model_ultrasound_only.joblib --report-out models\signal_interaction_report_ultrasound_only.json --manifest-out models\window_manifest_interaction_ultrasound_only.csv
python scripts\train_signal_event_model.py --feature-set combined --label-scheme interaction --model-out models\signal_interaction_model_combined.joblib --report-out models\signal_interaction_report_combined.json --manifest-out models\window_manifest_interaction_combined.csv
```

Generate full train/evaluation curves with:

```bash
python scripts\plot_training_curves.py --feature-set audible
python scripts\plot_training_curves.py --feature-set combined
python scripts\plot_feature_set_comparison.py
```

Run prediction on a new sensed WAV recording with:

```bash
python scripts\predict_signal_event.py path\to\recording.wav --out models\predictions.csv
```

### CNN models

Install the PyTorch dependency and train all three 2D CNN variants with the
same windows and recording-level split:

```bash
python -m pip install -r requirements.txt
python scripts\train_signal_event_cnn.py
```

This preserves the MLP artifacts and writes separate
`models/signal_event_cnn_*.pt` checkpoints, per-model reports and curves, plus
`models/training_curves_cnn_comparison.png`. The combined CNN uses independent
ultrasound and audible convolution branches followed by late fusion.

Run a saved CNN on a recording:

```bash
python scripts\predict_signal_event_cnn.py path\to\recording.wav --model models\signal_event_cnn_audible_only.pt --out models\cnn_predictions.csv
```
