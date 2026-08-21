import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
    base: '/headless/',
    envDir: path.resolve(__dirname, '../..'),
    envPrefix: ['VITE_'],
    resolve: {
        alias: {
            '@shared-test': path.resolve(__dirname, '../../packages/shared-test'),
            '@shared-web': path.resolve(__dirname, '../../packages/shared-web'),
            '@shared-server': path.resolve(__dirname, '../../packages/shared-server'),
            '@shared-graph': path.resolve(__dirname, '../../packages/shared-graph'),
            '@shared': path.resolve(__dirname, '../../packages/shared')
        }
    },
    server: {
        port: 5179,
        strictPort: true
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023'
    }
});
