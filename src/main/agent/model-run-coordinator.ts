export type ModelRunKind = "chat" | "task";

export type ModelRunOperation<T> = (signal: AbortSignal) => T | PromiseLike<T>;

export interface ModelRunCoordinatorSnapshot {
  running: ModelRunKind | null;
  pendingChat: number;
  pendingTask: number;
  consecutiveChatRuns: number;
}

interface PendingRun {
  kind: ModelRunKind;
  signal: AbortSignal;
  operation: ModelRunOperation<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  onAbort: () => void;
}

const MAX_CONSECUTIVE_CHAT_RUNS = 3;

/**
 * Serializes access to a llama-server configured with `-np 1`.
 *
 * Chat runs may overtake queued task runs, but a waiting task is selected after
 * at most three consecutive chats. Running operations are never preempted: an
 * aborted operation keeps the slot until its returned promise settles.
 */
export class ModelRunCoordinator {
  private readonly chatQueue: PendingRun[] = [];
  private readonly taskQueue: PendingRun[] = [];
  private running: ModelRunKind | null = null;
  private consecutiveChatRuns = 0;

  run<T>(
    kind: ModelRunKind,
    signal: AbortSignal,
    operation: ModelRunOperation<T>,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(abortReason(signal));

    return new Promise<T>((resolve, reject) => {
      const pending: PendingRun = {
        kind,
        signal,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
        onAbort: () => this.cancelPending(pending),
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.queueFor(kind).push(pending);
      this.drain();
    });
  }

  snapshot(): ModelRunCoordinatorSnapshot {
    return {
      running: this.running,
      pendingChat: this.chatQueue.length,
      pendingTask: this.taskQueue.length,
      consecutiveChatRuns: this.consecutiveChatRuns,
    };
  }

  private cancelPending(pending: PendingRun): void {
    const queue = this.queueFor(pending.kind);
    const index = queue.indexOf(pending);
    if (index < 0) return;
    queue.splice(index, 1);
    pending.signal.removeEventListener("abort", pending.onAbort);
    pending.reject(abortReason(pending.signal));
    this.drain();
  }

  private drain(): void {
    if (this.running !== null) return;
    const pending = this.takeNext();
    if (!pending) return;

    pending.signal.removeEventListener("abort", pending.onAbort);
    if (pending.signal.aborted) {
      pending.reject(abortReason(pending.signal));
      this.drain();
      return;
    }

    this.running = pending.kind;
    if (pending.kind === "chat") {
      this.consecutiveChatRuns += 1;
    } else {
      this.consecutiveChatRuns = 0;
    }

    void Promise.resolve()
      .then(() => pending.operation(pending.signal))
      .then(
        (value) => this.finish(pending, () => pending.resolve(value)),
        (error) => this.finish(pending, () => pending.reject(error)),
      );
  }

  private finish(pending: PendingRun, settle: () => void): void {
    try {
      settle();
    } finally {
      this.running = null;
      this.drain();
    }
  }

  private takeNext(): PendingRun | undefined {
    if (
      this.chatQueue.length > 0
      && (
        this.taskQueue.length === 0
        || this.consecutiveChatRuns < MAX_CONSECUTIVE_CHAT_RUNS
      )
    ) {
      return this.chatQueue.shift();
    }
    return this.taskQueue.shift() ?? this.chatQueue.shift();
  }

  private queueFor(kind: ModelRunKind): PendingRun[] {
    return kind === "chat" ? this.chatQueue : this.taskQueue;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}
