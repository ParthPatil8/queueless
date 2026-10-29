import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: /api is proxied to the Express backend. Production: Express serves the built files itself (same origin).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
