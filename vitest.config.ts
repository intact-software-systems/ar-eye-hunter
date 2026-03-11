import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
    resolve: {
        alias: {
            '@shared-web': path.resolve(__dirname, 'packages/shared-web'),
            '@shared': path.resolve(__dirname, 'packages/shared'),
            '@shared-graph': path.resolve(__dirname, 'packages/shared-graph'),
        },
    },

    test: {
        include: ['packages/tests/**/*.test.ts'],
        exclude: ['packages/tests/dummy.test.ts'],
        environment: 'node',
        globals: true,
        setupFiles: ['packages/tests/setup-vitest.ts'],
    },
});
