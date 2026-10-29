import { describe, expect, it, vi } from 'vitest';

import { newALUnicastMessage, type ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import {
    AL_PUBLICATION_STAGE_LIMITS,
    type ALPublicationStageLimits
} from '@shared/al-contracts/publication/al-publication-stage-limits.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALOutboundRuntimeDiagnosticsEvent } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { ALOutboundPublicationStage } from '@shared/alm/outbound/publication/al-outbound-publication-stage.ts';
import type { ALOutboundStagedPublication } from '@shared/alm/outbound/publication/al-outbound-staged-publication.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

const START_MS = 1_760_000_000_000;
const TASK_ID = 'al-outbound-publication-stage';
const VALUE_BYTES = 100;
const LIVE_TTL_MS = 5_000;
const LATEST_POLICY: ALPublicationPolicy = { cadenceMs: 100, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

interface StageFixture {
    readonly clock: { atMs: number; };
    readonly engine: InboxOutboxEngine;
    readonly stage: ALOutboundPublicationStage<string>;
    /** The contexts of each `submit` call, in call order. */
    readonly submitted: string[][];
    readonly settlements: ALDeliverySettlement[];
    readonly diagnostics: ALOutboundRuntimeDiagnosticsEvent[];
    readonly reportTaskFailure: ReturnType<typeof vi.fn>;
}

type OpportunityDiagnostic = Extract<ALOutboundRuntimeDiagnosticsEvent, { kind: 'publication-opportunity'; }>;

interface StageFixtureOptions {
    readonly submit?: (selected: readonly ALOutboundStagedPublication<string>[]) => Promise<void>;
    readonly limits?: Partial<ALPublicationStageLimits>;
}

function createStageFixture(options?: StageFixtureOptions): StageFixture {
    const clock = { atMs: START_MS };
    const reportTaskFailure = vi.fn(() => undefined);
    const engine = new InboxOutboxEngine({ nowEpochMs: () => clock.atMs, random: () => 0.5, reportTaskFailure });
    const submitted: string[][] = [];
    const settlements: ALDeliverySettlement[] = [];
    const diagnostics: ALOutboundRuntimeDiagnosticsEvent[] = [];
    const stage = new ALOutboundPublicationStage<string>({
        taskId: TASK_ID,
        queueEngine: engine,
        clock: { nowMs: () => clock.atMs },
        limits: { ...AL_PUBLICATION_STAGE_LIMITS, ...options?.limits },
        submit: options?.submit ?? (async (selected) => {
            submitted.push(selected.map((publication) => publication.context));
        }),
        settle: (settlement) => settlements.push(settlement),
        diagnostics: (event) => diagnostics.push(event)
    });
    return { clock, engine, stage, submitted, settlements, diagnostics, reportTaskFailure };
}

function createLiveMessage(topicId: string, resourceId: string, expiresAtMs: number): ALMessage {
    const message = newALUnicastMessage(
        'self',
        { topicId, resourceId, contextId: 'room-1' },
        'peer-1',
        `${topicId}.pose.v1`,
        { resourceId }
    );
    return { ...message, constraints: { expiresAtMs } };
}

function stageValue(
    fixture: StageFixture,
    context: string,
    options?: { topicId?: string; resourceId?: string; policy?: ALPublicationPolicy; ttlMs?: number; bytes?: number; }
): ALOutboundPublicationStage.StageResult & { readonly msgId: string; } {
    const msg = createLiveMessage(
        options?.topicId ?? 'arena',
        options?.resourceId ?? 'entity-1',
        fixture.clock.atMs + (options?.ttlMs ?? LIVE_TTL_MS)
    );
    const result = fixture.stage.stage({
        msg,
        carrier: 'rtc',
        policy: options?.policy ?? LATEST_POLICY,
        bytes: options?.bytes ?? VALUE_BYTES,
        context
    });
    return { ...result, msgId: msg.id.msgId };
}

/** Runs one engine pass and joins the runnable it started: `stop` awaits the work the engine owns. */
async function runEnginePass(engine: InboxOutboxEngine): Promise<void> {
    await engine.executeOnce();
    await engine.stop();
}

function opportunitiesOf(diagnostics: readonly ALOutboundRuntimeDiagnosticsEvent[]): readonly OpportunityDiagnostic[] {
    return diagnostics.filter((event): event is OpportunityDiagnostic => event.kind === 'publication-opportunity');
}

describe('ALOutboundPublicationStage', () => {
    it('settles a value staged and submits it at the next pass when its lane was idle', async () => {
        const fixture = createStageFixture();

        const staged = stageValue(fixture, 'v1');

        expect(staged).toMatchObject({ kind: 'staged', displacedMsgId: undefined });
        expect(fixture.settlements).toEqual([
            expect.objectContaining({ kind: 'staged', msgId: staged.msgId, carrier: 'rtc', atMs: START_MS })
        ]);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toEqual({
            laneKey: 'arena/arena.pose.v1',
            policy: LATEST_POLICY,
            nextOpportunityAtMs: START_MS,
            staged: 1,
            streams: 1
        });

        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['v1']]);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({
            nextOpportunityAtMs: START_MS + LATEST_POLICY.cadenceMs,
            staged: 0,
            streams: 0
        });
    });

    it('brings a started engine\'s next pass forward when a value lands on an idle lane', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const fixture = createStageFixture();
            fixture.engine.start();
            await vi.advanceTimersByTimeAsync(1_000);

            stageValue(fixture, 'v1');
            await vi.advanceTimersByTimeAsync(0);

            expect(fixture.submitted).toEqual([['v1']]);
            await fixture.engine.stop();
        }
        finally {
            vi.useRealTimers();
        }
    });

    it('holds a value staged while an opportunity awaits submit until the lane\'s next boundary', async () => {
        let releaseSubmit: () => void = () => undefined;
        const submitHeld = new Promise<void>((resolve) => {
            releaseSubmit = resolve;
        });
        const submitted: string[][] = [];
        const fixture = createStageFixture({
            submit: async (selected) => {
                submitted.push(selected.map((publication) => publication.context));
                if (submitted.length === 1) {
                    await submitHeld;
                }
            }
        });
        stageValue(fixture, 'v1');
        const pass = fixture.engine.executeOnce();
        await vi.waitFor(() => expect(submitted).toEqual([['v1']]));

        fixture.clock.atMs += 10;
        const midSubmit = stageValue(fixture, 'v2');
        releaseSubmit();
        await pass;
        await fixture.engine.stop();

        expect(midSubmit).toMatchObject({ kind: 'staged', displacedMsgId: undefined });
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({
            nextOpportunityAtMs: START_MS + LATEST_POLICY.cadenceMs,
            staged: 1
        });
        await runEnginePass(fixture.engine);
        expect(submitted).toEqual([['v1']]);

        fixture.clock.atMs = START_MS + LATEST_POLICY.cadenceMs;
        await runEnginePass(fixture.engine);
        expect(submitted).toEqual([['v1'], ['v2']]);
        expect(fixture.settlements.filter((settlement) => settlement.kind === 'superseded')).toEqual([]);
    });

    it('admits only the newest of the values staged within one cadence and supersedes the rest', async () => {
        const fixture = createStageFixture();
        stageValue(fixture, 'v1');
        await runEnginePass(fixture.engine);

        const later = ['v2', 'v3', 'v4', 'v5'].map((context) => {
            fixture.clock.atMs += 10;
            return stageValue(fixture, context);
        });
        await runEnginePass(fixture.engine);
        expect(fixture.submitted).toEqual([['v1']]);

        fixture.clock.atMs = START_MS + LATEST_POLICY.cadenceMs;
        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['v1'], ['v5']]);
        expect(later.map((result) => result.kind === 'staged' ? result.displacedMsgId : result.reason)).toEqual([
            undefined,
            later[0]?.msgId,
            later[1]?.msgId,
            later[2]?.msgId
        ]);
        const superseded = fixture.settlements.filter((settlement) => settlement.kind === 'superseded');
        expect(superseded.map((settlement) => [settlement.msgId, settlement.replacementMsgId])).toEqual([
            [later[0]?.msgId, later[1]?.msgId],
            [later[1]?.msgId, later[2]?.msgId],
            [later[2]?.msgId, later[3]?.msgId]
        ]);
    });

    it('keeps two lanes with different cadences on independent opportunities', async () => {
        const fixture = createStageFixture();
        const slowPolicy: ALPublicationPolicy = { ...LATEST_POLICY, cadenceMs: 300 };
        stageValue(fixture, 'fast-1', { topicId: 'fast' });
        stageValue(fixture, 'slow-1', { topicId: 'slow', policy: slowPolicy });
        await runEnginePass(fixture.engine);
        expect(fixture.submitted.flat()).toEqual(['fast-1', 'slow-1']);

        fixture.clock.atMs += 10;
        stageValue(fixture, 'fast-2', { topicId: 'fast' });
        stageValue(fixture, 'slow-2', { topicId: 'slow', policy: slowPolicy });

        fixture.clock.atMs = START_MS + 100;
        await runEnginePass(fixture.engine);
        expect(fixture.submitted.flat()).toEqual(['fast-1', 'slow-1', 'fast-2']);

        fixture.clock.atMs = START_MS + 200;
        await runEnginePass(fixture.engine);
        expect(fixture.submitted.flat()).toEqual(['fast-1', 'slow-1', 'fast-2']);

        fixture.clock.atMs = START_MS + 300;
        await runEnginePass(fixture.engine);
        expect(fixture.submitted.flat()).toEqual(['fast-1', 'slow-1', 'fast-2', 'slow-2']);
        expect(fixture.stage.readLane('fast/fast.pose.v1')?.nextOpportunityAtMs).toBeUndefined();
        expect(fixture.stage.readLane('slow/slow.pose.v1')?.nextOpportunityAtMs).toBe(START_MS + 600);
    });

    it('wakes the engine at the earliest next opportunity and not at all once every lane is idle', async () => {
        const fixture = createStageFixture();
        const wakeAt = vi.spyOn(fixture.engine, 'wakeAt');
        stageValue(fixture, 'fast-1', { topicId: 'fast' });
        stageValue(fixture, 'slow-1', { topicId: 'slow', policy: { ...LATEST_POLICY, cadenceMs: 300 } });

        await runEnginePass(fixture.engine);
        expect(wakeAt).toHaveBeenLastCalledWith(TASK_ID, START_MS + 100);

        fixture.clock.atMs = START_MS + 100;
        await runEnginePass(fixture.engine);
        expect(wakeAt).toHaveBeenLastCalledWith(TASK_ID, START_MS + 300);

        fixture.clock.atMs = START_MS + 300;
        await runEnginePass(fixture.engine);
        expect(wakeAt).toHaveBeenLastCalledWith(TASK_ID, undefined);
    });

    it('runs one opportunity, not a catch-up burst, when the engine reaches a lane ten cadences late', async () => {
        const fixture = createStageFixture();
        stageValue(fixture, 'v1');
        await runEnginePass(fixture.engine);
        fixture.clock.atMs += 10;
        stageValue(fixture, 'v2');

        fixture.clock.atMs = START_MS + 10 * LATEST_POLICY.cadenceMs;
        await runEnginePass(fixture.engine);
        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['v1'], ['v2']]);
        expect(opportunitiesOf(fixture.diagnostics)).toHaveLength(2);
        expect(fixture.stage.readLane('arena/arena.pose.v1')?.nextOpportunityAtMs).toBe(
            START_MS + 11 * LATEST_POLICY.cadenceMs
        );
    });

    it('settles a value whose deadline passed before its opportunity expired and never submits it', async () => {
        const fixture = createStageFixture();
        const staged = stageValue(fixture, 'v1', { ttlMs: 0 });

        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([]);
        expect(fixture.settlements.map((settlement) => [settlement.kind, settlement.msgId])).toEqual([
            ['staged', staged.msgId],
            ['expired', staged.msgId]
        ]);
        expect(opportunitiesOf(fixture.diagnostics)).toEqual([
            expect.objectContaining({ selected: 0, deferred: 0, expired: 1, bytes: 0 })
        ]);
    });

    it('refuses a value heavier than the drain budget without settling or staging it', () => {
        const fixture = createStageFixture();

        const refused = stageValue(fixture, 'v1', { bytes: LATEST_POLICY.drain.bytes + 1 });

        expect(refused).toMatchObject({ kind: 'refused', reason: 'oversized' });
        expect(fixture.settlements).toEqual([]);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toBeUndefined();
    });

    it('refuses a value past the staged-values limit across its lanes, settling and staging nothing for it', () => {
        const fixture = createStageFixture({ limits: { maxStagedValues: 2 } });
        const policy: ALPublicationPolicy = { ...LATEST_POLICY, retainNewest: 2 };
        stageValue(fixture, 'v1', { resourceId: 'entity-1', policy });
        stageValue(fixture, 'v2', { topicId: 'other', resourceId: 'entity-2', policy });

        const refused = stageValue(fixture, 'v3', { resourceId: 'entity-1', policy });

        expect(refused).toEqual({
            kind: 'refused',
            reason: 'capacity',
            limit: 'staged-values',
            detail: 'Staging the value would hold 3 values, past the stage\'s limit of 2.',
            msgId: refused.msgId
        });
        expect(fixture.settlements.map((settlement) => settlement.kind)).toEqual(['staged', 'staged']);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({ staged: 1, streams: 1 });
        expect(fixture.stage.readReport()).toMatchObject({ streams: 2, staged: 2, stagedBytes: 2 * VALUE_BYTES });
    });

    it('stages a value on a full stage when retention displaces the oldest of its stream', () => {
        const fixture = createStageFixture({
            limits: { maxStreams: 2, maxStagedValues: 2, maxStagedBytes: 2 * VALUE_BYTES }
        });
        const first = stageValue(fixture, 'v1', { resourceId: 'entity-1' });
        stageValue(fixture, 'v2', { resourceId: 'entity-2' });

        const replacing = stageValue(fixture, 'v3', { resourceId: 'entity-1' });

        expect(replacing).toMatchObject({ kind: 'staged', displacedMsgId: first.msgId });
        expect(fixture.stage.readReport()).toMatchObject({ streams: 2, staged: 2, stagedBytes: 2 * VALUE_BYTES });
    });

    it.each([
        {
            limits: { maxStreams: 1, maxStagedValues: 1, maxStagedBytes: VALUE_BYTES },
            limit: 'streams',
            detail: 'Staging the value would open stream 2, past the stage\'s limit of 1.'
        },
        {
            limits: { maxStreams: 2, maxStagedValues: 1, maxStagedBytes: VALUE_BYTES },
            limit: 'staged-values',
            detail: 'Staging the value would hold 2 values, past the stage\'s limit of 1.'
        },
        {
            limits: { maxStreams: 2, maxStagedValues: 2, maxStagedBytes: VALUE_BYTES + 50 },
            limit: 'staged-bytes',
            detail: `Staging the value would hold ${2 * VALUE_BYTES} bytes, past the stage's limit of ${VALUE_BYTES + 50}.`
        }
    ])('refuses a value on a new stream at the first limit it passes: $limit', ({ limits, limit, detail }) => {
        const fixture = createStageFixture({ limits });
        stageValue(fixture, 'v1', { resourceId: 'entity-1' });

        const refused = stageValue(fixture, 'v2', { resourceId: 'entity-2' });

        expect(refused).toMatchObject({ kind: 'refused', reason: 'capacity', limit, detail });
        expect(fixture.stage.readReport()).toMatchObject({ streams: 1, staged: 1, counters: { staged: 1, refused: 1 } });
    });

    it('refuses a value heavier than the drain budget before it reads the stage\'s limits', () => {
        const fixture = createStageFixture({ limits: { maxStreams: 1 } });
        stageValue(fixture, 'v1', { resourceId: 'entity-1' });

        const refused = stageValue(fixture, 'v2', { resourceId: 'entity-2', bytes: LATEST_POLICY.drain.bytes + 1 });

        expect(refused).toMatchObject({ kind: 'refused', reason: 'oversized' });
    });

    it('reports its totals, limits and every outcome it settled across a stage, displace, expire and opportunity', async () => {
        const limits = { maxStreams: 8, maxStagedValues: 16, maxStagedBytes: 65_536 };
        const fixture = createStageFixture({ limits });
        const policy: ALPublicationPolicy = { cadenceMs: 500, retainNewest: 2, drain: { messages: 1, bytes: 65_536 } };
        ['a1', 'a2', 'a3'].forEach((context) => stageValue(fixture, context, { policy }));
        stageValue(fixture, 'b1', { resourceId: 'entity-2', policy, ttlMs: 0 });
        stageValue(fixture, 'c1', { resourceId: 'entity-3', policy, bytes: policy.drain.bytes + 1 });
        expect(fixture.stage.readReport()).toEqual({
            lanes: 1,
            streams: 2,
            staged: 3,
            stagedBytes: 3 * VALUE_BYTES,
            limits,
            counters: { staged: 4, superseded: 1, expired: 0, refused: 1, cancelled: 0, admitted: 0, deferred: 0 }
        });

        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['a2']]);
        expect(fixture.stage.readReport()).toEqual({
            lanes: 1,
            streams: 1,
            staged: 1,
            stagedBytes: VALUE_BYTES,
            limits,
            counters: { staged: 4, superseded: 1, expired: 1, refused: 1, cancelled: 0, admitted: 1, deferred: 1 }
        });
    });

    it('reports each opportunity with the counts it selected, deferred and expired', async () => {
        const fixture = createStageFixture();
        const policy: ALPublicationPolicy = { cadenceMs: 500, retainNewest: 3, drain: { messages: 2, bytes: 65_536 } };
        stageValue(fixture, 'v1', { policy });
        await runEnginePass(fixture.engine);
        ['v2', 'v3', 'v4', 'v5'].forEach((context) => {
            fixture.clock.atMs += 10;
            stageValue(fixture, context, { policy });
        });

        fixture.clock.atMs = START_MS + policy.cadenceMs;
        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['v1'], ['v3', 'v4']]);
        expect(opportunitiesOf(fixture.diagnostics)).toEqual([
            {
                kind: 'publication-opportunity',
                laneKey: 'arena/arena.pose.v1',
                atMs: START_MS,
                selected: 1,
                deferred: 0,
                expired: 0,
                bytes: VALUE_BYTES
            },
            {
                kind: 'publication-opportunity',
                laneKey: 'arena/arena.pose.v1',
                atMs: START_MS + policy.cadenceMs,
                selected: 2,
                deferred: 1,
                expired: 0,
                bytes: 2 * VALUE_BYTES
            }
        ]);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({ staged: 1, streams: 1 });

        fixture.clock.atMs = START_MS + 2 * policy.cadenceMs;
        await runEnginePass(fixture.engine);
        expect(fixture.submitted).toEqual([['v1'], ['v3', 'v4'], ['v5']]);
        expect(opportunitiesOf(fixture.diagnostics).at(-1)).toMatchObject({
            selected: 1,
            deferred: 0,
            bytes: VALUE_BYTES
        });
    });

    it('settles each selected value failed when submit throws and keeps the engine task healthy', async () => {
        const fixture = createStageFixture({ submit: () => Promise.reject(new Error('leg write failed')) });
        const staged = stageValue(fixture, 'v1');

        await runEnginePass(fixture.engine);

        expect(fixture.settlements.at(-1)).toMatchObject({
            kind: 'admission',
            msgId: staged.msgId,
            verdict: { kind: 'failed', detail: 'leg write failed' },
            trackedReceiptAlgo: 'none'
        });
        expect(fixture.stage.readReport()).toMatchObject({
            streams: 0,
            staged: 0,
            stagedBytes: 0,
            counters: { admitted: 1 }
        });
        expect(fixture.reportTaskFailure).not.toHaveBeenCalled();
    });

    it('writes no opportunity report for a submit that resolves after dispose', async () => {
        let releaseSubmit: () => void = () => undefined;
        const submitHeld = new Promise<void>((resolve) => {
            releaseSubmit = resolve;
        });
        const submitted: string[][] = [];
        const fixture = createStageFixture({
            submit: async (selected) => {
                submitted.push(selected.map((publication) => publication.context));
                await submitHeld;
            }
        });
        stageValue(fixture, 'v1');
        const pass = fixture.engine.executeOnce();
        await vi.waitFor(() => expect(submitted).toEqual([['v1']]));

        fixture.stage.dispose();
        releaseSubmit();
        await pass;
        await fixture.engine.stop();

        expect(opportunitiesOf(fixture.diagnostics)).toEqual([]);
    });

    it('settles every staged value skipped on dispose and leaves the engine', async () => {
        const fixture = createStageFixture();
        const excludeTask = vi.spyOn(fixture.engine, 'excludeTask');
        const first = stageValue(fixture, 'v1', { resourceId: 'entity-1' });
        const second = stageValue(fixture, 'v2', { resourceId: 'entity-2' });

        fixture.stage.dispose();
        await runEnginePass(fixture.engine);

        expect(excludeTask).toHaveBeenCalledWith(TASK_ID);
        expect(fixture.submitted).toEqual([]);
        const disposed = fixture.settlements.filter((settlement) => settlement.kind === 'admission');
        expect(disposed.map((settlement) => settlement.msgId)).toEqual([first.msgId, second.msgId]);
        expect(disposed.map((settlement) => settlement.verdict)).toEqual([
            expect.objectContaining({ kind: 'skipped', reason: 'disposed' }),
            expect.objectContaining({ kind: 'skipped', reason: 'disposed' })
        ]);
        expect(fixture.stage.readReport()).toMatchObject({ lanes: 0, streams: 0, staged: 0, stagedBytes: 0 });
        expect(() => stageValue(fixture, 'v3')).toThrow('The publication stage is disposed.');
    });

    it('serves the streams of a lane in turn when its drain takes one value per opportunity', async () => {
        const fixture = createStageFixture();
        const policy: ALPublicationPolicy = { cadenceMs: 100, retainNewest: 2, drain: { messages: 1, bytes: 65_536 } };
        ['a1', 'a2'].forEach((context) => stageValue(fixture, context, { resourceId: 'entity-a', policy }));
        ['b1', 'b2'].forEach((context) => stageValue(fixture, context, { resourceId: 'entity-b', policy }));

        for (const opportunity of [0, 1, 2, 3]) {
            fixture.clock.atMs = START_MS + opportunity * policy.cadenceMs;
            await runEnginePass(fixture.engine);
        }

        expect(fixture.submitted).toEqual([['a1'], ['b1'], ['a2'], ['b2']]);
    });

    it('keeps its turn on the next stream when the stream it served empties', async () => {
        const fixture = createStageFixture();
        const policy: ALPublicationPolicy = { cadenceMs: 100, retainNewest: 2, drain: { messages: 1, bytes: 65_536 } };
        stageValue(fixture, 'a1', { resourceId: 'entity-a', policy });
        ['b1', 'b2'].forEach((context) => stageValue(fixture, context, { resourceId: 'entity-b', policy }));
        ['c1', 'c2'].forEach((context) => stageValue(fixture, context, { resourceId: 'entity-c', policy }));

        for (const opportunity of [0, 1, 2, 3, 4]) {
            fixture.clock.atMs = START_MS + opportunity * policy.cadenceMs;
            await runEnginePass(fixture.engine);
        }

        expect(fixture.submitted).toEqual([['a1'], ['b1'], ['c1'], ['b2'], ['c2']]);
    });

    it('cancels a staged value: it settles cancelled, is never submitted, and is counted', async () => {
        const fixture = createStageFixture();
        const staged = stageValue(fixture, 'v1');

        expect(fixture.stage.cancel(staged.msgId)).toBe(true);
        expect(fixture.stage.cancel(staged.msgId)).toBe(false);
        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([]);
        expect(fixture.settlements).toEqual([
            expect.objectContaining({ kind: 'staged', msgId: staged.msgId }),
            expect.objectContaining({ kind: 'cancelled', msgId: staged.msgId, carrier: 'rtc', atMs: START_MS })
        ]);
        expect(fixture.stage.readReport()).toMatchObject({
            streams: 0,
            staged: 0,
            stagedBytes: 0,
            counters: { staged: 1, cancelled: 1, admitted: 0 }
        });
    });

    it('answers a cancel of a value it does not hold, or one an opportunity already selected, false', async () => {
        let releaseSubmit: () => void = () => undefined;
        const submitHeld = new Promise<void>((resolve) => {
            releaseSubmit = resolve;
        });
        const submitted: string[][] = [];
        const fixture = createStageFixture({
            submit: async (selected) => {
                submitted.push(selected.map((publication) => publication.context));
                await submitHeld;
            }
        });
        expect(fixture.stage.cancel('unknown-msg')).toBe(false);
        const staged = stageValue(fixture, 'v1');
        const pass = fixture.engine.executeOnce();
        await vi.waitFor(() => expect(submitted).toEqual([['v1']]));

        expect(fixture.stage.cancel(staged.msgId)).toBe(false);
        releaseSubmit();
        await pass;
        await fixture.engine.stop();

        expect(fixture.settlements.map((settlement) => settlement.kind)).toEqual(['staged']);
        expect(fixture.stage.readReport().counters).toMatchObject({ cancelled: 0, admitted: 1 });
    });

    it('supersedes the oldest values of each stream by its newest when a send shrinks the lane\'s retention', () => {
        const fixture = createStageFixture();
        const wide: ALPublicationPolicy = { ...LATEST_POLICY, retainNewest: 3 };
        const [first, second, third] = ['v1', 'v2', 'v3'].map((context) => stageValue(fixture, context, { policy: wide }));

        stageValue(fixture, 'w1', { resourceId: 'entity-2', policy: LATEST_POLICY });

        const superseded = fixture.settlements.filter((settlement) => settlement.kind === 'superseded');
        expect(superseded.map((settlement) => [settlement.msgId, settlement.replacementMsgId, settlement.detail])).toEqual(
            [first, second].map((displaced) => [
                displaced?.msgId,
                third?.msgId,
                'The live channel\'s retention shrank, and newer values of the stream displaced it.'
            ])
        );
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({
            policy: LATEST_POLICY,
            staged: 2,
            streams: 2
        });
        expect(fixture.stage.readReport().counters).toMatchObject({ staged: 4, superseded: 2 });
    });

    it('keeps every staged value when a send grows the lane\'s retention', () => {
        const fixture = createStageFixture();
        const wide: ALPublicationPolicy = { ...LATEST_POLICY, retainNewest: 3 };
        stageValue(fixture, 'v1');

        const grown = stageValue(fixture, 'v2', { policy: wide });

        expect(grown).toMatchObject({ kind: 'staged', displacedMsgId: undefined });
        expect(fixture.settlements.map((settlement) => settlement.kind)).toEqual(['staged', 'staged']);
        expect(fixture.stage.readLane('arena/arena.pose.v1')).toMatchObject({ policy: wide, staged: 2, streams: 1 });
    });

    it('refuses a staged value heavier than the lane\'s new drain budget oversized', () => {
        const fixture = createStageFixture();
        const narrow: ALPublicationPolicy = { ...LATEST_POLICY, drain: { messages: 8, bytes: 200 } };
        const heavy = stageValue(fixture, 'heavy', { bytes: 500 });

        stageValue(fixture, 'light', { resourceId: 'entity-2', policy: narrow });

        expect(fixture.settlements.filter((settlement) => settlement.msgId === heavy.msgId)).toEqual([
            expect.objectContaining({ kind: 'staged' }),
            expect.objectContaining({
                kind: 'admission',
                atMs: START_MS,
                verdict: {
                    kind: 'refused',
                    reason: 'oversized',
                    detail: 'A live value of 500 bytes exceeds the drain budget of 200.'
                },
                trackedReceiptAlgo: 'none'
            })
        ]);
        expect(fixture.stage.readReport()).toMatchObject({ staged: 1, stagedBytes: VALUE_BYTES, counters: { refused: 1 } });
    });

    it('moves the next boundary earlier when a send shrinks the cadence, and runs one opportunity there', async () => {
        const fixture = createStageFixture();
        const slow: ALPublicationPolicy = { ...LATEST_POLICY, cadenceMs: 500 };
        const fast: ALPublicationPolicy = { ...LATEST_POLICY, cadenceMs: 200 };
        stageValue(fixture, 'v1', { policy: slow });
        await runEnginePass(fixture.engine);
        fixture.clock.atMs = START_MS + 100;
        stageValue(fixture, 'v2', { policy: slow });

        fixture.clock.atMs = START_MS + 150;
        stageValue(fixture, 'v3', { policy: fast });

        expect(fixture.stage.readLane('arena/arena.pose.v1')?.nextOpportunityAtMs).toBe(START_MS + 200);
        fixture.clock.atMs = START_MS + 200;
        await runEnginePass(fixture.engine);
        fixture.clock.atMs = START_MS + 500;
        await runEnginePass(fixture.engine);

        expect(fixture.submitted).toEqual([['v1'], ['v3']]);
        expect(opportunitiesOf(fixture.diagnostics)).toHaveLength(2);
    });
});
