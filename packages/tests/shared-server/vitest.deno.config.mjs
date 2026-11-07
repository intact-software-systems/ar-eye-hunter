import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default {
    resolve: {
        alias: {
            '@shared-web': `${repoRoot}/packages/shared-web`,
            '@shared-server': `${repoRoot}/packages/shared-server`,
            '@shared': `${repoRoot}/packages/shared`,
            '@shared-graph': `${repoRoot}/packages/shared-graph`,
            '@shared-test': `${repoRoot}/packages/shared-test`,
            '@ar-eye-hunter': `${repoRoot}/packages/ar-eye-hunter`,
            '@relic-hunters': `${repoRoot}/packages/relic-hunters`
        }
    },
    test: {
        environment: 'node',
        globals: true,
        setupFiles: [`${repoRoot}/packages/tests/setup-vitest.ts`]
    }
};
