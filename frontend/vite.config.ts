import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.API_PROXY_TARGET || 'http://127.0.0.1:1752';
  return {
    plugins: [react()],
    base: mode === 'production' ? '/static/' : '/',
    server: {
      port: 5173,
      strictPort: true,
      // Keep the browser's Origin/Host together for the backend's cookie CSRF check.
      proxy: { '/v1': { target, changeOrigin: false }, '/health': { target, changeOrigin: false } },
    },
    build: { outDir: '../app/static', emptyOutDir: true },
    test: { environment: 'jsdom', restoreMocks: true },
  };
});
