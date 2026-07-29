import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "./config-store";
import { buildLlamaCommand } from "./llama-runtime";

describe("buildLlamaCommand", () => {
  it("uses the unified llama serve command and a replaceable HF model", () => {
    const command = buildLlamaCommand({ ...DEFAULT_CONFIG, executable: "llama" });
    expect(command.command).toBe("llama");
    expect(command.args.slice(0, 3)).toEqual([
      "serve",
      "-hf",
      "openbmb/MiniCPM5-1B-GGUF:Q4_K_M",
    ]);
    expect(command.args).toContain("--jinja");
    expect(command.args).toContain("desk-pet-model");
    expect(command.args).toContain("--cors-origins");
    expect(command.args).toContain("localhost");
  });

  it("does not add a subcommand to llama-server.exe", () => {
    const command = buildLlamaCommand({
      ...DEFAULT_CONFIG,
      executable: "C:\\tools\\llama-server.exe",
      modelMode: "local",
      modelPath: "D:\\models\\any-local-model.gguf",
    });
    expect(command.args[0]).toBe("-m");
    expect(command.args[1]).toBe("D:\\models\\any-local-model.gguf");
    expect(command.args).not.toContain("serve");
  });
});
