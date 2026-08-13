import type {
    RallarBlackBoxDistributedParticipantResult,
    RallarBlackBoxDistributedRecipeResult,
    RallarBlackBoxDistributedRunError,
    RallarBlackBoxDistributedRunItemState,
    RallarBlackBoxDistributedRunState,
} from '../distributed-run.ts';
import type {
    RallarBlackBoxDistributedGroupAssertionResult,
} from './group-assertions.ts';

export const RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES = [
    'passed',
    'failed',
    'cancelled',
    'timed-out',
] as const;

export type RallarBlackBoxDistributedRunTerminalState =
    typeof RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES[number];

export type RallarBlackBoxDistributedRunRollupInput = Readonly<{
    stateHint?: RallarBlackBoxDistributedRunState;
    participants?: readonly RallarBlackBoxDistributedParticipantResult[];
    recipes?: readonly RallarBlackBoxDistributedRecipeResult[];
    groupAssertions?: readonly RallarBlackBoxDistributedGroupAssertionResult[];
}>;

export type RallarBlackBoxDistributedRunRollupFailure = Readonly<{
    kind: 'participant' | 'recipe' | 'group-assertion';
    key: string;
    state: RallarBlackBoxDistributedRunItemState;
    required: boolean;
    error?: RallarBlackBoxDistributedRunError;
}>;

export type RallarBlackBoxDistributedRunRollup = Readonly<{
    state: RallarBlackBoxDistributedRunState;
    ok: boolean;
    summary: Readonly<{
        participants: number;
        requiredParticipants: number;
        readyParticipants: number;
        passedParticipants: number;
        failedParticipants: number;
        recipes: number;
        requiredRecipes: number;
        passedRecipes: number;
        failedRecipes: number;
        groupAssertions: number;
        passedGroupAssertions: number;
        failedGroupAssertions: number;
        blockingFailures: number;
    }>;
    groupAssertions?: readonly RallarBlackBoxDistributedGroupAssertionResult[];
    failures: readonly RallarBlackBoxDistributedRunRollupFailure[];
}>;

export function isDistributedRunTerminalState(
    state: RallarBlackBoxDistributedRunState,
): state is RallarBlackBoxDistributedRunTerminalState {
    return RALLAR_BLACK_BOX_DISTRIBUTED_RUN_TERMINAL_STATES.includes(
        state as RallarBlackBoxDistributedRunTerminalState,
    );
}

export function rollupDistributedRunResult(
    input: RallarBlackBoxDistributedRunRollupInput,
): RallarBlackBoxDistributedRunRollup {
    const participants = input.participants ?? [];
    const recipes = input.recipes ?? [];
    const groupAssertions = input.groupAssertions ?? [];
    const requiredParticipants = participants.filter(item => item.required !== false);
    const requiredRecipes = recipes.filter(item => item.required !== false);
    const requiredItems = [
        ...requiredParticipants.map(item => ({ kind: 'participant' as const, key: item.agentId, item })),
        ...requiredRecipes.map(item => ({ kind: 'recipe' as const, key: itemKey(item), item })),
    ];
    const failures: RallarBlackBoxDistributedRunRollupFailure[] = [
        ...requiredItems
            .filter(({ item }) => isBlockingItemFailure(item))
            .map(({ kind, key, item }) => ({
                kind,
                key,
                state: item.state,
                required: item.required !== false,
                error: item.error,
            })),
        ...groupAssertions
            .filter(result => !result.ok)
            .map(result => ({
                kind: 'group-assertion' as const,
                key: result.groupAssertionId,
                state: 'failed' as const,
                required: true,
                error: result.error,
            })),
    ];

    const state = deriveRollupState({
        stateHint: input.stateHint,
        participants: requiredParticipants,
        recipes: requiredRecipes,
        failures,
    });

    return {
        state,
        ok: state === 'passed',
        summary: {
            participants: participants.length,
            requiredParticipants: requiredParticipants.length,
            readyParticipants: requiredParticipants.filter(item =>
                item.state === 'ready' || item.state === 'running' || item.state === 'passed'
            ).length,
            passedParticipants: requiredParticipants.filter(item => item.state === 'passed').length,
            failedParticipants: requiredParticipants.filter(isBlockingItemFailure).length,
            recipes: recipes.length,
            requiredRecipes: requiredRecipes.length,
            passedRecipes: requiredRecipes.filter(item =>
                item.state === 'passed' && item.ok !== false
            ).length,
            failedRecipes: requiredRecipes.filter(isBlockingItemFailure).length,
            groupAssertions: groupAssertions.length,
            passedGroupAssertions: groupAssertions.filter(result => result.ok).length,
            failedGroupAssertions: groupAssertions.filter(result => !result.ok).length,
            blockingFailures: failures.length,
        },
        groupAssertions: input.groupAssertions,
        failures,
    };
}

interface DeriveRollupStateInput {
    readonly stateHint: RallarBlackBoxDistributedRunState | undefined;
    readonly participants: readonly RallarBlackBoxDistributedParticipantResult[];
    readonly recipes: readonly RallarBlackBoxDistributedRecipeResult[];
    readonly failures: readonly { state: RallarBlackBoxDistributedRunItemState }[];
}

function deriveRollupState(input: DeriveRollupStateInput): RallarBlackBoxDistributedRunState {
    const { stateHint, participants, recipes, failures } = input;
    if (stateHint && isDistributedRunTerminalState(stateHint)) {
        return stateHint;
    }

    if (failures.some(failure => failure.state === 'timed-out')) {
        return 'timed-out';
    }

    if (failures.some(failure => failure.state === 'cancelled')) {
        return 'cancelled';
    }

    if (failures.length > 0) {
        return 'failed';
    }

    if (recipes.length > 0 && recipes.every(item => item.state === 'passed' && item.ok !== false)) {
        return 'passed';
    }

    if (recipes.some(item => item.state === 'running') || participants.some(item => item.state === 'running')) {
        return 'running';
    }

    if (participants.length > 0 && participants.every(item =>
        item.state === 'ready' ||
        item.state === 'running' ||
        item.state === 'passed'
    )) {
        return 'ready';
    }

    if (participants.some(item => item.state === 'acknowledged')) {
        if (stateHint === 'waiting-for-barrier') {
            return 'waiting-for-barrier';
        }
        return 'waiting-for-ack';
    }

    return stateHint ?? 'draft';
}

function isBlockingItemFailure(item: Readonly<{
    state: RallarBlackBoxDistributedRunItemState;
    ok?: boolean;
}>): boolean {
    return item.ok === false ||
        item.state === 'failed' ||
        item.state === 'timed-out' ||
        item.state === 'cancelled' ||
        item.state === 'disconnected';
}

function itemKey(item: RallarBlackBoxDistributedRecipeResult): string {
    return item.recipeKey || [item.agentId, item.recipeId, item.role].filter(Boolean).join(':') || 'recipe';
}
