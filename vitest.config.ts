import { defineConfig } from 'vitest/config';
import path from 'node:path'

export default defineConfig({
    resolve: {
        alias: {
            '@shared': path.resolve(__dirname, 'packages/shared')
        }
    },

    test: {
        include: ['packages/tests/**/*.test.ts'],
        environment: 'node',
        globals: true
    }
});
