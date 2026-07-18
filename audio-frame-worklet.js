class AudioFrameProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const processorOptions = options.processorOptions || {};
    this.frameSize = Math.max(128, processorOptions.frameSize || 2048);
    this.buffer = new Float32Array(this.frameSize);
    this.writeIndex = 0;
    this.frameSequence = 0;
    this.frameStart = currentFrame;
  }

  pushSample(sample) {
    this.buffer[this.writeIndex] = sample;
    this.writeIndex += 1;

    if (this.writeIndex >= this.frameSize) {
      const frame = this.buffer;
      this.frameSequence += 1;
      this.port.postMessage({
        type: "audio-frame",
        sequence: this.frameSequence,
        startFrame: this.frameStart,
        samples: frame
      }, [frame.buffer]);
      this.buffer = new Float32Array(this.frameSize);
      this.writeIndex = 0;
      this.frameStart += this.frameSize;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || input[0].length === 0) {
      return true;
    }

    const channelCount = input.length;
    const frameLength = input[0].length;

    if (this.writeIndex === 0) {
      this.frameStart = currentFrame;
    }

    for (let sampleIndex = 0; sampleIndex < frameLength; sampleIndex += 1) {
      let monoSample = 0;
      for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
        monoSample += input[channelIndex][sampleIndex] || 0;
      }
      this.pushSample(monoSample / channelCount);
    }

    return true;
  }
}

registerProcessor("audio-frame-processor", AudioFrameProcessor);
