import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
    resolve: {
        alias: {
            '@shared-web': path.resolve(import.meta.dirname, '../../packages/shared-web'),
            '@shared': path.resolve(import.meta.dirname, '../../packages/shared'),
            '@shared-graph': path.resolve(import.meta.dirname, '../../packages/shared-graph')
        }
    },
    server: {
        port: 5180,
        strictPort: true,
        proxy: {
            '/api': { target: 'http://127.0.0.1:8092', changeOrigin: true, ws: true }
        }
    },
    build: { target: 'es2023' }
});
