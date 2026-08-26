export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface AsyncBeforeQuitOptions {
  begin: () => void;
  cleanup: () => Promise<void>;
  quit: () => void;
  onError?: (error: unknown) => void;
  timeoutMs?: number;
}

/**
 * Electron does not await async before-quit listeners. This gate cancels the
 * first quit, performs bounded cleanup once, and lets the second quit proceed.
 */
export function createAsyncBeforeQuitHandler(
  options: AsyncBeforeQuitOptions,
): (event: BeforeQuitEventLike) => void {
  let phase: "idle" | "cleaning" | "complete" = "idle";

  return (event) => {
    if (phase === "complete") return;
    event.preventDefault();
    if (phase === "cleaning") return;

    phase = "cleaning";
    try {
      options.begin();
    } catch (error) {
      options.onError?.(error);
    }
    void settleWithin(
      Promise.resolve().then(options.cleanup),
      options.timeoutMs ?? 12_000,
    ).catch((error) => {
      options.onError?.(error);
    }).finally(() => {
      phase = "complete";
      options.quit();
    });
  };
}

function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`应用退出清理在 ${timeoutMs} ms 内未完成`)),
      timeoutMs,
    );
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
