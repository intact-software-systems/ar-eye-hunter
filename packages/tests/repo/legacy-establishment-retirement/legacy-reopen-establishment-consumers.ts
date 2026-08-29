/**
 * Slice 6a's removal worklist for the public `reopen-establishment` command.
 * Slice 8d removes these consumers with the route cutover; this inventory
 * does not delete, preserve, or redirect any of them.
 *
 * The companion test scans git-tracked files in both directions and compares
 * this table occurrence-for-occurrence. The worklist is exact for the listed
 * spellings outside its prose exclusions, not a proof that the later cutover
 * has completed.
 */
export const LEGACY_REOPEN_ESTABLISHMENT_TOKENS = [
    'GROUP_ESTABLISHMENT_REOPEN',
    'reopenGroupEstablishment',
    'ReopenGroupEstablishment',
    'reopen-group-establishment',
    'reopen-establishment',
    'lifecycle/reopen'
] as const;

export type LegacyReopenEstablishmentToken = (typeof LEGACY_REOPEN_ESTABLISHMENT_TOKENS)[number];

export interface LegacyReopenEstablishmentConsumer {
    readonly file: string;
    readonly occurrences: Partial<Record<LegacyReopenEstablishmentToken, number>>;
}

export const LEGACY_REOPEN_ESTABLISHMENT_CONSUMERS: readonly LegacyReopenEstablishmentConsumer[] = [
    { file: 'apps/api-v1/resources/api-v1-openapi.yaml', occurrences: { 'lifecycle/reopen': 1 } },
    { file: 'apps/api-v1/src/group-state/group-state-route-contracts.ts', occurrences: { 'reopen-group-establishment': 1 } },
    {
        file: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
        occurrences: { ReopenGroupEstablishment: 2, 'reopen-group-establishment': 1, 'lifecycle/reopen': 1 }
    },
    {
        file: 'apps/api-v1/src/group-state/to-group-state-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_REOPEN: 3, reopenGroupEstablishment: 1, ReopenGroupEstablishment: 2, 'reopen-group-establishment': 2 }
    },
    { file: 'apps/api-v1/test/admin-operations/routes/api-mutation-openapi-contract.test.ts', occurrences: { 'lifecycle/reopen': 1 } },
    { file: 'apps/api-v1/test/group-state/group-lifecycle-transition-routes.test.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 2, 'lifecycle/reopen': 1 } },
    { file: 'apps/api-v1/test/group-state/register-group-state-routes.test.ts', occurrences: { 'lifecycle/reopen': 1 } },
    { file: 'docs/rallar-group-formation-architecture.md', occurrences: { 'reopen-establishment': 4, 'lifecycle/reopen': 1 } },
    { file: 'packages/shared-server/rallar-system/app-inbox/app-inbox-contracts.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 2 } },
    { file: 'packages/shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 1, reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts', occurrences: { reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/decode-group-state-app-inbox-command.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 1, reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/decode-group-state-inbox-authority.ts', occurrences: { reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 2 } },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 3, reopenGroupEstablishment: 2 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-transition.ts', occurrences: { reopenGroupEstablishment: 1, 'reopen-establishment': 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts', occurrences: { reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts', occurrences: { reopenGroupEstablishment: 4 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts', occurrences: { reopenGroupEstablishment: 2 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts', occurrences: { reopenGroupEstablishment: 3 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts', occurrences: { reopenGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/to-lifecycle-mutation-command.ts', occurrences: { reopenGroupEstablishment: 2 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-lifecycle-transitions.json', occurrences: { 'lifecycle/reopen': 1 } },
    { file: 'packages/shared/api/group-lifecycle/group-lifecycle-transitions.ts', occurrences: { 'reopen-establishment': 3 } },
    { file: 'packages/shared/api/group-lifecycle/resolve-formation-stage-entry.ts', occurrences: { 'reopen-establishment': 1 } },
    { file: 'packages/shared/api/group-types.ts', occurrences: { 'reopen-establishment': 1 } },
    {
        file: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-owner-inventory.ts',
        occurrences: { GROUP_ESTABLISHMENT_REOPEN: 2, ReopenGroupEstablishment: 1, 'reopen-group-establishment': 1, 'lifecycle/reopen': 1 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/group-lifecycle-command-policy.test.ts', occurrences: { 'reopen-establishment': 2 } },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-descriptor-contract.test.ts',
        occurrences: { GROUP_ESTABLISHMENT_REOPEN: 1, reopenGroupEstablishment: 1 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-operation-matrix.test.ts', occurrences: { GROUP_ESTABLISHMENT_REOPEN: 2 } },
    { file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-lifecycle-mutation.test.ts', occurrences: { reopenGroupEstablishment: 2 } },
    { file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-mutation-request-validation.test.ts', occurrences: { reopenGroupEstablishment: 1 } },
    { file: 'packages/tests/shared-test/api-v1-recipe-idempotency-cutover.test.ts', occurrences: { 'lifecycle/reopen': 1 } },
    { file: 'packages/tests/shared/group-lifecycle-transitions.test.ts', occurrences: { 'reopen-establishment': 2 } }
];
