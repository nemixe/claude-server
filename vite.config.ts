import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/client/",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: "client/index.html",
      output: {
        entryFileNames: "assets/client.js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]"
      }
    }
  }
});
