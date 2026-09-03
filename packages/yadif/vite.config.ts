import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  worker: {
    rollupOptions: {
      output: { sourcemap: true },
    },
  },
  build: {
    sourcemap: true,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    emptyOutDir: true,
  },
});
