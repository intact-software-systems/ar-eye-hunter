/**
 * Slice 5d's inventory of every `start-establishment` consumer slice 8d
 * removes in the atomic route cutover (product decision 34). Nothing is
 * retired here: 8d's entry says "No earlier slice removes them", 6a's says
 * "Nothing leaves before the route cutover", and slice 9 verifies removal
 * only after both inventories exist. This slice makes that cutover
 * mechanical by making the worklist impossible to under-declare.
 *
 * The companion test recomputes this whole table from the tree and compares
 * it wholesale, in both directions. A consumer that is added, removed, or
 * that gains or loses an occurrence fails the test until it is declared, so
 * the inventory cannot silently drift out of date before 8d reads it.
 *
 * The first draft of this inventory keyed on the route path alone and missed
 * the command's internal producer, which never mentions a route. Hence the
 * token set below rather than a single marker per file.
 */

/** Every spelling a `start-establishment` consumer can carry. */
export const LEGACY_ESTABLISHMENT_TOKENS = [
    'GROUP_ESTABLISHMENT_START',
    'startGroupEstablishment',
    'start-group-establishment',
    'start-establishment',
    'lifecycle/establish',
    // The internal producer and its command-id vocabulary. The retry leg
    // reaches the command through these and names no route, which is how the
    // first draft of this inventory lost it.
    'toFormationRetryEstablishCommand',
    'retry-establish'
] as const;

export type LegacyEstablishmentToken = (typeof LEGACY_ESTABLISHMENT_TOKENS)[number];

/**
 * `playground/**` is excluded by the scan: the design documents describe the
 * retirement rather than consume the command, and 8d removes no prose there.
 */
export const LEGACY_ESTABLISHMENT_EXCLUDED_PREFIX = 'playground/';

export interface LegacyEstablishmentConsumer {
    /** Repository-relative path. */
    readonly file: string;
    /** Occurrences per token, omitting tokens the file does not carry. */
    readonly occurrences: Partial<Record<LegacyEstablishmentToken, number>>;
}

export const LEGACY_ESTABLISHMENT_CONSUMERS: readonly LegacyEstablishmentConsumer[] = [
    { file: 'apps/api-v1/resources/api-v1-openapi.yaml', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/src/group-state/group-state-route-contracts.ts', occurrences: { 'start-group-establishment': 1 } },
    { file: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts', occurrences: { 'start-group-establishment': 1, 'lifecycle/establish': 1 } },
    {
        file: 'apps/api-v1/src/group-state/to-group-state-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 3, startGroupEstablishment: 1, 'start-group-establishment': 2 }
    },
    { file: 'apps/api-v1/test/admin-operations/routes/api-mutation-openapi-contract.test.ts', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/test/group-state/group-lifecycle-transition-routes.test.ts', occurrences: { GROUP_ESTABLISHMENT_START: 2, 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/test/group-state/register-group-state-routes.test.ts', occurrences: { 'lifecycle/establish': 1 } },
    {
        file: 'docs/rallar-group-formation-architecture.md',
        occurrences: { startGroupEstablishment: 3, 'start-establishment': 7, 'lifecycle/establish': 1, 'retry-establish': 1 }
    },
    { file: 'packages/shared-server/rallar-system/app-inbox/app-inbox-contracts.ts', occurrences: { GROUP_ESTABLISHMENT_START: 2 } },
    {
        file: 'packages/shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1, startGroupEstablishment: 1 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/group-formation-mutation-command.ts',
        occurrences: { startGroupEstablishment: 1, 'start-establishment': 1, toFormationRetryEstablishCommand: 1, 'retry-establish': 2 }
    },
    { file: 'packages/shared-server/rallar-system/group-state/group-mutation-authority.ts', occurrences: { startGroupEstablishment: 1 } },
    {
        file: 'packages/shared-server/rallar-system/group-state/inbox/decode-group-state-app-inbox-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1, startGroupEstablishment: 1 }
    },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/decode-group-state-inbox-authority.ts', occurrences: { startGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/inbox/group-state-inbox-contracts.ts', occurrences: { GROUP_ESTABLISHMENT_START: 2 } },
    {
        file: 'packages/shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 3, startGroupEstablishment: 2 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/aggregate/compute-lifecycle-transition.ts',
        occurrences: { startGroupEstablishment: 1, 'start-establishment': 1 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/group-mutation-request-validation.ts',
        occurrences: { startGroupEstablishment: 1 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-authority.ts',
        occurrences: { startGroupEstablishment: 1 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-command.ts',
        occurrences: { startGroupEstablishment: 4 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/command-validation/validate-group-mutation-operation-input.ts',
        occurrences: { startGroupEstablishment: 2 }
    },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts', occurrences: { startGroupEstablishment: 3 } },
    { file: 'packages/shared-server/rallar-system/group-state/mutation/orchestration/compute-group-mutation.ts', occurrences: { startGroupEstablishment: 1 } },
    { file: 'packages/shared-server/rallar-system/group-state/to-lifecycle-mutation-command.ts', occurrences: { startGroupEstablishment: 2 } },
    {
        file: 'packages/shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts',
        occurrences: { toFormationRetryEstablishCommand: 2 }
    },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-drop-in-social-preset.json', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-admission-approval.json', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-admission-windows.json', occurrences: { 'lifecycle/establish': 2 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-data-policy.json', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-formation-criterion.json', occurrences: { 'lifecycle/establish': 4 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-formation-managed-burst-large.json', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-formation-managed-burst-medium.json', occurrences: { 'lifecycle/establish': 1 } },
    {
        file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-lifecycle-transitions.json',
        occurrences: { 'start-establishment': 1, 'lifecycle/establish': 3 }
    },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-group-manager-succession.json', occurrences: { 'lifecycle/establish': 5 } },
    { file: 'packages/shared-test/black-box-runner/tests/api-v1/api-v1-match-preset.json', occurrences: { 'lifecycle/establish': 2 } },
    { file: 'packages/shared/api/group-lifecycle/group-lifecycle-transitions.ts', occurrences: { 'start-establishment': 3 } },
    { file: 'packages/shared/api/group-lifecycle/resolve-formation-stage-entry.ts', occurrences: { 'start-establishment': 1 } },
    { file: 'packages/shared/api/group-types.ts', occurrences: { 'start-establishment': 1 } },
    {
        file: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-owner-inventory.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 2, 'start-group-establishment': 1, 'lifecycle/establish': 1 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/group-lifecycle-command-policy.test.ts', occurrences: { 'start-establishment': 1 } },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-descriptor-contract.test.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1, startGroupEstablishment: 1 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-operation-matrix.test.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-formation-fence-authority.test.ts',
        occurrences: { startGroupEstablishment: 2, toFormationRetryEstablishCommand: 4, 'retry-establish': 1 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-formation-fence-service-read.test.ts',
        occurrences: { toFormationRetryEstablishCommand: 2 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-lifecycle-mutation.test.ts', occurrences: { startGroupEstablishment: 7 } },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-mutation-request-validation.test.ts',
        occurrences: { startGroupEstablishment: 1 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/policy/group-policy.test.ts', occurrences: { 'start-establishment': 2 } },
    {
        file: 'packages/tests/shared-server/rallar-system/topology/replay/work/formation-timer-work-handler.test.ts',
        occurrences: { startGroupEstablishment: 1 }
    },
    { file: 'packages/tests/shared-test/api-v1-recipe-idempotency-cutover.test.ts', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'packages/tests/shared/group-lifecycle-transitions.test.ts', occurrences: { 'start-establishment': 2 } }
];
