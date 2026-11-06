import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('..', import.meta.url)), '');
  const port = env.PORT || '3000';
  return {
    root,
    plugins: [react(), tailwind()],
    build: { outDir: '../dist/client', emptyOutDir: true },
    server: {
      host: '0.0.0.0', port: 5173, strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${port}` },
    },
  };
});
