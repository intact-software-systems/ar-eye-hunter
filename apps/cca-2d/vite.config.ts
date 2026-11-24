import { readFileSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';

const certificatePath = process.env.CCA_TLS_CERT;
const keyPath = process.env.CCA_TLS_KEY;
if (Boolean(certificatePath) !== Boolean(keyPath)) {
    throw new Error('Set both CCA_TLS_CERT and CCA_TLS_KEY to enable HTTPS.');
}

export default defineConfig({
    resolve: {
        alias: {
            '@shared-web': path.resolve(import.meta.dirname, '../../packages/shared-web'),
            '@shared-graph': path.resolve(import.meta.dirname, '../../packages/shared-graph'),
            '@shared': path.resolve(import.meta.dirname, '../../packages/shared')
        }
    },
    server: {
        port: 5180,
        strictPort: true,
        https: certificatePath && keyPath
            ? { cert: readFileSync(certificatePath), key: readFileSync(keyPath) }
            : undefined,
        proxy: {
            '/api': {
                target: process.env.CCA_RALLAR_PROXY_TARGET || 'http://127.0.0.1:8084',
                changeOrigin: true,
                ws: true
            }
        }
    },
    build: { target: 'es2023' }
});
