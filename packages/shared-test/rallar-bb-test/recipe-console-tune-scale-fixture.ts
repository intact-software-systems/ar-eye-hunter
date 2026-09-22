import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestRtcStreamCommand
} from './rallar-black-box-test-contracts.ts';

export const RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT = 2_000;
export const RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND = 12;

const GLOBAL_TUNING_KNOB_COUNT = 2;
const LONG_BIDI_SUFFIX = `\u202egnol-界-\u2066exact\u2069-${'stream'.repeat(22)}`;

type ScalePosition = 'first' | 'middle' | 'last' | 'longBidi';
type ScalePositions = Readonly<Record<ScalePosition, number>>;

export interface RecipeConsoleTuneScaleFixtureSize {
    readonly commandCount: number;
}

export interface RecipeConsoleTuneScaleFixture {
    readonly manifest: RallarBlackBoxDistributedRunManifest;
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly positions: ScalePositions;
    readonly needles: Readonly<{
        commandIds: Readonly<Record<ScalePosition, string>>;
    }>;
    readonly counts: Readonly<{
        commands: number;
        expectedKnobs: number;
        expectedEditableKnobs: number;
    }>;
}

export function createDefaultRecipeConsoleTuneScaleFixture(): RecipeConsoleTuneScaleFixture {
    return createRecipeConsoleTuneScaleFixture({ commandCount: RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT });
}

export function createRecipeConsoleTuneScaleFixture(
    size: RecipeConsoleTuneScaleFixtureSize
): RecipeConsoleTuneScaleFixture {
    const { commandCount } = size;
    assertTuneScaleCommandCount(commandCount);
    const positions = computeScalePositions(commandCount);
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'recipe-console-tune-scale-streams',
        name: 'Recipe Console Tune deterministic scale streams',
        commands: Array.from(
            { length: commandCount },
            (_, ordinal) => toScaleStreamCommand(ordinal, positions.longBidi)
        )
    };
    const expectedKnobs = GLOBAL_TUNING_KNOB_COUNT + commandCount * RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND;
    return {
        manifest: toTuneScaleManifest(recipe),
        recipe,
        positions,
        needles: {
            commandIds: {
                first: toScaleCommandId(positions.first, positions.longBidi),
                middle: toScaleCommandId(positions.middle, positions.longBidi),
                last: toScaleCommandId(positions.last, positions.longBidi),
                longBidi: toScaleCommandId(positions.longBidi, positions.longBidi)
            }
        },
        counts: {
            commands: commandCount,
            expectedKnobs,
            expectedEditableKnobs: expectedKnobs
        }
    };
}

function toTuneScaleManifest(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxDistributedRunManifest {
    return {
        schemaVersion: 1,
        distributedRunId: 'recipe-console-tune-scale-distributed-run',
        controlRunId: 'recipe-console-tune-scale-control-run',
        displayName: 'Recipe Console Tune scale fixture',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'recipe-console-scale',
            groupId: 'recipe-console-tune-scale'
        },
        recipes: [{
            recipeId: recipe.recipeId,
            profile: 'scale',
            recipe,
            variables: {}
        }],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 1,
            agentIds: ['recipe-console-tune-scale-agent']
        },
        variables: {},
        roleAssignments: [],
        ackTimeoutMs: 15_000,
        barrier: { enabled: true, timeoutMs: 20_000 },
        startMode: 'manual',
        groupAssertions: [],
        metadata: {}
    };
}

function toScaleStreamCommand(
    ordinal: number,
    longBidiOrdinal: number
): RallarBlackBoxTestRtcStreamCommand {
    return {
        kind: 'rtc.stream',
        commandId: toScaleCommandId(ordinal, longBidiOrdinal),
        connection: 'recipe-console-tune-scale-rtc',
        roomId: 'recipe-console-tune-scale-room',
        transport: 'messages.rtc',
        send: { kind: 'recipe-console-tune-scale-frame', ordinal },
        durationMs: 1_000,
        rateHz: 30,
        maxInFlight: 8,
        drainTimeoutMs: 2_000,
        continueOnSendFailure: true,
        progressEveryMs: 250,
        sampleEvery: 10,
        thresholds: {
            minSendSuccessRatio: 0.99,
            maxDroppedFrames: 1,
            maxBackpressureCount: 2,
            maxP95SendDurationMs: 40,
            maxP99SendDurationMs: 80,
            maxAverageStartDriftMs: 10,
            maxStartDriftMs: 25,
            maxJitterMs: 12
        }
    };
}

function computeScalePositions(count: number): ScalePositions {
    const first = 0;
    const middle = Math.floor(count / 2);
    const last = count - 1;
    const occupied = new Set([first, middle, last]);
    let longBidi = Math.floor(count * 3 / 4);
    while (occupied.has(longBidi)) {
        longBidi = (longBidi + 1) % count;
    }
    return { first, middle, last, longBidi };
}

function toScaleCommandId(ordinal: number, longBidiOrdinal: number): string {
    return ordinal === longBidiOrdinal
        ? `scale-stream-${LONG_BIDI_SUFFIX}`
        : `scale-stream-${String(ordinal).padStart(6, '0')}`;
}

/** Fixture callers pass literal counts; a count outside the recipe command limits is a programming error. */
function assertTuneScaleCommandCount(value: number): void {
    const maximum = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands;
    if (!Number.isSafeInteger(value) || value < 4 || value > maximum) {
        throw new Error(`commandCount must be a safe integer from 4 through ${maximum}.`);
    }
}
