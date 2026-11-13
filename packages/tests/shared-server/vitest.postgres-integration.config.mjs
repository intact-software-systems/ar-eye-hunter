import bunVitestConfig from './vitest.bun.config.mjs';

const topologyConcurrencyDirectory = 'packages/tests/shared-server/rallar-system/topology/concurrency';
const topologyConcurrencyTests = [
    'postgres-topology-app-inbox-concurrency.test.ts',
    'postgres-topology-config-override-concurrency.test.ts',
    'postgres-topology-mutation-worker-concurrency.test.ts'
].map((filename) => `${topologyConcurrencyDirectory}/${filename}`);
const adminPrunePageTest = 'packages/tests/shared-server/rallar-system/admin-operations/prune/admin-prune-page-postgres.test.ts';

export default {
    ...bunVitestConfig,
    test: {
        ...bunVitestConfig.test,
        include: [
            'packages/tests/shared-server/integration/postgres/*.test.ts',
            'packages/tests/shared-server/integration/postgres/test-support/*.test.ts',
            adminPrunePageTest,
            'packages/tests/shared-server/runtime-state/runtime-state-exact-predecessor.test.ts',
            'packages/tests/shared-server/rallar-system/view-watch/tournament-view-watch.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/move/group-move-service.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/move/group-move-storage.test.ts',
            'packages/tests/shared-server/rallar-system/view-watch/view-watch-authority-incarnation.test.ts',
            'packages/tests/shared-server/rallar-system/view-watch/view-watch-registration.test.ts',
            'packages/tests/shared-server/rallar-system/tournaments/tournament-service.test.ts',
            'packages/tests/shared-server/rallar-system/matchmaking/*.test.ts',
            'packages/tests/shared-server/queuebox/resource-inbox-topic-selection.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/mutation/group-connect-trigger-sql.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/persistence/group-publication-grant-sql.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/schedule/group-session-database.test.ts',
            'packages/tests/relic-hunters/relic-scheduled-start.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/persistence/group-topic-subscription-sql.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-concurrency.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-inbox.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-pages.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-deletion.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retention-summary-deletion.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-identity.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-owned-data.test.ts',
            'packages/tests/shared-server/rallar-system/group-state/retention/group-retirement-stale-writers.test.ts',
            'packages/tests/shared-server/app-data/room-owned-app-data.test.ts',
            'packages/tests/ar-eye-hunter/server/tournament-mutation.test.ts',
            'packages/tests/shared-server/rallar-server/rallar-server-app-inbox.test.ts',
            'packages/tests/shared-server/rallar-server/server-counter-example.test.ts',
            'packages/tests/relic-hunters/relic-game-authorization.test.ts',
            'packages/tests/relic-hunters/relic-game-inbox.test.ts',
            'packages/tests/relic-hunters/relic-game-public-app-inbox.test.ts',
            'packages/tests/relic-hunters/relic-game-mutation.test.ts',
            'packages/tests/relic-hunters/relic-game-publication.test.ts',
            'packages/tests/relic-hunters/relic-game-retention.test.ts',
            'packages/tests/shared-server/rallar-system/topology/replay/work/rtc-topology-coalesced-head-retention.test.ts',
            ...topologyConcurrencyTests
        ]
    }
};
