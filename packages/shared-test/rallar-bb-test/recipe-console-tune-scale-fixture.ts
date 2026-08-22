import type { RallarBlackBoxDistributedRunManifest } from './distributed-run.ts';
import {
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestRecipe,
    type RallarBlackBoxTestRtcStreamCommand
} from './types.ts';

export const RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT = 2_000;
export const RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND = 12;

const GLOBAL_TUNING_KNOB_COUNT = 2;
const LONG_BIDI_SUFFIX = `\u202egnol-界-\u2066exact\u2069-${'stream'.repeat(22)}`;

type ScalePosition = 'first' | 'middle' | 'last' | 'longBidi';
type ScalePositions = Readonly<Record<ScalePosition, number>>;

export type RecipeConsoleTuneScaleFixtureOptions = Readonly<{
    commandCount?: number;
}>;

export type RecipeConsoleTuneScaleFixture = Readonly<{
    manifest: RallarBlackBoxDistributedRunManifest;
    recipe: RallarBlackBoxTestRecipe;
    positions: ScalePositions;
    needles: Readonly<{
        commandIds: Readonly<Record<ScalePosition, string>>;
    }>;
    counts: Readonly<{
        commands: number;
        expectedKnobs: number;
        expectedEditableKnobs: number;
    }>;
}>;

export function createRecipeConsoleTuneScaleFixture(
    options: RecipeConsoleTuneScaleFixtureOptions = {}
): RecipeConsoleTuneScaleFixture {
    const commandCount = boundedCommandCount(
        options.commandCount ?? RECIPE_CONSOLE_TUNE_SCALE_DEFAULT_COMMAND_COUNT
    );
    const positions = scalePositions(commandCount);
    const commands = Array.from({ length: commandCount }, (_, ordinal) => streamCommand(ordinal, positions.longBidi));
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: 'recipe-console-tune-scale-streams',
        name: 'Recipe Console Tune deterministic scale streams',
        commands
    };
    const manifest: RallarBlackBoxDistributedRunManifest = {
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
            recipe
        }],
        targetPolicy: {
            mode: 'selected-agents',
            expectedParticipantCount: 1,
            agentIds: ['recipe-console-tune-scale-agent']
        },
        ackTimeoutMs: 15_000,
        barrier: { enabled: true, timeoutMs: 20_000 },
        startMode: 'manual'
    };
    const expectedKnobs = GLOBAL_TUNING_KNOB_COUNT +
        commandCount * RECIPE_CONSOLE_TUNE_SCALE_KNOBS_PER_COMMAND;
    return {
        manifest,
        recipe,
        positions,
        needles: {
            commandIds: {
                first: commandId(positions.first, positions.longBidi),
                middle: commandId(positions.middle, positions.longBidi),
                last: commandId(positions.last, positions.longBidi),
                longBidi: commandId(positions.longBidi, positions.longBidi)
            }
        },
        counts: {
            commands: commandCount,
            expectedKnobs,
            expectedEditableKnobs: expectedKnobs
        }
    };
}

function streamCommand(
    ordinal: number,
    longBidiOrdinal: number
): RallarBlackBoxTestRtcStreamCommand {
    return {
        kind: 'rtc.stream',
        commandId: commandId(ordinal, longBidiOrdinal),
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

function scalePositions(count: number): ScalePositions {
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

function commandId(ordinal: number, longBidiOrdinal: number): string {
    return ordinal === longBidiOrdinal
        ? `scale-stream-${LONG_BIDI_SUFFIX}`
        : `scale-stream-${String(ordinal).padStart(6, '0')}`;
}

function boundedCommandCount(value: number): number {
    const maximum = RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands;
    if (!Number.isSafeInteger(value) || value < 4 || value > maximum) {
        throw new Error(`commandCount must be a safe integer from 4 through ${maximum}.`);
    }
    return value;
}
