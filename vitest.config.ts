import path from 'node:path';
import { defineConfig } from 'vitest/config';

process.chdir(__dirname);

const SUITE_TESTS = [
    'packages/tests/**/*.test.ts',
    'packages/shared-rtc-bench/tests/**/*.test.ts',
    'apps/relic-hunters-v1/tests/**/*.test.ts',
    'tests/unit/**/*.test.ts'
];
const EXCLUDED_TESTS = [
    'packages/tests/shared-server/integration/**',
    'packages/tests/shared-test/scenario-black-box-rtc-config.test.ts',
    'packages/tests/shared-test/rtc-client-provider/**'
];
// Benchmark-evidence and repository tooling tests hold about two thirds of the suite's run time, so
// the Release Gate runs them in a lane of their own. `vitest run` without --project still runs both.
const TOOLING_TESTS = [
    'packages/tests/shared-server/performance/**/*.test.ts',
    'packages/tests/repo/**/*.test.ts',
    'packages/tests/hetzner/**/*.test.ts'
];

export default defineConfig({
    root: __dirname,
    resolve: {
        alias: {
            '@shared-web': path.resolve(__dirname, 'packages/shared-web'),
            '@shared-server': path.resolve(__dirname, 'packages/shared-server'),
            '@shared': path.resolve(__dirname, 'packages/shared'),
            '@shared-graph': path.resolve(__dirname, 'packages/shared-graph'),
            '@shared-test': path.resolve(__dirname, 'packages/shared-test'),
            '@relic-hunters': path.resolve(__dirname, 'packages/relic-hunters')
        }
    },

    test: {
        environment: 'node',
        globals: true,
        setupFiles: ['packages/tests/setup-vitest.ts'],
        projects: [
            {
                extends: true,
                test: { name: 'tooling', include: TOOLING_TESTS, exclude: EXCLUDED_TESTS }
            },
            {
                extends: true,
                test: { name: 'unit', include: SUITE_TESTS, exclude: [...EXCLUDED_TESTS, ...TOOLING_TESTS] }
            }
        ]
    }
});
