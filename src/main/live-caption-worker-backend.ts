import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LiveCaptionWorkerEngine, type CaptionSherpaModule } from "./live-caption-worker-engine";
import type {
  CaptionWorkerConfig,
  CaptionWorkerEvent,
  CaptionWorkerRequest,
} from "./live-caption-worker-protocol";

export interface LiveCaptionBackend {
  start(config: CaptionWorkerConfig, onEvent: (event: CaptionWorkerEvent) => void): Promise<void>;
  acceptAudio(inputSampleRate: number, samples: Float32Array): void;
  stop(): Promise<void>;
  terminate(): Promise<void>;
}

export type LiveCaptionBackendFactory = () => LiveCaptionBackend;

export class WorkerLiveCaptionBackend implements LiveCaptionBackend {
  private worker?: Worker;
  private onEvent?: (event: CaptionWorkerEvent) => void;
  private ready?: { resolve: () => void; reject: (error: Error) => void };
  private stopped?: { resolve: () => void; reject: (error: Error) => void };
  private terminating = false;

  start(config: CaptionWorkerConfig, onEvent: (event: CaptionWorkerEvent) => void): Promise<void> {
    this.onEvent = onEvent;
    this.terminating = false;
    const worker = new Worker(join(__dirname, "live-caption-worker.js"));
    this.worker = worker;
    worker.on("message", (event: CaptionWorkerEvent) => this.handleEvent(event));
    worker.on("error", (error) => this.handleFailure(error));
    worker.on("exit", (code) => {
      if (!this.terminating && code !== 0) {
        this.handleFailure(new Error(`实时字幕 Worker 异常退出 (${code})。`));
      }
    });
    const promise = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    this.post({ type: "initialize", config });
    return promise;
  }

  acceptAudio(inputSampleRate: number, samples: Float32Array): void {
    let transferable = samples;
    if (samples.byteOffset !== 0 || samples.byteLength !== samples.buffer.byteLength) {
      transferable = samples.slice();
    }
    this.post(
      { type: "audio", inputSampleRate, samples: transferable },
      [transferable.buffer as ArrayBuffer],
    );
  }

  stop(): Promise<void> {
    if (!this.worker) return Promise.resolve();
    const promise = new Promise<void>((resolve, reject) => {
      this.stopped = { resolve, reject };
    });
    this.post({ type: "stop" });
    return promise;
  }

  async terminate(): Promise<void> {
    const worker = this.worker;
    this.worker = undefined;
    this.terminating = true;
    this.ready = undefined;
    this.stopped = undefined;
    if (worker) await worker.terminate();
  }

  private post(request: CaptionWorkerRequest, transfer?: ArrayBuffer[]): void {
    if (!this.worker) throw new Error("实时字幕 Worker 尚未启动。");
    this.worker.postMessage(request, transfer ?? []);
  }

  private handleEvent(event: CaptionWorkerEvent): void {
    if (event.type === "ready") {
      this.ready?.resolve();
      this.ready = undefined;
    } else if (event.type === "stopped") {
      this.stopped?.resolve();
      this.stopped = undefined;
    } else if (event.type === "error") {
      this.handleFailure(new Error(event.message));
      return;
    }
    this.onEvent?.(event);
  }

  private handleFailure(error: Error): void {
    this.ready?.reject(error);
    this.stopped?.reject(error);
    this.ready = undefined;
    this.stopped = undefined;
    this.onEvent?.({ type: "error", message: error.message });
  }
}

export class InProcessLiveCaptionBackend implements LiveCaptionBackend {
  private engine?: LiveCaptionWorkerEngine;

  constructor(private readonly loadSherpa: () => CaptionSherpaModule) {}

  async start(
    config: CaptionWorkerConfig,
    onEvent: (event: CaptionWorkerEvent) => void,
  ): Promise<void> {
    this.engine = new LiveCaptionWorkerEngine(onEvent, this.loadSherpa);
    this.engine.initialize(config);
  }

  acceptAudio(inputSampleRate: number, samples: Float32Array): void {
    this.engine?.acceptAudio(inputSampleRate, samples);
  }

  async stop(): Promise<void> {
    this.engine?.stop();
  }

  async terminate(): Promise<void> {
    this.engine = undefined;
  }
}
