import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: true,
    rollupOptions: {
      output: {
        manualChunks: {
          virtual: ["@tanstack/react-virtual"],
        },
      },
    },
  },
  server: { host: "127.0.0.1", port: 5173, proxy: { "/api": "http://127.0.0.1:4317" } },
});
