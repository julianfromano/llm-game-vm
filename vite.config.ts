import { defineConfig } from 'vite';

// Proyecto del juego: HTTP plano en localhost (no necesita HTTPS ni certificados).
export default defineConfig({
  server: { host: true, port: 5173 },
  preview: { host: true, port: 5173 },
});
