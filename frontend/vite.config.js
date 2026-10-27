import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/openapi.json": "http://127.0.0.1:8765",
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        docs: resolve(import.meta.dirname, "docs.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.jsx"],
    setupFiles: ["./src/test-setup.js"],
  },
});
