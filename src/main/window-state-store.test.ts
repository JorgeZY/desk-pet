import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WindowStateStore } from "./window-state-store";

describe("WindowStateStore", () => {
  it("round-trips normalized state atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "desk-pet-window-state-"));
    const filePath = join(directory, "window-state.json");
    const store = new WindowStateStore(filePath);
    await store.write({
      layoutVersion: 1,
      petPosition: { x: 10.4, y: 20.6 },
      workbenchBounds: { x: 30, y: 40, width: 1120, height: 760 },
      workbenchMaximized: true,
      sidebarCollapsed: true,
    });
    expect(await store.read()).toMatchObject({
      petPosition: { x: 10, y: 21 },
      workbenchMaximized: true,
      sidebarCollapsed: true,
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ layoutVersion: 1 });
  });
});
