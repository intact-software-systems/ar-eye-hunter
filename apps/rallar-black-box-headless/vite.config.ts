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
        strictPort: true,
        // The full-stack lane drives long-lived agent pages that a hot-reload would strand mid-run.
        hmr: ['1', 'true'].includes(process.env.RALLAR_BLACK_BOX_FULL_STACK ?? '') ? false : undefined
    },
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2023'
    }
});
