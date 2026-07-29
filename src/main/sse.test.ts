import { describe, expect, it } from "vitest";
import { SseDecoder } from "./sse";

describe("SseDecoder", () => {
  it("handles events split across network chunks", () => {
    const decoder = new SseDecoder();
    expect(decoder.push('data: {"choices":[{"del')).toEqual([]);
    expect(decoder.push('ta":{"content":"你"}}]}\n\n')).toEqual([
      { event: undefined, data: '{"choices":[{"delta":{"content":"你"}}]}' },
    ]);
  });

  it("supports CRLF, comments, event names, and DONE", () => {
    const decoder = new SseDecoder();
    expect(decoder.push(": keepalive\r\nevent: message\r\ndata: [DONE]\r\n\r\n")).toEqual([
      { event: "message", data: "[DONE]" },
    ]);
  });

  it("joins multiline data fields", () => {
    const decoder = new SseDecoder();
    expect(decoder.push("data: first\ndata: second\n\n")).toEqual([
      { event: undefined, data: "first\nsecond" },
    ]);
  });
});
