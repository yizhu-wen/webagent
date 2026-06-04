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

- Click **Start sensing** to play the ultrasound chirp, capture microphone audio, and stream live mic frames to Python.
- The main page, shopping experiment, and travel experiment all use the same realtime `/realtime` backend.
- Use `Ctrl+C` in the terminal to stop the local server.
- For browser microphone access, `localhost` is the recommended local URL.
