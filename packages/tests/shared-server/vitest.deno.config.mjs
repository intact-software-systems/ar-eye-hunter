import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

export default {
    resolve: {
        alias: {
            '@js-temporal/polyfill': `${repoRoot}/packages/tests/shared-server/deno-temporal-polyfill-shim.mjs`,
            '@shared-web': `${repoRoot}/packages/shared-web`,
            '@shared-server': `${repoRoot}/packages/shared-server`,
            '@shared': `${repoRoot}/packages/shared`,
            '@shared-graph': `${repoRoot}/packages/shared-graph`,
            '@shared-test': `${repoRoot}/packages/shared-test`,
            '@relic-hunters': `${repoRoot}/packages/relic-hunters`
        }
    },
    test: {
        environment: 'node',
        globals: true
    }
};
