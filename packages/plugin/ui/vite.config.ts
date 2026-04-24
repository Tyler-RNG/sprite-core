import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Build output lives next to the plugin source so the plugin's static-serve
// route (`src/ui-route.ts`) can ship it without a cross-package import. The
// plugin's `files` field in package.json must include `ui-dist` for publish.
export default defineConfig({
  plugins: [react()],
  base: "/sprite-core/ui/",
  build: {
    outDir: path.resolve(__dirname, "../ui-dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "es2022",
  },
  server: {
    port: 5173,
    // Dev-mode proxy so the UI can call its own plugin-served APIs through the
    // local gateway without CORS. Operators point this at their gateway URL.
    proxy: {
      "/sprite-core": {
        target: process.env.SPRITE_CORE_GATEWAY_URL ?? "http://localhost:8080",
        changeOrigin: true,
      },
    },
  },
});
