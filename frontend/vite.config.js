import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react()],
  server: {
    // Keep the browser's Host so the API's same-origin check sees the page it came from.
    proxy: {
      "/api": { target: "http://127.0.0.1:8765", changeOrigin: false },
      "/openapi.json": { target: "http://127.0.0.1:8765", changeOrigin: false },
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
