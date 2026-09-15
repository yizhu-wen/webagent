# Website and Data Collection Project

This standalone project contains the instrumented FP-Agent task website and the
automation used to run browsing agents against it. Classifier training and
analysis are intentionally outside this project.

## Included components

- `honey_website/`: the complete website, tracking JavaScript, HTTP server,
  PostgreSQL utilities, and SQLite local-development launcher. The browser side
  of ultrasound sensing lives in `static_sites/honey_site/sensing/`.
- `ultrasound/`: the ultrasound backend — the transmitted chirp, the HTTP and
  WebSocket request handlers the website mixes in, realtime IQ processing, and
  offline analysis and training scripts.
- `data_collection/`: experiment runners, prompts, example configuration, and
  desktop/browser automation.
- `tests/`: Playwright tests covering the sensing integration.
- `scripts/`: convenience commands for local setup and execution.

The website includes four interactive task types: forums, flight booking,
shopping, and sorting. It records browser fingerprints and interaction events
such as mouse movement, clicks, scrolling, keyboard events, and form changes,
and can record synchronised ultrasound audio alongside them.

## Run the website locally

From PowerShell at the project root:

```powershell
.\scripts\start-local-site.ps1
```

Open <http://localhost:34567/LOCALDEV01/>. The local server writes collected
requests to `honey_website/honey_local.sqlite3`. Press Ctrl+C to stop it.

To use another port:

```powershell
.\scripts\start-local-site.ps1 -Port 8000
```

## Ultrasound sensing

The sensing panel is mounted into the site shell rather than into the page
content, so it stays active while a task is completed and survives navigation
between the four task types. It shows a heading and two buttons — **Start
sensing** and **Download last session** — and nothing else.

The panel is not shown on the landing page, only on the task pages. The one
exception is a session that is already running: it stays on screen wherever the
task navigates, including back to the landing page, so that recording can
always be stopped and the archive collected.

`index.html` loads `sensing/sensing.css` and `sensing/sensing.js`, and
`honey_website/server.py` mixes the backend endpoints into the site's request
handler via `SensingRequestMixin` from `ultrasound/http_sensing.py`. Both the
production and local servers therefore serve the website and the sensing
endpoints on a single port.

Press **Start sensing** to grant microphone access, loop the generated
dual-band chirp, and record. A session stops automatically after 40 seconds, or
when the button is pressed again. On stop the browser prepares a ZIP archive
named `ultrasound_<version>_<timestamp>.zip` and downloads it. The archive
contains the recorded WAV, a rendered spectrogram, the captured live IQ and
left/right micro-Doppler figures, the keyboard and cursor event logs, and a
`metadata.json` that records the chirp and band configuration and ties the
audio to the interaction timeline through
`sensing_session_id`, the audio and event start epochs, and the task pages
visited during the session.

### Recording profile and status

The recording settings and the live charts are kept out of the interface, so
the profile is chosen through the `webagentRecordingProfile` key in
`localStorage` instead of a picker:

```js
localStorage.setItem("webagentRecordingProfile", "compatible"); // or "ultrasonic"
```

It defaults to **`ultrasonic`**, which pins echo cancellation, noise
suppression, and automatic gain control off, because that processing destroys
the 19-24 kHz band. **`compatible`** only prefers them off, so a microphone can
still be opened on browsers that reject the exact constraints; sensing also
falls back to it by itself when the strict profile cannot start.

The status lines are still in the page, positioned off-screen. They remain
`role="status"` live regions, so a screen reader announces microphone and export
problems, but a sighted user sees no message if the microphone is refused —
read `#micStatus` and `#fileStatus`, or `window.webAgentSensing`, when
diagnosing a failed session. The charts still render to their hidden canvases,
which is where the exported figures come from.

Endpoints added to the website server:

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness check |
| `POST /api/send-wav` | Serves the transmitted chirp WAV |
| `POST /api/upload-recording` | Stores a recorded session |
| `POST /api/analyze-recording` | Runs offline analysis on an upload |
| `GET /sensing-uploads/<path>` | Serves a stored artifact |
| `GET /realtime` | WebSocket for live IQ and micro-Doppler |

Recordings are written to `ultrasound/uploads/`, which Git ignores. Set
`SENSING_UPLOAD_DIR` to store them elsewhere.

The website and the export path need no Python packages beyond the standard
library. The live IQ WebSocket, `/api/analyze-recording`, and everything in
`ultrasound/scripts/` need the DSP stack:

```powershell
python -m pip install -r ultrasound\requirements.txt
```

Without those packages the site, recording, and archive export still work; the
live Python IQ chart and server-side analysis report an error instead.

## Deployment

Ultrasound sensing needs a **secure context**: browsers grant microphone access
only over HTTPS or on `localhost`. That single constraint decides how to deploy.

### Agents on this machine — no tunnel needed

`http://localhost:34567/` already counts as a secure context, so recording works
with no TLS at all. Start the site and point the runners at it:

```powershell
.\scripts\start-local-site.ps1
```

Set `WEBSITE_BASE_URL=http://localhost:34567` for Browser Use and Skyvern. This
is the simplest deployment and the one to prefer whenever the browser runs on
the same machine as the server. A plain `http://<lan-ip>:34567` address is *not*
a secure context, so the sensing panel cannot open a microphone there.

### Browsers on other machines — HTTPS tunnel

```powershell
.\scripts\start-public-site.ps1
```

The script starts the site in public mode, puts a Cloudflare quick tunnel in
front of it, and prints the public task URL. It needs `cloudflared`:

```powershell
winget install --id Cloudflare.cloudflared
```

The quick-tunnel hostname is new on every run, so re-read the printed URL each
time rather than saving it. Cloudflare's edge was reachable from the development
network on 2026-09-08; the free SSH tunnel providers `lhr.life` and
`serveo.net` were not, so prefer `cloudflared` unless the SSH route is known to
work on your network.

### Public mode

`SENSING_PUBLIC_MODE=1` — which `start-public-site.ps1` sets for you — refuses
`/api/upload-recording` and `/api/analyze-recording`. Those write uploads to
disk and analysis additionally runs a subprocess over them, which should not be
reachable from the public internet. The browser still exports every session's
complete ZIP archive, so nothing is lost; the page ignores the refusal.

`honey_website/robots.txt` disallows all crawlers, because crawler traffic would
otherwise be logged as interaction data.

### Production server

`honey_website/server.py` is the PostgreSQL-backed server intended for Heroku.
Before it can serve a request it needs:

- `DATABASE_URL`, or startup fails in `db_pool.init_pool`
- `GeoLite2-City.mmdb` and `GeoLite2-ASN.mmdb` in `honey_website/util/`, which
  require a MaxMind licence. `Request()` opens both on **every** logged request,
  so the site returns errors for all traffic while they are missing.
- a working directory of `honey_website/`, since those database paths are
  relative

Install only `honey_website`'s own dependencies there. The DSP stack in
`ultrasound/requirements.txt` includes Torch and is not needed to serve the site
or export recordings. Note also that recordings written to `ultrasound/uploads/`
do not survive a restart on an ephemeral filesystem.

## Browser tests

The Playwright suite starts `honey_website/local_server.py` itself and drives a
real recording session with a fake microphone, checking that the panel mounts,
that the sensing assets and chirp are served correctly, and that a stopped
session exports a valid WAV, spectrogram, and metadata.

```powershell
npm install
npx playwright install chromium
npm test
```

To use an installed Chrome or Edge instead of Playwright's bundled browser, set
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its executable. The suite runs on port
34568 and writes uploads under `test-results/`, so it leaves a development
server and the collected recordings untouched.

## Prepare data collection

The full automation stack uses Python 3.13, `uv`, and, for Skyvern, Docker.
Install dependencies with:

```powershell
.\scripts\setup-data-collection.ps1
```

Copy `data_collection/.env.example` to `data_collection/.env` and fill in the
values required by the runner you intend to use. On Windows, also copy
`data_collection/app_paths.example.json` to `data_collection/app_paths.json`
and set the local application paths.

`WEBSITE_BASE_URL=http://localhost:34567` lets Browser Use and Skyvern target
the included local server. Atlas, Chrome, and Comet runners send start signals
to the site but then poll PostgreSQL for completion, so those runners require
the production database configuration.

The supplied experiment configuration contains placeholders. Copy
`data_collection/experiments/example_config.yaml`, then set its website version,
domain, runner, prompt, and output path.

Run an experiment from the project root:

```powershell
.\scripts\run-experiment.ps1 -Config experiments/example_config.yaml
```

The config path is relative to `data_collection/`. Results are written to the
path specified by each experiment's `save_path`.

## Production website server

`honey_website/server.py` uses PostgreSQL and MaxMind GeoLite2 databases. See
`honey_website/README.md` for the database schema and required environment
variables. For local development, prefer `local_server.py`; it replaces those
services with SQLite.

## Data boundaries

Generated databases, result files, credentials, environment files, and local
application paths are ignored by Git. The copied project does not contain the
source project's populated SQLite database.
