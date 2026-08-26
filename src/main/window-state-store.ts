import { app } from "electron";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import type { WindowUiState } from "../shared/types";
import { normalizeWindowUiState } from "../shared/window-state";

export class WindowStateStore {
  constructor(private readonly filePath = join(app.getPath("userData"), "window-state.json")) {}

  async read(): Promise<WindowUiState> {
    try {
      return normalizeWindowUiState(JSON.parse(await fs.readFile(this.filePath, "utf8")));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return normalizeWindowUiState(undefined);
    }
  }

  async write(value: WindowUiState): Promise<WindowUiState> {
    const state = normalizeWindowUiState(value);
    await fs.mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(temporaryPath, this.filePath);
    return state;
  }
}
