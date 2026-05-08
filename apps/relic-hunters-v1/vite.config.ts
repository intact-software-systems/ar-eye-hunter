import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

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
        rolldownOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('@babylonjs/core')) return 'babylon';
                    if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
                        return 'react';
                    }
                },
            },
        },
    },
});