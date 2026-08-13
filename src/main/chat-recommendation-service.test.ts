import { describe, expect, it, vi } from "vitest";
import type { RuntimeState } from "../shared/types";
import { ChatRecommendationService } from "./chat-recommendation-service";

const readyState = { phase: "ready" } as RuntimeState;

function createHarness() {
  const cache = new Map<string, string[]>();
  const store = {
    getRecommendationContext: vi.fn(() => ({ fingerprint: "history-1", transcript: "近期历史" })),
    getCachedRecommendations: vi.fn((fingerprint: string) => cache.get(fingerprint) ?? null),
    cacheRecommendations: vi.fn((fingerprint: string, recommendations: string[]) => {
      cache.set(fingerprint, recommendations);
    }),
  };
  const runtime = {
    snapshot: readyState,
    hasActiveChat: false,
    canRunIdleRecommendations: true,
    generateChatRecommendations: vi.fn(async () => ["建议一", "建议二", "建议三"]),
  };
  const canPrecompute = vi.fn(() => true);
  const service = new ChatRecommendationService({ store, runtime, canPrecompute });
  return { cache, store, runtime, canPrecompute, service };
}

describe("ChatRecommendationService", () => {
  it("serves cache misses without starting interactive inference", () => {
    const { runtime, service } = createHarness();

    expect(service.getCachedRecommendations()).toEqual([]);
    expect(runtime.generateChatRecommendations).not.toHaveBeenCalled();
  });

  it("precomputes once while idle and serves the cached result afterwards", async () => {
    const { runtime, service } = createHarness();

    await service.precomputeIfIdle();

    expect(runtime.generateChatRecommendations).toHaveBeenCalledTimes(1);
    expect(service.getCachedRecommendations()).toEqual(["建议一", "建议二", "建议三"]);
    await service.precomputeIfIdle();
    expect(runtime.generateChatRecommendations).toHaveBeenCalledTimes(1);
  });

  it("does not generate while the panel is interactive or a chat is active", async () => {
    const { runtime, canPrecompute, service } = createHarness();
    canPrecompute.mockReturnValue(false);

    await service.precomputeIfIdle();
    expect(runtime.generateChatRecommendations).not.toHaveBeenCalled();

    canPrecompute.mockReturnValue(true);
    runtime.hasActiveChat = true;
    await service.precomputeIfIdle();
    expect(runtime.generateChatRecommendations).not.toHaveBeenCalled();
  });

  it("does not retry a failed fingerprint and stack possible orphaned work", async () => {
    const { runtime, service } = createHarness();
    runtime.generateChatRecommendations.mockRejectedValueOnce(new Error("disconnected"));

    await service.precomputeIfIdle();
    await service.precomputeIfIdle();

    expect(runtime.generateChatRecommendations).toHaveBeenCalledTimes(1);
  });

  it("allows an intentionally interrupted fingerprint to run on the next idle period", async () => {
    const { runtime, service } = createHarness();
    runtime.generateChatRecommendations
      .mockRejectedValueOnce(new DOMException("IDLE_RECOMMENDATION_INTERRUPTED", "AbortError"))
      .mockResolvedValueOnce(["新建议一", "新建议二", "新建议三"]);

    await service.precomputeIfIdle();
    await service.precomputeIfIdle();

    expect(runtime.generateChatRecommendations).toHaveBeenCalledTimes(2);
    expect(service.getCachedRecommendations()).toEqual(["新建议一", "新建议二", "新建议三"]);
  });

  it("does not cache a result after the referenced history changes", async () => {
    const { store, runtime, service } = createHarness();
    runtime.generateChatRecommendations.mockImplementationOnce(async () => {
      store.getRecommendationContext.mockReturnValue({
        fingerprint: "history-2",
        transcript: "更新后的历史",
      });
      return ["旧建议一", "旧建议二", "旧建议三"];
    });

    await service.precomputeIfIdle();

    expect(store.cacheRecommendations).not.toHaveBeenCalled();
  });
});
