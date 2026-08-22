const CAPTION_AUDIO_PORT_MESSAGE = "desktop-pet:caption-audio-port";

let captionAudioPort: MessagePort | undefined;
let captionAudioPortReady = false;

window.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type !== CAPTION_AUDIO_PORT_MESSAGE || !event.ports[0]) return;
  captionAudioPort?.close();
  captionAudioPortReady = false;
  captionAudioPort = event.ports[0];
  captionAudioPort.onmessage = (message) => {
    if (message.data?.type === "caption-audio-ready") captionAudioPortReady = true;
  };
  captionAudioPort.start();
  captionAudioPort.postMessage({ type: "caption-audio-handshake" });
});

export function sendCaptionAudio(
  sessionId: string,
  sampleRate: number,
  samples: Float32Array,
): boolean {
  if (!captionAudioPort || !captionAudioPortReady || samples.length === 0) return false;
  try {
    // Electron's renderer-to-MessagePortMain boundary reliably clones typed
    // arrays, but transferring their ArrayBuffer can silently drop the message.
    // A 4096-sample chunk is only 16 KiB, so keep the dedicated port and clone it.
    captionAudioPort.postMessage({ sessionId, sampleRate, samples });
    return true;
  } catch {
    return false;
  }
}
