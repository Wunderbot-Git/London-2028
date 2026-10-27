import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  // The lazily loaded Firebase chunk is ~600 kB; the demo bundle stays small.
  build: { chunkSizeWarningLimit: 900 },
  test: { environment: "node" },
});
