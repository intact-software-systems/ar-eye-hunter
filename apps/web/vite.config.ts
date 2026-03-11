import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@shared-web': path.resolve(__dirname, '../../packages/shared-web'),
            '@shared-graph': path.resolve(__dirname, '../../packages/shared-graph'),
            '@shared': path.resolve(__dirname, '../../packages/shared'),
        },
    },

    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8080', // your Deno API local port
                changeOrigin: true,
                // ws: true,
            },
        },
    },

    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023',
    },
});
