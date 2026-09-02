import { describe, expect, it, vi } from "vitest";
import { ModelRunCoordinator } from "./model-run-coordinator";

describe("ModelRunCoordinator", () => {
  it("runs only one operation at a time", async () => {
    const coordinator = new ModelRunCoordinator();
    const firstGate = deferred<void>();
    let active = 0;
    let maximumActive = 0;
    const operation = async (gate?: Promise<void>): Promise<string> => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (gate) await gate;
      active -= 1;
      return "done";
    };

    const first = coordinator.run("task", new AbortController().signal, () => (
      operation(firstGate.promise)
    ));
    const second = coordinator.run("chat", new AbortController().signal, () => operation());
    await flushMicrotasks();
    expect(coordinator.snapshot()).toMatchObject({ running: "task", pendingChat: 1 });
    expect(maximumActive).toBe(1);

    firstGate.resolve(undefined);
    await expect(Promise.all([first, second])).resolves.toEqual(["done", "done"]);
    expect(maximumActive).toBe(1);
    expect(coordinator.snapshot()).toMatchObject({
      running: null,
      pendingChat: 0,
      pendingTask: 0,
    });
  });

  it("lets chat overtake a task that has not started", async () => {
    const coordinator = new ModelRunCoordinator();
    const blocker = deferred<void>();
    const order: string[] = [];
    const running = coordinator.run("task", new AbortController().signal, async () => {
      order.push("running-task");
      await blocker.promise;
    });
    const queuedTask = coordinator.run("task", new AbortController().signal, () => {
      order.push("queued-task");
    });
    const queuedChat = coordinator.run("chat", new AbortController().signal, () => {
      order.push("queued-chat");
    });

    await flushMicrotasks();
    blocker.resolve(undefined);
    await Promise.all([running, queuedTask, queuedChat]);
    expect(order).toEqual(["running-task", "queued-chat", "queued-task"]);
  });

  it("runs a waiting task after at most three consecutive chats", async () => {
    const coordinator = new ModelRunCoordinator();
    const blocker = deferred<void>();
    const order: string[] = [];
    const promises: Promise<unknown>[] = [
      coordinator.run("task", new AbortController().signal, async () => {
        order.push("running-task");
        await blocker.promise;
      }),
      coordinator.run("task", new AbortController().signal, () => {
        order.push("waiting-task");
      }),
    ];
    for (let index = 1; index <= 4; index += 1) {
      promises.push(coordinator.run("chat", new AbortController().signal, () => {
        order.push(`chat-${index}`);
      }));
    }

    await flushMicrotasks();
    blocker.resolve(undefined);
    await Promise.all(promises);
    expect(order).toEqual([
      "running-task",
      "chat-1",
      "chat-2",
      "chat-3",
      "waiting-task",
      "chat-4",
    ]);
  });

  it("removes and rejects an aborted queued operation", async () => {
    const coordinator = new ModelRunCoordinator();
    const blocker = deferred<void>();
    const running = coordinator.run("chat", new AbortController().signal, () => blocker.promise);
    const queuedController = new AbortController();
    const queuedOperation = vi.fn(() => "should not run");
    const queued = coordinator.run("task", queuedController.signal, queuedOperation);

    await flushMicrotasks();
    expect(coordinator.snapshot().pendingTask).toBe(1);
    queuedController.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(coordinator.snapshot().pendingTask).toBe(0);
    expect(queuedOperation).not.toHaveBeenCalled();

    blocker.resolve(undefined);
    await running;
  });

  it("rejects an already-aborted run without enqueueing it", async () => {
    const coordinator = new ModelRunCoordinator();
    const controller = new AbortController();
    const reason = new Error("cancelled before queueing");
    const operation = vi.fn();
    controller.abort(reason);

    await expect(coordinator.run("chat", controller.signal, operation)).rejects.toBe(reason);
    expect(operation).not.toHaveBeenCalled();
    expect(coordinator.snapshot()).toMatchObject({ running: null, pendingChat: 0 });
  });

  it("releases the slot after a synchronous throw or rejected operation", async () => {
    const coordinator = new ModelRunCoordinator();
    const order: string[] = [];
    const failed = coordinator.run("chat", new AbortController().signal, () => {
      order.push("failed");
      throw new Error("model failure");
    });
    const next = coordinator.run("task", new AbortController().signal, async () => {
      order.push("next");
      return 42;
    });

    await expect(failed).rejects.toThrow("model failure");
    await expect(next).resolves.toBe(42);
    expect(order).toEqual(["failed", "next"]);
    expect(coordinator.snapshot().running).toBeNull();
  });

  it("does not release a running slot merely because its signal aborts", async () => {
    const coordinator = new ModelRunCoordinator();
    const runningController = new AbortController();
    const blocker = deferred<void>();
    const nextOperation = vi.fn(() => "next");
    const running = coordinator.run("task", runningController.signal, async () => {
      await blocker.promise;
      return "finished";
    });
    const next = coordinator.run("chat", new AbortController().signal, nextOperation);

    await flushMicrotasks();
    runningController.abort();
    await flushMicrotasks();
    expect(nextOperation).not.toHaveBeenCalled();
    expect(coordinator.snapshot().running).toBe("task");

    blocker.resolve(undefined);
    await expect(running).resolves.toBe("finished");
    await expect(next).resolves.toBe("next");
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
