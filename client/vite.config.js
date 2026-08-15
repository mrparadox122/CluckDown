import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, host: true },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // Babylon is by far the heaviest thing here; splitting it out means a
        // code change to the game doesn't bust the engine cache for returning players.
        manualChunks(id) {
          if (id.includes('@babylonjs')) return 'babylon';
          if (id.includes('colyseus') || id.includes('nipplejs')) return 'net';
        },
      },
    },
  },
});
