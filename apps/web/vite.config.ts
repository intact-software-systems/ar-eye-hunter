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
            '/api': 'http://localhost:8000',
        },
    },

    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
    },
});
