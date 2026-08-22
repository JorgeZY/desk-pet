import { parentPort } from "node:worker_threads";
import { LiveCaptionWorkerEngine } from "./live-caption-worker-engine";
import type {
  CaptionWorkerEvent,
  CaptionWorkerRequest,
} from "./live-caption-worker-protocol";

const port = parentPort;
if (!port) throw new Error("Live caption worker requires a parent port.");

const emit = (event: CaptionWorkerEvent): void => port.postMessage(event);
const engine = new LiveCaptionWorkerEngine(emit);

port.on("message", (request: CaptionWorkerRequest) => {
  try {
    if (request.type === "initialize") engine.initialize(request.config);
    else if (request.type === "audio") engine.acceptAudio(request.inputSampleRate, request.samples);
    else if (request.type === "stop") engine.stop();
  } catch (error) {
    emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
});
