# Recorded-audio spectrogram demonstration and porting guide

## Copy-and-paste prompt for another coding agent

Use the following prompt when asking another coding agent to add this visualization to a different browser project:

> Add an offline recorded-audio spectrogram that matches the implementation documented below. Accept a recorded audio `Blob`, decode it with Web Audio, mix all input channels to mono, apply a Hann window, and calculate a radix-2 FFT for each frame. Use an FFT size of 1024 samples and a requested hop length of 256 samples (75% overlap). Render linear time and frequency axes on a horizontally scrollable canvas, map magnitude from -90 dB to -20 dB through the documented color function, and allow at most 8192 time columns. If the recording requires more than 8192 columns, increase the effective hop just enough to retain the whole recording. Keep the frequency-pixel mapping linear so it agrees with the axis. Show the effective FFT size and hop length next to the visualization. Export the completed canvas as a PNG. Do not compute a separate direct DFT for every output pixel; calculate one FFT per time frame and reuse its bins. Add tests or a deterministic demo using a known sine wave to verify frequency and time-axis placement. Preserve unrelated project behavior.

If the target project needs only the ultrasound band, add this sentence:

> Display 18-24 kHz instead of 0-Nyquist, and update both the bin mapping and y-axis labels to use the same 18-24 kHz range.

## Reference implementation in this project

The implementation exists in two places because the main page and experiment pages have separate browser scripts:

- `index.html`: main-page implementation (`SPECTROGRAM_CONFIG`, FFT helpers, axes, and `renderSpectrogram`)
- `experiments/site.js`: shared implementation for the shopping and travel experiment pages
- `experiments/styles.css`: horizontally scrollable experiment spectrogram styling

When changing the renderer in this repository, update both JavaScript implementations so their output remains consistent.

## Configuration

```js
const SPECTROGRAM_CONFIG = Object.freeze({
  fftSize: 1024,
  hopLength: 256,
  maxColumns: 8192,
  canvasHeight: 260,
  minDb: -90,
  maxDb: -20
});
```

At a 48 kHz recording sample rate, this means:

- FFT-bin spacing: `48000 / 1024 = 46.875 Hz`
- Analysis-window duration: `1024 / 48000 = 21.33 ms`
- Requested time step: `256 / 48000 = 5.33 ms`
- Window overlap: `1 - 256 / 1024 = 75%`

`hopLength` is the number of source samples between adjacent FFT frames. A smaller value improves time sampling and creates a wider image. It does not shorten the FFT window.

`maxColumns` prevents very long or high-sample-rate recordings from exceeding practical browser canvas dimensions. The renderer uses the requested 256-sample hop whenever the frame count fits. Otherwise, it calculates a larger effective hop so the entire recording still appears in at most 8192 columns. The status text reports the effective value.

## Processing pipeline

```text
recorded Blob
    -> AudioContext.decodeAudioData
    -> average input channels to mono
    -> split into overlapping 1024-sample frames
    -> apply Hann window
    -> calculate one radix-2 FFT per frame
    -> convert magnitudes to decibels
    -> map decibels to color
    -> draw time/frequency pixels and axes
    -> export canvas as PNG
```

The mono conversion should average channels rather than taking only the first channel:

```js
mono[sampleIndex] += channelData[sampleIndex] / channelCount;
```

The Hann window is:

```js
windowValues[index] =
  0.5 * (1 - Math.cos((2 * Math.PI * index) / (size - 1)));
```

The magnitude and color normalization are:

```js
const magnitude = Math.hypot(real[bin], imaginary[bin]) / fftSize;
const db = 20 * Math.log10(magnitude + 1e-6);
const normalizedMagnitude = Math.max(
  0,
  Math.min(1, (db - minDb) / (maxDb - minDb))
);
```

The current color function is:

```js
function getSpectrogramColor(value) {
  const clamped = Math.max(0, Math.min(1, value));
  const red = Math.round(255 * Math.pow(clamped, 0.72));
  const green = Math.round(255 * Math.pow(clamped, 1.55));
  const blue = Math.round(
    40 + 180 * (1 - clamped) * Math.pow(clamped, 0.35)
  );
  return [red, green, blue];
}
```

## Frame count and effective hop

Use the requested hop first:

```js
const availableStartSamples = Math.max(0, samples.length - fftSize);
const requestedFrameCount = Math.max(
  1,
  Math.floor(availableStartSamples / requestedHopLength) + 1
);
const plotWidth = Math.min(requestedFrameCount, maxColumns);
```

If the requested frame count is too wide, retain the full recording by increasing the effective hop:

```js
const hopLength = requestedFrameCount > maxColumns
  ? Math.max(
      1,
      Math.ceil(availableStartSamples / Math.max(1, plotWidth - 1))
    )
  : requestedHopLength;
```

Do not simply decrease the hop while keeping a fixed number of canvas columns. That would display only the beginning of the recording while a full-duration time axis falsely implies that the complete recording is visible.

## Frequency mapping

For a full-band view, map the bottom of the image to 0 Hz and the top to the Nyquist frequency:

```js
const normalizedY = y / Math.max(1, plotHeight - 1);
const frequencyBin = Math.min(
  fftSize / 2 - 1,
  Math.round(normalizedY * (fftSize / 2 - 1))
);
```

The image buffer is vertically flipped when the pixel is written so low frequencies appear at the bottom:

```js
const pixelIndex = ((plotHeight - 1 - y) * plotWidth + x) * 4;
```

Do not apply an exponent such as `Math.pow(normalizedY, 1.85)` while drawing a linearly labeled axis. That produces frequency positions that disagree with their labels.

### Optional 18-24 kHz ultrasound view

Use this mapping when the target project should spend all vertical pixels on ultrasound:

```js
const minFrequency = 18000;
const maxFrequency = Math.min(24000, audioBuffer.sampleRate / 2);
const minBin = Math.floor(minFrequency * fftSize / audioBuffer.sampleRate);
const maxBin = Math.min(
  fftSize / 2 - 1,
  Math.ceil(maxFrequency * fftSize / audioBuffer.sampleRate)
);
const frequencyBin = Math.round(
  minBin + normalizedY * (maxBin - minBin)
);
```

The y-axis labels must use the identical range:

```js
const frequencyKhz = (
  minFrequency + ratio * (maxFrequency - minFrequency)
) / 1000;
```

## Canvas behavior

One horizontal pixel represents one FFT frame. Set the intrinsic canvas width from the frame count and keep it at its natural CSS width inside a scrollable container:

```css
.spectrogram-scroll,
.spectrogram-panel {
  overflow-x: auto;
}

.spectrogram-canvas {
  display: block;
  width: auto;
  min-width: 100%;
  max-width: none;
  height: auto;
}
```

Scaling a many-column canvas back down to the viewport width hides the additional time detail. Horizontal scrolling preserves it.

## Tuning guide

Change one dimension deliberately:

| Goal | Change | Tradeoff |
| --- | --- | --- |
| More true frequency resolution | Increase `fftSize` | Longer analysis window and more time smearing |
| More time samples | Decrease `hopLength` | Wider image and more FFT frames |
| More ultrasound display detail | Limit the view to 18-24 kHz | Audible frequencies are no longer visible |
| Reveal weaker energy | Lower `minDb`, for example to `-105` | More background noise becomes visible |
| Increase vertical display detail | Increase `canvasHeight` | Larger PNG and more screen space |

For a repeating 12 ms chirp, a 1024-sample window at 48 kHz spans about 21.33 ms, so it may combine energy from adjacent chirps. If tracing each individual sweep is more important than frequency-bin spacing, use a 512-sample FFT with a 64- or 128-sample hop. If separating nearby spectral components is more important, keep 1024 or try 2048.

## Performance requirement

Use a radix-2 FFT, WebAssembly FFT, or a maintained FFT library. Do not calculate a full direct DFT separately for every output pixel. One FFT should be computed per time frame and its result reused for all vertical pixels in that column.

The FFT size must remain a power of two for the included radix-2 implementation. Validate configuration changes before rendering.

For long renders, periodically yield to the browser event loop so the page remains responsive:

```js
if (column > 0 && column % 256 === 0) {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
```

## Acceptance checks

The port is complete when all of the following are true:

1. A 48 kHz WAV containing a 20 kHz sine wave shows one horizontal ridge at approximately 20 kHz.
2. A 1 kHz sine wave appears at approximately 1 kHz, confirming that pixels and axis labels use the same mapping.
3. A multi-second recording creates adjacent frames 256 samples apart unless `maxColumns` requires a larger effective hop.
4. The right edge of the time axis corresponds to the end of the recording.
5. Long recordings scroll horizontally instead of being scaled down to the viewport.
6. The displayed status reports `FFT 1024` and the effective hop length.
7. The rendered canvas can be saved as a PNG.
8. The page remains responsive while a long recording is processed.

