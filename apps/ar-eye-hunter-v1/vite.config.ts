import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
    plugins: [react()],
    envPrefix: ['VITE_', 'API_'],
    resolve: {
        alias: {
            '@shared-web': path.resolve(__dirname, '../../packages/shared-web'),
            '@shared-graph': path.resolve(__dirname, '../../packages/shared-graph'),
            '@shared': path.resolve(__dirname, '../../packages/shared')
        }
    },
    server: {
        port: 5174,
        strictPort: true,
        proxy: {
            '/api': {
                target: 'http://localhost:8080',
                changeOrigin: true,
                ws: true
            }
        }
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023'
    }
});
