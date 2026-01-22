import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, '../../packages/shared'),
        },
    },

    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8000', // your Deno API local port
                changeOrigin: true,
            },
        },
    },

    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
    },
});
