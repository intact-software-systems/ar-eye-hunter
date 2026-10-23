import denoVitestConfig from './vitest.deno.config.mjs';

const topologyConcurrencyDirectory = 'packages/tests/shared-server/rallar-system/topology/concurrency';
const topologyConcurrencyTests = [
    'postgres-topology-app-inbox-concurrency.test.ts',
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
            'packages/tests/shared-server/integration/postgres/test-support/*.test.ts',
            adminPrunePageTest,
            'packages/tests/shared-server/rallar-system/group-state/mutation/group-connect-trigger-sql.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-concurrency.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-inbox.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-pages.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-deletion.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-summary-deletion.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-identity.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-owned-data.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-stale-writers.test.ts',
            'packages/tests/shared-server/app-data/room-owned-app-data.test.ts',
            'packages/tests/relic-hunters/relic-game-authorization.test.ts',
            'packages/tests/relic-hunters/relic-game-inbox.test.ts',
            'packages/tests/relic-hunters/relic-game-mutation.test.ts',
            'packages/tests/relic-hunters/relic-game-publication.test.ts',
            'packages/tests/relic-hunters/relic-game-retention.test.ts',
            'packages/tests/shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-head-retention.test.ts',
            ...topologyConcurrencyTests
        ]
    }
};
