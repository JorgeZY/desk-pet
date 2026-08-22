export const CAPTION_AUDIO_CHUNK_SIZE = 4096;

export function downmixChannels(channels) {
  if (!channels || channels.length === 0 || channels[0].length === 0) {
    return new Float32Array();
  }
  const mixed = new Float32Array(channels[0].length);
  for (let frame = 0; frame < mixed.length; frame += 1) {
    let sample = 0;
    for (let channel = 0; channel < channels.length; channel += 1) {
      sample += channels[channel][frame] ?? 0;
    }
    mixed[frame] = sample / channels.length;
  }
  return mixed;
}

export function rmsLevel(samples) {
  if (!samples?.length) return 0;
  let energy = 0;
  for (let index = 0; index < samples.length; index += 1) {
    energy += samples[index] * samples[index];
  }
  return Math.sqrt(energy / samples.length);
}

if (typeof AudioWorkletProcessor !== "undefined") {
  class CaptionAudioProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.pending = new Float32Array(CAPTION_AUDIO_CHUNK_SIZE);
      this.pendingLength = 0;
    }

    process(inputs) {
      const mixed = downmixChannels(inputs[0]);
      for (let frame = 0; frame < mixed.length; frame += 1) {
        this.pending[this.pendingLength] = mixed[frame];
        this.pendingLength += 1;
        if (this.pendingLength === CAPTION_AUDIO_CHUNK_SIZE) {
          const chunk = this.pending;
          this.port.postMessage({ samples: chunk, level: rmsLevel(chunk) }, [chunk.buffer]);
          this.pending = new Float32Array(CAPTION_AUDIO_CHUNK_SIZE);
          this.pendingLength = 0;
        }
      }
      return true;
    }
  }

  registerProcessor("caption-audio-processor", CaptionAudioProcessor);
}
