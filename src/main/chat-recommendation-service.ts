import type { RuntimeState } from "../shared/types";
import type { RecommendationContext } from "./chat-history-store";

interface RecommendationRuntime {
  readonly snapshot: RuntimeState;
  readonly hasActiveChat: boolean;
  readonly canRunIdleRecommendations: boolean;
  generateChatRecommendations(transcript: string): Promise<string[]>;
}

interface RecommendationStore {
  getRecommendationContext(): RecommendationContext | null;
  getCachedRecommendations(fingerprint: string): string[] | null;
  cacheRecommendations(fingerprint: string, recommendations: string[]): void;
}

interface ChatRecommendationServiceOptions {
  store: RecommendationStore;
  runtime: RecommendationRuntime;
  canPrecompute: () => boolean;
  onError?: (error: unknown) => void;
}

const IDLE_RECOMMENDATION_INTERRUPTED = "IDLE_RECOMMENDATION_INTERRUPTED";

function isValidRecommendationSet(recommendations: string[]): boolean {
  if (
    recommendations.length !== 3 ||
    recommendations.some((recommendation) => {
      const trimmed = recommendation.trim();
      return !trimmed || trimmed.length > 80;
    })
  ) {
    return false;
  }
  return new Set(recommendations.map((recommendation) => recommendation.trim())).size === 3;
}

/**
 * Keeps recommendation inference out of the interactive renderer path.
 * The panel can only read an already-computed cache entry; a cache miss is
 * filled later when Electron reports that the app and computer are idle.
 */
export class ChatRecommendationService {
  private readonly attemptedFingerprints = new Set<string>();
  private activePrecompute: Promise<void> | null = null;

  constructor(private readonly options: ChatRecommendationServiceOptions) {}

  getCachedRecommendations(): string[] {
    const context = this.options.store.getRecommendationContext();
    if (!context) return [];
    const cached = this.options.store.getCachedRecommendations(context.fingerprint);
    return cached && isValidRecommendationSet(cached) ? cached : [];
  }

  precomputeIfIdle(): Promise<void> {
    if (this.activePrecompute) return this.activePrecompute;
    const { runtime, store } = this.options;
    if (
      !this.options.canPrecompute() ||
      runtime.snapshot.phase !== "ready" ||
      runtime.hasActiveChat ||
      !runtime.canRunIdleRecommendations
    ) {
      return Promise.resolve();
    }

    const context = store.getRecommendationContext();
    if (
      !context ||
      store.getCachedRecommendations(context.fingerprint) ||
      this.attemptedFingerprints.has(context.fingerprint)
    ) {
      return Promise.resolve();
    }

    // Never retry the same history fingerprint in this process. If a request
    // disconnects after llama.cpp accepted it, retrying could stack work behind
    // an inference that the server did not actually cancel.
    this.attemptedFingerprints.add(context.fingerprint);
    let precompute!: Promise<void>;
    precompute = runtime.generateChatRecommendations(context.transcript)
      .then((recommendations) => {
        const latestContext = store.getRecommendationContext();
        if (
          isValidRecommendationSet(recommendations) &&
          latestContext?.fingerprint === context.fingerprint
        ) {
          store.cacheRecommendations(context.fingerprint, recommendations);
        }
      })
      .catch((error) => {
        if (
          error instanceof Error &&
          error.name === "AbortError" &&
          error.message === IDLE_RECOMMENDATION_INTERRUPTED
        ) {
          this.attemptedFingerprints.delete(context.fingerprint);
        }
        this.options.onError?.(error);
      })
      .finally(() => {
        if (this.activePrecompute === precompute) this.activePrecompute = null;
      });
    this.activePrecompute = precompute;
    return precompute;
  }
}
