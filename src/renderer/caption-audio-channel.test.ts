import { afterEach, describe, expect, it, vi } from "vitest";

describe("caption audio message channel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("waits for the main-process handshake and clones PCM without a transfer list", async () => {
    let receiveWindowMessage: ((event: MessageEvent) => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
        if (type === "message") receiveWindowMessage = listener;
      },
    });
    const postMessage = vi.fn();
    const port = {
      close: vi.fn(),
      start: vi.fn(),
      postMessage,
      onmessage: null as ((event: MessageEvent) => void) | null,
    };
    const { sendCaptionAudio } = await import("./caption-audio-channel");
    receiveWindowMessage?.({
      data: { type: "desktop-pet:caption-audio-port" },
      ports: [port as unknown as MessagePort],
    } as unknown as MessageEvent);

    expect(postMessage).toHaveBeenCalledWith({ type: "caption-audio-handshake" });
    expect(sendCaptionAudio("session", 48_000, new Float32Array([0.1]))).toBe(false);

    port.onmessage?.({ data: { type: "caption-audio-ready" } } as MessageEvent);
    postMessage.mockClear();
    const samples = new Float32Array([0.1, -0.1]);
    expect(sendCaptionAudio("session", 48_000, samples)).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ sessionId: "session", sampleRate: 48_000, samples });
    expect(postMessage.mock.calls[0]).toHaveLength(1);
  });
});
