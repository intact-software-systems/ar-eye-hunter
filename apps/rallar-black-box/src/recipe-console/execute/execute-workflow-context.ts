import type { ControlDistributedRunSnapshot } from '@shared-test/rallar-bb-test/control-snapshots.ts';
import type { RallarBlackBoxTestRecipe } from '@shared-test/rallar-bb-test/types.ts';
import type { RecipeConsoleControlConnection } from '../control/ControlConnectionProvider.tsx';
import type { ExecuteConnectionTruth } from './execute-action-policy.ts';
import type { ExecuteTargetSelection } from './execute-workflow-state.ts';

export function executeTruthContextKey(
    input: Readonly<{
        baseUrl: string;
        controlRunId?: string;
    }>
): string {
    return JSON.stringify({
        baseUrl: input.baseUrl.trim().replace(/\/+$/, ''),
        controlRunId: input.controlRunId
    });
}

export function executeOperationContextKey(
    truthContextKey: string,
    manifestFingerprint: string
): string {
    return JSON.stringify({ truthContextKey, fingerprint: manifestFingerprint });
}

export function executeConnectionTruth(
    connection: RecipeConsoleControlConnection
): ExecuteConnectionTruth {
    if (connection.query.lastError?.credentialTrustRequired === true) {
        return 'credential-trust';
    }
    if (
        connection.query.status === 'offline' &&
        connection.query.authorization === 'required'
    ) {
        return 'auth-required';
    }
    if (
        connection.query.status === 'offline' &&
        connection.query.reachability === 'reachable'
    ) {
        return 'error';
    }
    return connection.query.status;
}

export function manifestRecipeIds(
    manifest: ControlDistributedRunSnapshot['manifest']
): readonly string[] {
    return [
        ...new Set(
            manifest.recipes.map((selection) => selection.recipeId ?? selection.recipe?.recipeId).filter((
                value
            ): value is string => Boolean(value))
        )
    ].sort();
}

export function singleRunRecipeId(
    run: ControlDistributedRunSnapshot | undefined
): string | undefined {
    const recipeIds = run ? manifestRecipeIds(run.manifest) : [];
    return recipeIds.length === 1 ? recipeIds[0] : undefined;
}

export function singleRunRecipe(
    run: ControlDistributedRunSnapshot | undefined
): RallarBlackBoxTestRecipe | undefined {
    const recipes = (run?.manifest.recipes ?? [])
        .map((selection) => selection.recipe)
        .filter((recipe): recipe is RallarBlackBoxTestRecipe => recipe !== undefined);
    return recipes.length === 1 ? recipes[0] : undefined;
}

export function authoritativeTargetIds(
    run: ControlDistributedRunSnapshot
): readonly string[] {
    return [
        ...new Set(
            run.manifest.targetPolicy.agentIds ?? run.targetAgentIds
        )
    ].sort();
}

export function executeRunConfigurationIssue(
    input: Readonly<{
        run?: ControlDistributedRunSnapshot;
        controlRunId?: string;
        recipeId?: string;
    }>
): string | undefined {
    if (!input.run) {
        return undefined;
    }
    if (input.run.controlRunId !== input.controlRunId) {
        return 'The selected distributed run belongs to a different control run.';
    }
    const recipeIds = manifestRecipeIds(input.run.manifest);
    if (recipeIds.length !== 1 || recipeIds[0] !== input.recipeId) {
        return 'The selected recipe does not match the authoritative stored run manifest.';
    }
    return undefined;
}

export function sameTargetSelection(
    left: ExecuteTargetSelection | undefined,
    right: ExecuteTargetSelection
): boolean {
    return left?.contextKey === right.contextKey &&
        left.agentIds.length === right.agentIds.length &&
        left.agentIds.every((value, index) => value === right.agentIds[index]);
}

export function executeSafeTargetLabel(
    input: Readonly<{
        connection: ExecuteConnectionTruth;
        rows: readonly Readonly<{ targetable: boolean; }>[];
        selectedAgentIds: readonly string[];
    }>
): string {
    const safe = input.rows.filter((row) => row.targetable).length;
    return input.connection === 'live' || input.connection === 'partial'
        ? `${input.selectedAgentIds.length} selected · ${safe} recipe-safe`
        : `0 current · ${safe} last-known recipe-safe`;
}
