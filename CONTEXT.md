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
- `triangle_fmcw_20-24kHz_7ms_48kHz_10s.wav`: Ultrasound chirp file used for sensing playback.
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
python3 server.py
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

## Main Site Behavior

- Requests microphone permission on load.
- Loads `triangle_fmcw_20-24kHz_7ms_48kHz_10s.wav`.
- Start sensing loops the chirp audio.
- Stop sensing stops playback and recording.
- Behavioral data is tracked only while sensing is active.
- Stop automatically downloads the tracking JSON for that sensing period.
- Stop also downloads the sensed microphone audio WAV and rendered spectrogram PNG.
- The spectrogram renderer includes axes and uses the same visual generation style expected by the tests.
- The main page links to both dummy experiment sites.

## Experiment Site Behavior

Both shopping and travel:

- Request microphone permission first.
- Have Start sensing and Stop buttons.
- Track behavior only while sensing is active.
- Reset tracking data at the start of each sensing session.
- On Stop, automatically download:
  - Tracking JSON
  - Sensed microphone audio WAV
  - Recorded spectrogram PNG
- Show the recorded spectrogram on the page after Stop.
- Use the shared spectrogram generation code in `experiments/site.js`, including axes.

## Tracked User Events

The behavioral tracker records these seven user event types:

- `page_view`
- `click`
- `mousemove`
- `scroll`
- `keydown`
- `form_submit`
- `page_visibility_change`

The downloadable log may also include an internal download marker event such as `tracking_data_downloaded`.

Mousemove events include full-page trajectory fields such as `pageX`, `pageY`, `scrollX`, `scrollY`, `documentWidth`, and `documentHeight`.

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
- Add-to-cart, save, checkout form, scrolling, mouse movement, keydown, and form-submit actions are available for tracking.
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
- Select trip, save, details, booking form, scrolling, mouse movement, keydown, and form-submit actions are available for tracking.
- Download filename prefix: `travel_recording`.
- Tracking JSON slug: `travel-tourism`.

## Testing

Playwright is installed and configured.

Run:

```bash
npm test
```

Latest known result after adding and restyling the travel site:

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
- Avoid adding image-heavy or visually distracting content to dummy sites unless the task explicitly changes direction.
- Browser microphone APIs require a secure context, but `localhost` is allowed by modern browsers.
- Avoid committing generated recordings, spectrograms, large datasets, or model artifacts unless intentionally part of the project.
