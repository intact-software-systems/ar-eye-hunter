import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            '@relic-hunters': path.resolve(__dirname, '../../packages/relic-hunters'),
            '@shared-web': path.resolve(__dirname, '../../packages/shared-web'),
            '@shared-server': path.resolve(__dirname, '../../packages/shared-server'),
            '@shared-graph': path.resolve(__dirname, '../../packages/shared-graph'),
            '@shared': path.resolve(__dirname, '../../packages/shared'),
        },
    },
    server: {
        port: 5175,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8090',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023',
        rollupOptions: {
            output: {
                manualChunks: {
                    babylon: ['@babylonjs/core'],
                    react: ['react', 'react-dom'],
                },
            },
        },
    },
});
