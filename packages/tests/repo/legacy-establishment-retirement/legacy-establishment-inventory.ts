import path from 'node:path';

/**
 * Slice 5d's inventory of every `start-establishment` consumer slice 8d
 * removes in the atomic route cutover (product decision 34). Nothing is
 * retired here — I8 keeps route mounting and removal to one cutover, so this
 * slice only makes that cutover mechanical and complete.
 *
 * The companion test recomputes every field from the tree, so a new caller
 * cannot appear, and a surface cannot disappear early, without failing.
 */

export const LEGACY_ESTABLISHMENT_ROUTE_PATH_SEGMENT = 'lifecycle/establish/requests';

export const LEGACY_ESTABLISHMENT_RECIPE_ROOT = path.join(
    'packages',
    'shared-test',
    'black-box-runner',
    'tests',
    'api-v1'
);

export interface LegacyEstablishmentRecipeSite {
    /** File name inside `LEGACY_ESTABLISHMENT_RECIPE_ROOT`. */
    readonly recipe: string;
    /** The request id the call site posts to, templates included. */
    readonly requestIdTemplate: string;
}

export const LEGACY_ESTABLISHMENT_RECIPE_SITES: readonly LegacyEstablishmentRecipeSite[] = [
    {
        recipe: 'api-v1-drop-in-social-preset.json',
        requestIdTemplate: 'establish-drop-in-denied-{runId}'
    },
    {
        recipe: 'api-v1-group-admission-approval.json',
        requestIdTemplate: 'establish-epoch-{runId}'
    },
    {
        recipe: 'api-v1-group-admission-windows.json',
        requestIdTemplate: 'establish-closed-{runId}'
    },
    {
        recipe: 'api-v1-group-admission-windows.json',
        requestIdTemplate: 'establish-reopen-{runId}'
    },
    {
        recipe: 'api-v1-group-data-policy.json',
        requestIdTemplate: 'establish-data-policy-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-criterion.json',
        requestIdTemplate: 'establish-auto-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-criterion.json',
        requestIdTemplate: 'establish-deadline-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-criterion.json',
        requestIdTemplate: 'establish-threshold-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-criterion.json',
        requestIdTemplate: 'establish-degraded-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-managed-burst-large.json',
        requestIdTemplate: 'establish-large-{groupId}-{runId}'
    },
    {
        recipe: 'api-v1-group-formation-managed-burst-medium.json',
        requestIdTemplate: 'establish-{groupId}-{runId}'
    },
    {
        recipe: 'api-v1-group-lifecycle-transitions.json',
        requestIdTemplate: 'bob-start-{runId}'
    },
    {
        recipe: 'api-v1-group-lifecycle-transitions.json',
        requestIdTemplate: 'start-establishment-{runId}'
    },
    {
        recipe: 'api-v1-group-lifecycle-transitions.json',
        requestIdTemplate: 'start-from-active-{runId}'
    },
    {
        recipe: 'api-v1-group-manager-succession.json',
        requestIdTemplate: 'establish-bob-denied-{runId}'
    },
    {
        recipe: 'api-v1-group-manager-succession.json',
        requestIdTemplate: 'establish-alice-{runId}'
    },
    {
        recipe: 'api-v1-group-manager-succession.json',
        requestIdTemplate: 'establish-leave-twin-{runId}'
    },
    {
        recipe: 'api-v1-group-manager-succession.json',
        requestIdTemplate: 'establish-zero-connecting-{runId}'
    },
    {
        recipe: 'api-v1-group-manager-succession.json',
        requestIdTemplate: 'establish-zero-denied-{runId}'
    },
    {
        recipe: 'api-v1-match-preset.json',
        requestIdTemplate: 'establish-match-lobby-{runId}'
    },
    {
        recipe: 'api-v1-match-preset.json',
        requestIdTemplate: 'establish-match-arena-{runId}'
    }
];

export interface LegacyEstablishmentRecipeEpochAssertions {
    readonly recipe: string;
    readonly formationEpochAssertions: number;
}

/**
 * The cutover's real cost, per recipe rather than per call site. One
 * `establish` POST advances the formation epoch once; its replacement is
 * `plan` (forming -> planned) plus `connect` (planned -> connecting), which
 * advance it twice, so every assertion below shifts when the site above it
 * is rewritten.
 */
export const LEGACY_ESTABLISHMENT_RECIPE_EPOCH_ASSERTIONS: readonly LegacyEstablishmentRecipeEpochAssertions[] = [
    { recipe: 'api-v1-drop-in-social-preset.json', formationEpochAssertions: 1 },
    { recipe: 'api-v1-group-admission-approval.json', formationEpochAssertions: 5 },
    { recipe: 'api-v1-group-admission-windows.json', formationEpochAssertions: 6 },
    { recipe: 'api-v1-group-data-policy.json', formationEpochAssertions: 2 },
    { recipe: 'api-v1-group-formation-criterion.json', formationEpochAssertions: 11 },
    { recipe: 'api-v1-group-formation-managed-burst-large.json', formationEpochAssertions: 2 },
    { recipe: 'api-v1-group-formation-managed-burst-medium.json', formationEpochAssertions: 2 },
    { recipe: 'api-v1-group-lifecycle-transitions.json', formationEpochAssertions: 8 },
    { recipe: 'api-v1-group-manager-succession.json', formationEpochAssertions: 6 },
    { recipe: 'api-v1-match-preset.json', formationEpochAssertions: 4 }
];

export interface LegacyEstablishmentSurface {
    /** Repository-relative path. */
    readonly file: string;
    /** Text that proves the surface is still present. */
    readonly marker: string;
    /** What the cutover does with it. */
    readonly disposition: 'remove' | 'rewrite';
}

/**
 * The non-recipe surfaces. `remove` disappears with the command; `rewrite`
 * survives the cutover with its legacy entry replaced by the new commands.
 */
export const LEGACY_ESTABLISHMENT_SURFACES: readonly LegacyEstablishmentSurface[] = [
    {
        file: 'apps/api-v1/src/group-state/register-group-state-mutation-routes.ts',
        marker: 'lifecycle/establish/requests/:requestId',
        disposition: 'remove'
    },
    {
        file: 'apps/api-v1/src/group-state/to-group-state-command.ts',
        marker: 'case \'start-group-establishment\':',
        disposition: 'remove'
    },
    {
        file: 'apps/api-v1/resources/api-v1-openapi.yaml',
        marker: 'lifecycle/establish/requests/{requestId}',
        disposition: 'remove'
    },
    {
        file: 'packages/shared-server/rallar-system/app-inbox/app-inbox-contracts.ts',
        marker: 'GROUP_ESTABLISHMENT_START',
        disposition: 'remove'
    },
    {
        file: 'packages/shared-server/rallar-system/group-state/mutation/group-mutation-contracts.ts',
        marker: 'startGroupEstablishment',
        disposition: 'remove'
    },
    {
        file: 'packages/shared/api/group-lifecycle/group-lifecycle-transitions.ts',
        marker: '\'start-establishment\'',
        disposition: 'remove'
    },
    {
        file: 'packages/tests/repo/mutation-route-ownership/routing/mutation-routing-owner-inventory.ts',
        marker: 'type: \'GROUP_ESTABLISHMENT_START\'',
        disposition: 'rewrite'
    },
    {
        file: 'apps/api-v1/test/group-state/register-group-state-routes.test.ts',
        marker: 'lifecycle/establish/requests',
        disposition: 'rewrite'
    },
    {
        file: 'apps/api-v1/test/group-state/group-lifecycle-transition-routes.test.ts',
        // Posts to the family base path, not the request-scoped one.
        marker: 'lifecycle/establish',
        disposition: 'rewrite'
    },
    {
        file: 'apps/api-v1/test/admin-operations/routes/api-mutation-openapi-contract.test.ts',
        // Composes the path from constants, so the literal stops at the family.
        marker: 'lifecycle/establish',
        disposition: 'rewrite'
    },
    {
        file: 'packages/tests/shared-test/api-v1-recipe-idempotency-cutover.test.ts',
        marker: 'lifecycle/establish',
        disposition: 'rewrite'
    },
    {
        file: 'docs/rallar-group-formation-architecture.md',
        marker: '`start-establishment`',
        disposition: 'rewrite'
    }
];
