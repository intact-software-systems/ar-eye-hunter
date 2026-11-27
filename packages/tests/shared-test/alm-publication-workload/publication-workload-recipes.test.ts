import { describe, expect, it } from 'vitest';

import {
    createPublicationWorkloadRecipes,
    type PublicationWorkloadRecipes
} from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/create-publication-workload-recipes.ts';
import type { PublicationWorkloadParameters } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import { validateRallarBlackBoxTestCommand } from '@shared-test/rallar-bb-test/control/validate-rallar-black-box-test-command.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import { distributedRecipePreflight } from '@shared-test/rallar-bb-test/distributed-recipe-preflight/distributed-recipe-preflight.ts';
import { resolveLoopPlan } from '@shared-test/rallar-bb-test/loop/resolve-loop-plan.ts';
import {
    createDefaultRallarBlackBoxTestRuntime,
    RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestLoopCommand,
    type RallarBlackBoxTestMessagesSendCommand,
    type RallarBlackBoxTestRecipe
} from '@shared-test/rallar-bb-test/mod.ts';
import type { RallarBlackBoxTestAlmUsage } from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA } from '@shared-test/rallar-bb-test/schema.ts';
import { isJsonRecordValue, validateJsonSchema } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { toIdleALOutboundCongestionEpisodeFigures } from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';
import { toIdleALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { toNestedCommands } from '../to-nested-commands.ts';

const GROUP = { applicationId: 'workload-app', workspaceId: 'workload-workspace', groupId: 'workload-room' };

/**
 * Three agents, one send every 500 ms for 30 seconds on rtc: 30,000 / 500 = 60 frames, and 95 % of 60 is 57 for both
 * ratios.
 */
const POINT: PublicationWorkloadParameters = {
    group: GROUP,
    participantCount: 3,
    carrier: 'rtc',
    publishIntervalMs: 500,
    windowMs: 30_000,
    publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
    payloadBytes: 256,
    ttlMs: 5_000,
    minReceiveRatio: 0.95,
    minSendSuccessRatio: 0.95,
    readyTimeoutMs: 45_000
};

/** `{"seq":60,"sentAtEpochMs":9999999999999,"pad":""}` is 49 bytes, so 256 bytes take 207 of filler. */
const FILLER = 'x'.repeat(207);

const FRAME_TYPE_ID = 'room.publication-workload.frame.v1';

const WINDOW_STARTED_AT_EPOCH_MS = 1_800_000_000_000;

function createRecipes(parameters: PublicationWorkloadParameters): PublicationWorkloadRecipes {
    const created = createPublicationWorkloadRecipes(parameters);
    if (created.right === undefined) {
        throw new Error(`The point is not valid: ${JSON.stringify(created.left)}`);
    }
    return created.right;
}

/** The loops at the top level of a recipe whose children send: a loop nested in another would be missing here. */
function toSendLoops(recipe: RallarBlackBoxTestRecipe): readonly RallarBlackBoxTestLoopCommand[] {
    return recipe.commands
        .filter((command) => command.kind === 'loop')
        .filter((loop) => loop.commands.some((child) => child.kind === 'messages.send'));
}

function toSoleSendLoop(recipe: RallarBlackBoxTestRecipe): RallarBlackBoxTestLoopCommand {
    const [loop, ...others] = toSendLoops(recipe);
    if (loop === undefined || others.length > 0) {
        throw new Error(`The recipe ${recipe.recipeId} must hold exactly one top-level loop of sends.`);
    }
    return loop;
}

/** The commands a role runs after the barrier `afterBarrierId`, to the end of its recipe. */
function toCommandsAfterBarrier(
    recipe: RallarBlackBoxTestRecipe,
    afterBarrierId: string
): readonly RallarBlackBoxTestCommand[] {
    const start = recipe.commands.findIndex((command) => command.kind === 'barrier' && command.barrierId === afterBarrierId);
    if (start < 0) {
        throw new Error(`The recipe ${recipe.recipeId} holds no barrier ${afterBarrierId}.`);
    }
    return recipe.commands.slice(start + 1);
}

function toBarrierIds(recipe: RallarBlackBoxTestRecipe): readonly string[] {
    return recipe.commands.flatMap((command) => command.kind === 'barrier' ? [command.barrierId] : []);
}

describe('the recipes of one point of the publication workload family', () => {
    it('gives the publisher one loop of 60 frames 500 ms apart whose one child is the stamped live send, and has a subscriber count 57 copies and read their age', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        const loop = toSoleSendLoop(publisher.recipe);
        expect(loop).toMatchObject({ count: 60, intervalMs: 500, continueOnFailure: true });
        expect(loop.commands).toEqual([{
            kind: 'messages.send',
            commandId: 'publication-workload-publisher-send',
            connection: 'publication-workload-publisher',
            carrier: 'rtc',
            roomRef: GROUP,
            topicId: 'room.publication-workload',
            typeId: FRAME_TYPE_ID,
            purpose: 'live',
            publication: { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } },
            resourceId: 'publication-workload',
            ttlMs: 5_000,
            payload: { seq: '{loop.iteration}', sentAtEpochMs: '{loop.atEpochMs}', pad: FILLER },
            // The harness's own budget for a send, not the frame's lifetime of 5,000 ms.
            timeoutMs: 10_000
        }]);
        expect(toNestedCommands(subscriber.recipe.commands).filter((command) => command.kind === 'messages.received'))
            .toEqual([{
                kind: 'messages.received',
                commandId: 'publication-workload-subscriber-received',
                connection: 'publication-workload-subscriber',
                typeId: FRAME_TYPE_ID,
                count: 57,
                ageFrom: 'sentAtEpochMs',
                windowMs: 5_000,
                timeoutMs: 6_000
            }]);
    });

    it.each(
        [
            { role: 'publisher', connection: 'publication-workload-publisher' },
            { role: 'subscriber', connection: 'publication-workload-subscriber' }
        ] as const
    )(
        'connects the $role once, under the connection its send or its count names, on the one typed channel of the frame',
        ({ role, connection }) => {
            const { recipe } = createRecipes(POINT)[role];

            const connects = recipe.commands.filter((command) => command.kind === 'rtc.connect');
            expect(connects).toHaveLength(1);
            expect(connects[0]).toMatchObject({ connection, transport: 'messages.rtc', roomRef: GROUP });
            expect(connects[0]?.rallar).toMatchObject({
                typeId: 'room.publication-workload.frame.v1',
                topicId: 'room.publication-workload'
            });
            expect(Object.keys(connects[0]?.rallar ?? {})).not.toContain('messageSelector');
            expect(Object.keys(connects[0]?.rallar ?? {})).not.toContain('messageTypeIds');
        }
    );

    it('returns the issues of a point that breaks its bounds and builds no recipe, though sizing its payload would throw', () => {
        const created = createPublicationWorkloadRecipes({ ...POINT, participantCount: 1, payloadBytes: 10 });

        expect(created.right).toBeUndefined();
        expect(created.left?.map(({ path, code }) => ({ path, code }))).toEqual([
            { path: '$.participantCount', code: 'invalid-participant-count' },
            { path: '$.payloadBytes', code: 'payload-bytes-below-template-minimum' }
        ]);
    });

    it.each(['ws', 'rtc', 'rtc-with-ws-fallback'] as const)(
        'sends on %s, on recipes the schema, the control validation and the preflight all admit',
        (carrier) => {
            const { publisher, subscriber } = createRecipes({ ...POINT, carrier });

            for (const recipe of [publisher.recipe, subscriber.recipe]) {
                expect(validateJsonSchema(RALLAR_BLACK_BOX_TEST_RECIPE_SCHEMA, recipe)).toEqual({ ok: true, errors: [] });
                expect(toNestedCommands(recipe.commands).map((command) => validateRallarBlackBoxTestCommand(command)))
                    .toEqual(toNestedCommands(recipe.commands).map(() => ({ ok: true })));
                expect(distributedRecipePreflight(recipe).errors).toEqual([]);
            }
            expect(
                toNestedCommands(publisher.recipe.commands).flatMap((command) =>
                    command.kind === 'messages.send' && 'carrier' in command ? [command.carrier] : []
                )
            ).toEqual([carrier]);
        }
    );

    it.each([
        { participantCount: 3, subscriberAgents: 2 },
        { participantCount: 50, subscriberAgents: 49 }
    ])(
        'splits $participantCount agents into one publisher, which alone writes the group, and $subscriberAgents subscribers',
        ({ participantCount, subscriberAgents }) => {
            const { publisher, subscriber } = createRecipes({ ...POINT, participantCount });

            expect({ publisher: publisher.agentCount, subscriber: subscriber.agentCount })
                .toEqual({ publisher: 1, subscriber: subscriberAgents });
            expect(publisher.recipe.commands.find((command) => command.kind === 'http.request' && command.request.method !== 'GET'))
                .toMatchObject({ request: { body: { groupId: 'workload-room', maxMembers: participantCount } } });
            expect(subscriber.recipe.commands.filter((command) => command.kind === 'http.request' && command.request.method !== 'GET'))
                .toEqual([]);
            for (const { recipe } of [publisher, subscriber]) {
                expect(recipe.commands.find((command) => command.kind === 'wait' && command.absent !== true))
                    .toMatchObject({ match: { payloadFields: { 'data.activeSessionCount': participantCount } } });
            }
        }
    );

    it('meets both roles at the same four barriers, in order, under command ids of their own', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        const barrierIds = [
            'publication-workload-group-created',
            'publication-workload-connected',
            'publication-workload-setup-complete',
            'publication-workload-complete'
        ];
        expect(toBarrierIds(publisher.recipe)).toEqual(barrierIds);
        expect(toBarrierIds(subscriber.recipe)).toEqual(barrierIds);
        const publisherCommandIds = toNestedCommands(publisher.recipe.commands).map((command) => command.commandId);
        const subscriberCommandIds = toNestedCommands(subscriber.recipe.commands).map((command) => command.commandId);
        expect(publisherCommandIds.filter((commandId) => subscriberCommandIds.includes(commandId))).toEqual([]);
    });

    it('starts the window at the setup-complete barrier: the publisher sends, drains and reads its stats, a subscriber waits at the complete barrier through all of it, and keeps its whole inbound log', () => {
        const { publisher, subscriber } = createRecipes(POINT);

        // Twice the 30,000 ms window for the loop, the 5,100 ms drain and the 3,000 ms stats read.
        const completeBarrier = { kind: 'barrier', barrierId: 'publication-workload-complete', timeoutMs: 68_100 };
        const publisherWindow = toCommandsAfterBarrier(publisher.recipe, 'publication-workload-setup-complete');
        expect(publisherWindow.map((command) => command.commandId)).toEqual([
            'publication-workload-publisher-frames',
            'publication-workload-publisher-drain',
            'publication-workload-publisher-stats',
            'publication-workload-publisher-complete',
            'publication-workload-publisher-assert-accepted-sends'
        ]);
        expect(publisherWindow[3]).toMatchObject(completeBarrier);
        // The stage's own count of the values it handed to a carrier, against 95 % of 60 frames.
        expect(publisherWindow[4]).toEqual({
            kind: 'assert',
            commandId: 'publication-workload-publisher-assert-accepted-sends',
            source: 'resultCache.publication-workload-publisher-stats.value.rallar.alm.publication.counters.admitted',
            operator: 'gte',
            expected: 57
        });
        expect(toCommandsAfterBarrier(subscriber.recipe, 'publication-workload-setup-complete')[0])
            .toMatchObject(completeBarrier);
        expect(subscriber.recipe.eventHistory).toEqual({ mode: 'full' });
    });
});

/**
 * The ALM usage of a page that is idle but for its publication stage: of the 60 values it staged, it handed
 * `admitted` to a carrier and let the others expire.
 */
function toPublisherAlmUsage(admitted: number): RallarBlackBoxTestAlmUsage {
    const stage = toIdleALOutboundPublicationStageReport(AL_PUBLICATION_STAGE_LIMITS);
    return {
        usage: { admissions: 0, bytes: 0, oldestAgeMs: 0, tracks: 0 },
        own: { admissions: 0, bytes: 0 },
        inbound: { admissions: 0, bytes: 0 },
        limits: AL_VOLATILE_SESSION_LIMITS,
        overloaded: false,
        orderingTracks: 0,
        deliveredMarkers: 0,
        repliesHeld: 0,
        replyWaitsOpen: 0,
        publication: {
            ...stage,
            lanes: 1,
            counters: { ...stage.counters, staged: 60, admitted, expired: 60 - admitted }
        },
        ordering: { entered: 0, omitted: 0, witnessed: 0, beforeEntry: 0 },
        congestionEpisodes: toIdleALOutboundCongestionEpisodeFigures()
    };
}

describe('the publisher\'s commands after the setup-complete barrier, run by the runtime', () => {
    interface PublisherWindowRun {
        readonly ok: boolean;
        readonly failedCommandIds: readonly string[];
        /** Every command of the recipe that returned a result, in the order it ran. */
        readonly ranCommands: readonly Readonly<{ commandId: string; ok: boolean; }>[];
        readonly sends: readonly RallarBlackBoxTestMessagesSendCommand[];
        readonly statsReadAtEpochMs: number | undefined;
    }

    /**
     * Sends take no time and every sleep advances the clock, so the clock reads the schedule alone. Every send returns
     * as a live send does, whatever its stage does with the value afterwards, and the page's ALM usage says how many
     * values the stage handed to a carrier. The executor releases a barrier as soon as the publisher arrives at it, as
     * a control server whose subscribers already wait.
     */
    async function runPublisherWindow(admittedByStage: number): Promise<PublisherWindowRun> {
        let now = WINDOW_STARTED_AT_EPOCH_MS;
        const sends: RallarBlackBoxTestMessagesSendCommand[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            readAlmUsage: async () => toPublisherAlmUsage(admittedByStage),
            commandExecutor: (command, context) => {
                if (command.kind === 'barrier') {
                    return {
                        status: 'ok',
                        value: { barrierId: command.barrierId, outcome: 'released', arrivedAgentIds: [] },
                        nextStatus: context.state().status
                    };
                }
                if (command.kind !== 'messages.send' || !('carrier' in command)) {
                    return undefined;
                }
                sends.push(command);
                return { status: 'ok', value: {}, nextStatus: context.state().status };
            }
        });
        const result = await runtime.execute({
            kind: 'recipe.run',
            commandId: 'publisher-window',
            recipe: {
                schemaVersion: 1,
                recipeId: 'publisher-window',
                continueOnFailure: false,
                commands: toCommandsAfterBarrier(createRecipes(POINT).publisher.recipe, 'publication-workload-setup-complete')
            }
        });
        const ran = isJsonRecordValue(result.value) && Array.isArray(result.value.results) ? result.value.results : [];
        return {
            ok: result.ok,
            ranCommands: ran.flatMap((entry) =>
                isJsonRecordValue(entry) && typeof entry.commandId === 'string' && typeof entry.ok === 'boolean'
                    ? [{ commandId: entry.commandId, ok: entry.ok }]
                    : []
            ),
            failedCommandIds: runtime.state().failures.map((failure) => failure.commandId),
            sends,
            statsReadAtEpochMs: runtime.state().resultCache['publication-workload-publisher-stats']?.startedAtEpochMs
        };
    }

    it('sends frame n as the number n stamped with the clock of its send, the last one in exactly the declared 256 bytes', async () => {
        const run = await runPublisherWindow(60);

        expect(run.ok).toBe(true);
        expect(run.sends.map((send) => isJsonRecordValue(send.payload) ? send.payload.seq : undefined))
            .toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
        expect([run.sends[0], run.sends[1], run.sends[59]].map((send) => send?.payload)).toEqual([
            { seq: 1, sentAtEpochMs: 1_800_000_000_000, pad: FILLER },
            { seq: 2, sentAtEpochMs: 1_800_000_000_500, pad: FILLER },
            { seq: 60, sentAtEpochMs: 1_800_000_029_500, pad: FILLER }
        ]);
        expect(new TextEncoder().encode(JSON.stringify(run.sends[59]?.payload)).length).toBe(256);
    });

    it('reads the publisher\'s stats one cadence and one lifetime after the last send: 100 ms and 5,000 ms', async () => {
        const run = await runPublisherWindow(60);

        expect(run.statsReadAtEpochMs).toBe(1_800_000_029_500 + 5_100);
    });

    it('passes when its stage handed 57 of the 60 frames to a carrier; with 56, though all 60 sends returned, it fails its own assert, and only after it read its stats and met the subscribers at the complete barrier', async () => {
        const atThreshold = await runPublisherWindow(57);
        const belowThreshold = await runPublisherWindow(56);

        expect({ ok: atThreshold.ok, failedCommandIds: atThreshold.failedCommandIds })
            .toEqual({ ok: true, failedCommandIds: [] });
        expect(belowThreshold.sends).toHaveLength(60);
        expect(belowThreshold.ok).toBe(false);
        expect(belowThreshold.failedCommandIds)
            .toEqual(['publication-workload-publisher-assert-accepted-sends', 'publisher-window']);
        expect(belowThreshold.statsReadAtEpochMs).toBe(1_800_000_029_500 + 5_100);
        expect(belowThreshold.ranCommands).toEqual([
            { commandId: 'publication-workload-publisher-frames', ok: true },
            { commandId: 'publication-workload-publisher-drain', ok: true },
            { commandId: 'publication-workload-publisher-stats', ok: true },
            { commandId: 'publication-workload-publisher-complete', ok: true },
            { commandId: 'publication-workload-publisher-assert-accepted-sends', ok: false }
        ]);
    });
});

describe('a subscriber\'s count and its three guards, run by the browser runtime on a log of copies', () => {
    interface SubscriberCountRun {
        readonly observed: number | undefined;
        readonly passed: readonly string[];
        readonly failed: readonly string[];
    }

    /** One copy per stamp, each recorded 20 ms after the instant a numeric stamp names. */
    async function runSubscriberCount(stamps: readonly (number | string)[]): Promise<SubscriberCountRun> {
        let now = WINDOW_STARTED_AT_EPOCH_MS;
        const runtime = createDefaultRallarBlackBoxBrowserTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            readSession: () => undefined
        });
        stamps.forEach((sentAtEpochMs, index) => {
            now = WINDOW_STARTED_AT_EPOCH_MS + index * 500 + 20;
            runtime.receiveRallarBrowserEvent({
                kind: 'message',
                topic: 'rallar.browser.messages.rtc.message',
                connection: 'publication-workload-subscriber',
                transport: 'messages.rtc',
                typeId: FRAME_TYPE_ID,
                data: {
                    msgId: `msg-${index}`,
                    typeId: FRAME_TYPE_ID,
                    transport: 'rtc',
                    payload: { seq: index + 1, sentAtEpochMs, pad: FILLER },
                    traceId: `trace-${index}`,
                    corrId: `msg-${index}`
                }
            });
        });
        const commands = toCommandsAfterBarrier(createRecipes(POINT).subscriber.recipe, 'publication-workload-complete')
            .filter((command) => command.kind !== 'stats');
        const results = [];
        for (const command of commands) {
            results.push(await runtime.execute(command));
        }
        const received = results[0]?.value;
        return {
            observed: isJsonRecordValue(received) && typeof received.observed === 'number' ? received.observed : undefined,
            passed: results.filter((result) => result.ok).map((result) => result.commandId),
            failed: results.filter((result) => !result.ok).map((result) => result.commandId)
        };
    }

    function toStamps(count: number): readonly number[] {
        return Array.from({ length: count }, (_, index) => WINDOW_STARTED_AT_EPOCH_MS + index * 500);
    }

    it('passes the count and its three guards on 58 copies that each carry a numeric stamp', async () => {
        expect(await runSubscriberCount(toStamps(58))).toEqual({
            observed: 58,
            passed: [
                'publication-workload-subscriber-received',
                'publication-workload-subscriber-assert-every-copy-aged',
                'publication-workload-subscriber-assert-ages-cover-copies',
                'publication-workload-subscriber-assert-copies-within-frames'
            ],
            failed: []
        });
    });

    it('fails both age guards, not the count, when one of 57 copies still carries its unresolved stamp', async () => {
        expect(await runSubscriberCount([...toStamps(56), '{loop.atEpochMs}'])).toEqual({
            observed: 57,
            passed: [
                'publication-workload-subscriber-received',
                'publication-workload-subscriber-assert-copies-within-frames'
            ],
            failed: [
                'publication-workload-subscriber-assert-every-copy-aged',
                'publication-workload-subscriber-assert-ages-cover-copies'
            ]
        });
    });

    it('fails on 61 copies, one more than the publisher has frames: a page delivers each message once, so the log holds another sender\'s or another run\'s', async () => {
        const run = await runSubscriberCount(toStamps(61));

        expect(run.observed).toBe(61);
        expect(run.failed).toEqual(['publication-workload-subscriber-assert-copies-within-frames']);
    });

    it('fails the count on 56 copies, one short of the 57 that 95 % of 60 frames asks for', async () => {
        const run = await runSubscriberCount(toStamps(56));

        expect(run.observed).toBe(56);
        expect(run.failed).toContain('publication-workload-subscriber-received');
    });
});

describe('the frame limit of the family against the loop\'s own limit', () => {
    it('fills the loop\'s expansion limit exactly at 2,000 frames, because the loop holds one send per frame', () => {
        const loop = toSoleSendLoop(createRecipes({ ...POINT, windowMs: 1_000_000 }).publisher.recipe);

        expect(loop.commands).toHaveLength(1);
        expect(loop.count).toBe(RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
        expect(resolveLoopPlan({ ...loop, commandId: 'frames' }).right?.plannedCommandCount)
            .toBe(RALLAR_BLACK_BOX_TEST_COMPOSITE_LIMITS.maxExpandedCommands);
        expect(resolveLoopPlan({ ...loop, commandId: 'frames', count: 2_001 }).left?.error?.code)
            .toBe('RALLAR_BLACK_BOX_LOOP_LIMIT_EXCEEDED');
        expect(createPublicationWorkloadRecipes({ ...POINT, windowMs: 1_000_500 }).left?.map((issue) => issue.code))
            .toEqual(['frame-count-above-limit']);
    });
});
