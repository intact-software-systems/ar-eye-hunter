import { describe, expect, it } from 'vitest';

import type { RallarBlackBoxBrowserRallarEvent } from '@shared-test/rallar-bb-test/browser/browser-command-contracts.ts';
import type { PublicationWorkloadParameters } from '@shared-test/rallar-bb-test/conformance/alm/publication-workload/validate-publication-workload-parameters.ts';
import { createDefaultRallarBlackBoxBrowserTestRuntime } from '@shared-test/rallar-bb-test/create-rallar-black-box-browser-test-runtime.ts';
import {
    createDefaultRallarBlackBoxTestRuntime,
    type RallarBlackBoxTestCommand,
    type RallarBlackBoxTestMessagesSendCommand
} from '@shared-test/rallar-bb-test/mod.ts';
import type {
    RallarBlackBoxTestAlmUsage,
    RallarBlackBoxTestResult
} from '@shared-test/rallar-bb-test/rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '@shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { AL_PUBLICATION_STAGE_LIMITS } from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import { toIdleALOutboundCongestionEpisodeFigures } from '@shared/alm/outbound/congestion/al-outbound-congestion-episodes.ts';
import { toIdleALOutboundPublicationStageReport } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import { AL_VOLATILE_SESSION_LIMITS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';
import type { ApiJsonObject } from '@shared/api/api-json-value.ts';

import { IDLE_RALLAR_EDGE_ORDER_USAGE } from '../idle-rallar-edge-order-usage.ts';
import {
    createRecipes,
    FILLER,
    FRAME_TYPE_ID,
    POINT,
    toCommandsAfterBarrier,
    WS_LOSS_POINT
} from './publication-workload-test-point.ts';

const WINDOW_STARTED_AT_EPOCH_MS = 1_800_000_000_000;

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
        congestionEpisodes: toIdleALOutboundCongestionEpisodeFigures(),
        edgeOrder: IDLE_RALLAR_EDGE_ORDER_USAGE
    };
}

/**
 * What a control server and a page answer a publisher's barrier and fault commands: the barrier is released at once,
 * as by a control server whose subscribers already wait, and the fault's acted counts so far are none at the arm and
 * `droppedSends` at the release. Any other command gets no answer here.
 */
function toPublisherWindowAnswer(command: RallarBlackBoxTestCommand, droppedSends: number): ApiJsonObject | undefined {
    if (command.kind === 'barrier') {
        return { barrierId: command.barrierId, outcome: 'released', arrivedAgentIds: [] };
    }
    if (command.kind !== 'fault.inject') {
        return undefined;
    }
    const drop = 'remaining' in command && command.remaining === 0 ? droppedSends : 0;
    return {
        faultId: command.faultId,
        injected: true,
        acted: { drop, delay: 0, rewrite: 0, 'not-ready': 0, backpressure: 0 }
    };
}

/** The publisher's commands after the setup-complete barrier, run as one recipe of their own. */
function toPublisherWindowRecipeRun(point: PublicationWorkloadParameters): RallarBlackBoxTestCommand {
    return {
        kind: 'recipe.run',
        commandId: 'publisher-window',
        recipe: {
            schemaVersion: 1,
            recipeId: 'publisher-window',
            continueOnFailure: false,
            commands: toCommandsAfterBarrier(createRecipes(point).publisher.recipe, 'publication-workload-setup-complete')
        }
    };
}

/** Every command of a recipe's result that names its id and whether it passed, in the order it ran. */
function toRanCommands(recipeResult: RallarBlackBoxTestResult): readonly Readonly<{ commandId: string; ok: boolean; }>[] {
    const { value } = recipeResult;
    const ran = isJsonRecordValue(value) && Array.isArray(value.results) ? value.results : [];
    return ran.flatMap((entry) =>
        isJsonRecordValue(entry) && typeof entry.commandId === 'string' && typeof entry.ok === 'boolean'
            ? [{ commandId: entry.commandId, ok: entry.ok }]
            : []
    );
}

/** One copy of frame `index + 1` on the subscriber's inbound log, carrying `sentAtEpochMs` as its stamp. */
function toFrameCopyEvent(sentAtEpochMs: number | string, index: number): RallarBlackBoxBrowserRallarEvent {
    return {
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
     * values the stage handed to a carrier. Barriers and faults are answered by `toPublisherWindowAnswer`.
     */
    async function runPublisherWindow(
        point: PublicationWorkloadParameters,
        admittedByStage: number,
        droppedSends: number
    ): Promise<PublisherWindowRun> {
        let now = WINDOW_STARTED_AT_EPOCH_MS;
        const sends: RallarBlackBoxTestMessagesSendCommand[] = [];
        const runtime = createDefaultRallarBlackBoxTestRuntime({
            now: () => now,
            sleep: async (ms) => {
                now += ms;
            },
            readAlmUsage: async () => toPublisherAlmUsage(admittedByStage),
            commandExecutor: (command, context) => {
                const answer = toPublisherWindowAnswer(command, droppedSends);
                if (answer !== undefined) {
                    return { status: 'ok', value: answer, nextStatus: context.state().status };
                }
                if (command.kind !== 'messages.send' || !('carrier' in command)) {
                    return undefined;
                }
                sends.push(command);
                return { status: 'ok', value: {}, nextStatus: context.state().status };
            }
        });
        const result = await runtime.execute(toPublisherWindowRecipeRun(point));
        return {
            ok: result.ok,
            ranCommands: toRanCommands(result),
            failedCommandIds: runtime.state().failures.map((failure) => failure.commandId),
            sends,
            statsReadAtEpochMs: runtime.state().resultCache['publication-workload-publisher-stats']?.startedAtEpochMs
        };
    }

    it('sends frame n as the number n stamped with the clock of its send, the last one in exactly the declared 256 bytes', async () => {
        const run = await runPublisherWindow(POINT, 60, 0);

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
        const run = await runPublisherWindow(POINT, 60, 0);

        expect(run.statsReadAtEpochMs).toBe(1_800_000_029_500 + 5_100);
    });

    it('passes when its stage handed 57 of the 60 frames to a carrier; with 56, though all 60 sends returned, it fails its own assert, and only after it read its stats and met the subscribers at the complete barrier', async () => {
        const atThreshold = await runPublisherWindow(POINT, 57, 0);
        const belowThreshold = await runPublisherWindow(POINT, 56, 0);

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

    it('passes when the release read 18 dropped sends; with 0 it fails its loss-acted assert alone, after it read its stats and met the subscribers at the complete barrier', async () => {
        const acted = await runPublisherWindow(WS_LOSS_POINT, 60, 18);
        const unacted = await runPublisherWindow(WS_LOSS_POINT, 60, 0);

        expect({ ok: acted.ok, failedCommandIds: acted.failedCommandIds }).toEqual({ ok: true, failedCommandIds: [] });
        expect(unacted.sends).toHaveLength(60);
        expect(unacted.ok).toBe(false);
        expect(unacted.failedCommandIds).toEqual(['publication-workload-publisher-assert-loss-acted', 'publisher-window']);
        expect(unacted.ranCommands).toEqual([
            { commandId: 'publication-workload-publisher-loss-arm', ok: true },
            { commandId: 'publication-workload-publisher-frames', ok: true },
            { commandId: 'publication-workload-publisher-drain', ok: true },
            { commandId: 'publication-workload-publisher-loss-release', ok: true },
            { commandId: 'publication-workload-publisher-stats', ok: true },
            { commandId: 'publication-workload-publisher-complete', ok: true },
            { commandId: 'publication-workload-publisher-assert-accepted-sends', ok: true },
            { commandId: 'publication-workload-publisher-assert-loss-acted', ok: false }
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
    async function runSubscriberCount(
        point: PublicationWorkloadParameters,
        stamps: readonly (number | string)[]
    ): Promise<SubscriberCountRun> {
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
            runtime.receiveRallarBrowserEvent(toFrameCopyEvent(sentAtEpochMs, index));
        });
        const commands = toCommandsAfterBarrier(createRecipes(point).subscriber.recipe, 'publication-workload-complete')
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
        expect(await runSubscriberCount(POINT, toStamps(58))).toEqual({
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
        expect(await runSubscriberCount(POINT, [...toStamps(56), '{loop.atEpochMs}'])).toEqual({
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
        const run = await runSubscriberCount(POINT, toStamps(61));

        expect(run.observed).toBe(61);
        expect(run.failed).toEqual(['publication-workload-subscriber-assert-copies-within-frames']);
    });

    it('fails the count on 56 copies, one short of the 57 that 95 % of 60 frames asks for', async () => {
        const run = await runSubscriberCount(POINT, toStamps(56));

        expect(run.observed).toBe(56);
        expect(run.failed).toContain('publication-workload-subscriber-received');
    });

    it('has a subscriber of two publishers count 114 of their 120 frames and refuse a 121st', async () => {
        // Two publishers of 60 frames each: 120 frames, and 114 of 120 is 0.95.
        const twoPublishers = { ...POINT, publisherCount: 2 };
        const guards = [
            'publication-workload-subscriber-assert-every-copy-aged',
            'publication-workload-subscriber-assert-ages-cover-copies',
            'publication-workload-subscriber-assert-copies-within-frames'
        ];

        expect(await runSubscriberCount(twoPublishers, toStamps(113)))
            .toMatchObject({ observed: 113, passed: guards });
        expect(await runSubscriberCount(twoPublishers, toStamps(114)))
            .toEqual({ observed: 114, passed: ['publication-workload-subscriber-received', ...guards], failed: [] });
        expect(await runSubscriberCount(twoPublishers, toStamps(120)))
            .toEqual({ observed: 120, passed: ['publication-workload-subscriber-received', ...guards], failed: [] });
        expect(await runSubscriberCount(twoPublishers, toStamps(121))).toMatchObject({
            observed: 121,
            failed: ['publication-workload-subscriber-assert-copies-within-frames']
        });
    });

    it('counts 40 of the 42 frames a ws loss leaves and refuses a 43rd', async () => {
        // Seed 7 at 0.25 drops 18 of the 60 frames on ws: 42 reach a subscriber, and 40 of 42 is 0.95.
        const guards = [
            'publication-workload-subscriber-assert-every-copy-aged',
            'publication-workload-subscriber-assert-ages-cover-copies',
            'publication-workload-subscriber-assert-copies-within-frames'
        ];

        expect(await runSubscriberCount(WS_LOSS_POINT, toStamps(39)))
            .toMatchObject({ observed: 39, failed: ['publication-workload-subscriber-received'] });
        expect(await runSubscriberCount(WS_LOSS_POINT, toStamps(40)))
            .toEqual({ observed: 40, passed: ['publication-workload-subscriber-received', ...guards], failed: [] });
        expect(await runSubscriberCount(WS_LOSS_POINT, toStamps(42)))
            .toEqual({ observed: 42, passed: ['publication-workload-subscriber-received', ...guards], failed: [] });
        expect(await runSubscriberCount(WS_LOSS_POINT, toStamps(43))).toMatchObject({
            observed: 43,
            failed: ['publication-workload-subscriber-assert-copies-within-frames']
        });
    });
});
