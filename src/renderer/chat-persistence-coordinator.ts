type FlushHandler = () => Promise<void>;

let activeFlushHandler: FlushHandler | null = null;
const pendingPersistence = new Set<Promise<void>>();
const failedPersistence = new Map<string, unknown>();
const persistenceVersions = new Map<string, number>();

/** Retains the newest database save even after ChatPanel unmounts. */
export function trackChatPersistence(
  persistence: Promise<void>,
  key = "chat-history",
): Promise<void> {
  const version = (persistenceVersions.get(key) ?? 0) + 1;
  persistenceVersions.set(key, version);
  pendingPersistence.add(persistence);
  void persistence.then(
    () => {
      pendingPersistence.delete(persistence);
      if (persistenceVersions.get(key) === version) failedPersistence.delete(key);
    },
    (error) => {
      pendingPersistence.delete(persistence);
      if (persistenceVersions.get(key) === version) failedPersistence.set(key, error);
    },
  );
  return persistence;
}

export function registerChatPersistenceFlush(handler: FlushHandler): () => void {
  activeFlushHandler = handler;
  return () => {
    if (activeFlushHandler === handler) activeFlushHandler = null;
  };
}

/** Flush the mounted panel, then wait for every save still in flight. */
export async function flushChatPersistence(): Promise<void> {
  await activeFlushHandler?.();
  while (pendingPersistence.size) {
    await Promise.allSettled([...pendingPersistence]);
  }
  if (failedPersistence.size) {
    throw new AggregateError(
      [...failedPersistence.values()],
      "One or more chat history saves failed before quit.",
    );
  }
}
