import denoVitestConfig from './vitest.deno.config.mjs';

const topologyConcurrencyDirectory = 'packages/tests/shared-server/rallar-system/topology/concurrency';
const topologyConcurrencyTests = [
    'postgres-topology-config-override-concurrency.test.ts',
    'postgres-topology-mutation-worker-concurrency.test.ts'
].map((filename) => `${topologyConcurrencyDirectory}/${filename}`);
const adminPrunePageTest = 'packages/tests/shared-server/rallar-system/admin-operations/prune/admin-prune-page-postgres.test.ts';

export default {
    ...denoVitestConfig,
    test: {
        ...denoVitestConfig.test,
        include: [
            'packages/tests/shared-server/integration/postgres/*.test.ts',
            adminPrunePageTest,
            ...topologyConcurrencyTests
        ]
    }
};
