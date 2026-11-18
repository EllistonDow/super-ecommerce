import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/admin-spa/",
  plugins: [react()],
  build: {
    target: "esnext",
    outDir: "dist",
    sourcemap: false,
  },
  server: {
    port: 5174,
    proxy: {
      "/rpc": "http://127.0.0.1:4100",
      "/mcp": "http://127.0.0.1:4100",
      "/healthz": "http://127.0.0.1:4100",
      "/openapi.json": "http://127.0.0.1:4100",
    },
  },
});
