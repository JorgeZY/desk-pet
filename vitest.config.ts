import { resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const domTestPatterns = [
  "src/renderer/**/*.dom.test.ts",
  "src/renderer/**/*.dom.test.tsx",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "src/renderer"),
    },
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          environment: "node",
          exclude: [...configDefaults.exclude, ...domTestPatterns],
          name: "node",
        },
      },
      {
        extends: true,
        test: {
          environment: "jsdom",
          environmentOptions: {
            jsdom: {
              pretendToBeVisual: true,
              url: "http://localhost/",
            },
          },
          include: domTestPatterns,
          name: "renderer-dom",
          setupFiles: [resolve(__dirname, "src/renderer/test/setup.ts")],
        },
      },
    ],
  },
});
