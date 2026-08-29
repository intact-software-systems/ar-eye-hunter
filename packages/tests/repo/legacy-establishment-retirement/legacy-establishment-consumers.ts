/**
 * Slice 5d's inventory of every `start-establishment` consumer slice 8d
 * removes in the atomic route cutover (product decision 34). Nothing is
 * retired here: 8d's entry says "No earlier slice removes them", 6a's says
 * "Nothing leaves before the route cutover", and slice 9 verifies removal
 * only after both inventories exist.
 *
 * This table is a REMOVAL WORKLIST, never an approval to keep anything.
 * Product decision 14 forbids retaining the command, and the sanctioned
 * channel for retained production legacy is
 * `docs/production-legacy-exceptions.md`, which holds no entry for it — a
 * fact the companion test asserts, so listing a consumer here can never read
 * as blessing it.
 *
 * **What the companion test does and does not guarantee.** It recomputes this
 * whole table from the tree and compares it wholesale, so a declared entry
 * cannot be dropped and an undeclared consumer cannot appear. That guarantee
 * is exact *for the tokens below, over git-tracked files, outside the
 * excluded prefixes* — a consumer reached by some other spelling, or living
 * in an uncommitted file, is still invisible. Nothing here proves the cutover
 * is complete either: 8d could delete a call site and edit the count to
 * match. Proving the command is gone everywhere is slice 9's job.
 *
 * The first draft of this inventory hand-authored its list of twelve files
 * and checked only that each still existed. That is why it was incomplete —
 * not the choice of marker, since two of its markers do occur in the retry
 * producer it lost. The cure is the converse scan below, which no hand-
 * authored list can survive being wrong about.
 */

/** Every spelling that names the command itself. */
const LEGACY_ESTABLISHMENT_COMMAND_TOKENS = [
    'GROUP_ESTABLISHMENT_START',
    'startGroupEstablishment',
    'StartGroupEstablishment',
    'start-group-establishment',
    'start-establishment',
    'lifecycle/establish'
] as const;

/**
 * The automatic retry leg, which product decision 34 re-expresses as `plan`
 * plus the connect trigger. Its producer names no route and its scheduler
 * names no command, so both reach the cutover only through these spellings.
 */
const LEGACY_ESTABLISHMENT_RETRY_TOKENS = [
    'toFormationRetryEstablishCommand',
    'retry-establish',
    'GroupFormationTimerWork',
    'computeFormationRetryBackoffMs',
    'computeFormationTimerEntries'
] as const;

export const LEGACY_ESTABLISHMENT_TOKENS = [
    ...LEGACY_ESTABLISHMENT_COMMAND_TOKENS,
    ...LEGACY_ESTABLISHMENT_RETRY_TOKENS
] as const;

export type LegacyEstablishmentToken = (typeof LEGACY_ESTABLISHMENT_TOKENS)[number];

/**
 * Prose roots. They describe the retirement rather than consume the command,
 * and 8d removes nothing in them, so an unrelated write-up mentioning the
 * command must not fail this test.
 */
export const LEGACY_ESTABLISHMENT_EXCLUDED_PREFIXES = [
    'playground/',
    'plans/',
    '.agents/',
    '.superpowers/',
    'docs/superpowers/',
    'projects/'
] as const;

/** This inventory's own files necessarily carry every token. */
export const LEGACY_ESTABLISHMENT_SELF_PATH = 'legacy-establishment-retirement';

/** The sanctioned channel for retained production legacy; this command is not on it. */
export const PRODUCTION_LEGACY_EXCEPTION_REGISTRY = 'docs/production-legacy-exceptions.md';

export interface LegacyEstablishmentConsumer {
    /** Repository-relative path. */
    readonly file: string;
    /**
     * Occurrences per token, omitting tokens the file does not carry. These
     * count token hits, not removal scope: one hit can stand for a ninety-line
     * OpenAPI block, and a registrar body carries none of its own.
     */
    readonly occurrences: Partial<Record<LegacyEstablishmentToken, number>>;
}

export const LEGACY_ESTABLISHMENT_CONSUMERS: readonly LegacyEstablishmentConsumer[] = [
    { file: 'apps/api-v1/resources/api-v1-openapi.yaml', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/src/group-state/group-state-route-contracts.ts', occurrences: { 'start-group-establishment': 1 } },
    {
        file: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
        occurrences: { StartGroupEstablishment: 2, 'start-group-establishment': 1, 'lifecycle/establish': 1 }
    },
    {
        file: 'apps/api-v1/src/group-state/to-group-state-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 3, startGroupEstablishment: 1, StartGroupEstablishment: 2, 'start-group-establishment': 2 }
    },
    { file: 'apps/api-v1/test/admin-operations/routes/api-mutation-openapi-contract.test.ts', occurrences: { 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/test/group-state/group-lifecycle-transition-routes.test.ts', occurrences: { GROUP_ESTABLISHMENT_START: 2, 'lifecycle/establish': 1 } },
    { file: 'apps/api-v1/test/group-state/register-group-state-routes.test.ts', occurrences: { 'lifecycle/establish': 1 } },
    {
        file: 'docs/rallar-group-formation-architecture.md',
        occurrences: {
            startGroupEstablishment: 3,
            'start-establishment': 7,
            'lifecycle/establish': 1,
            'retry-establish': 1,
            computeFormationRetryBackoffMs: 1,
            computeFormationTimerEntries: 1
        }
    },
    { file: 'packages/shared-server/rallar-system/app-inbox/app-inbox-contracts.ts', occurrences: { GROUP_ESTABLISHMENT_START: 2 } },
    {
        file: 'packages/shared-server/rallar-system/app-inbox/logical-app-inbox-command.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1, startGroupEstablishment: 1 }
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/formation-timer-outbox-entry.ts',
        occurrences: { GroupFormationTimerWork: 4, computeFormationRetryBackoffMs: 2, computeFormationTimerEntries: 1 }
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
        occurrences: { startGroupEstablishment: 1, 'start-establishment': 1, computeFormationTimerEntries: 2 }
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
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/result-validation/validate-computed-group-mutation-outbox.ts',
        occurrences: { computeFormationTimerEntries: 2 }
    },
    { file: 'packages/shared-server/rallar-system/group-state/to-lifecycle-mutation-command.ts', occurrences: { startGroupEstablishment: 2 } },
    {
        file: 'packages/shared-server/rallar-system/topology/replay/work/create-formation-timer-work-handler.ts',
        occurrences: { toFormationRetryEstablishCommand: 2, GroupFormationTimerWork: 2 }
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
    { file: 'packages/shared/api/group-lifecycle/evaluate-group-activation-criterion.ts', occurrences: { computeFormationRetryBackoffMs: 1 } },
    { file: 'packages/shared/api/group-lifecycle/group-lifecycle-transitions.ts', occurrences: { 'start-establishment': 3 } },
    { file: 'packages/shared/api/group-lifecycle/resolve-formation-stage-entry.ts', occurrences: { 'start-establishment': 1 } },
    { file: 'packages/shared/api/group-types.ts', occurrences: { 'start-establishment': 1 } },
    {
        file: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-owner-inventory.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 2, StartGroupEstablishment: 1, 'start-group-establishment': 1, 'lifecycle/establish': 1 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/group-lifecycle-command-policy.test.ts', occurrences: { 'start-establishment': 1 } },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-descriptor-contract.test.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 1, startGroupEstablishment: 1 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/inbox/group-state-inbox-operation-matrix.test.ts',
        occurrences: { GROUP_ESTABLISHMENT_START: 2 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-formation-fence-authority.test.ts',
        occurrences: { startGroupEstablishment: 2, toFormationRetryEstablishCommand: 4, 'retry-establish': 1 }
    },
    {
        file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-formation-fence-service-read.test.ts',
        occurrences: { toFormationRetryEstablishCommand: 2 }
    },
    { file: 'packages/tests/shared-server/rallar-system/group-state/mutation/group-lifecycle-mutation.test.ts', occurrences: { startGroupEstablishment: 6 } },
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
    { file: 'packages/tests/shared/group-activation-criterion.test.ts', occurrences: { computeFormationRetryBackoffMs: 5 } },
    { file: 'packages/tests/shared/group-lifecycle-transitions.test.ts', occurrences: { 'start-establishment': 2 } }
];
