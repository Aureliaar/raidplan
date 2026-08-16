import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";
import path from "node:path";

export default defineConfig({
  plugins: [react(), tailwindcss(), cloudflare(), agents()],
  resolve: {
    alias: { "~": path.resolve(import.meta.dirname, "src") },
  },
});
