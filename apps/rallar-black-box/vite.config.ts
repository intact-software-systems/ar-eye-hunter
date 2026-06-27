import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  envDir: path.resolve(__dirname, '../..'),
  envPrefix: ['VITE_'],
  resolve: {
    alias: {
      '@shared-test': path.resolve(__dirname, '../../packages/shared-test'),
      '@shared-web': path.resolve(__dirname, '../../packages/shared-web'),
      '@shared-server': path.resolve(__dirname, '../../packages/shared-server'),
      '@shared-graph': path.resolve(__dirname, '../../packages/shared-graph'),
      '@shared': path.resolve(__dirname, '../../packages/shared'),
    },
  },
  server: {
    port: 5176,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    rolldownOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react';
          }
        },
      },
    },
  },
});
