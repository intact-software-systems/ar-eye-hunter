import type { BrowserDeliverySettlements } from '@shared-web/browser/connection/browser-delivery-settlements.ts';
import { BrowserPublicationStages } from '@shared-web/browser/messages/publication/browser-publication-stages.ts';
import { toBrowserPublicationDelivery } from '@shared-web/browser/messages/publication/to-browser-publication-delivery.ts';
import type { ApiMiddleware } from '@shared-web/browser/rallar-connection-facade.ts';
import { newALMulticastMessage, newALRoute } from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALDeliverySettlement } from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { describe, expect, it } from 'vitest';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';

const START_MS = 1_760_000_000_000;
const LANE_KEY = 'arena/arena.pose.v1';
const ROOM_REF = { applicationId: 'app', workspaceId: 'workspace', groupId: 'room' };
const LIVE_POLICY: ALPublicationPolicy = { cadenceMs: 500, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

interface StagesFixture {
    readonly clock: { atMs: number; };
    readonly stages: BrowserPublicationStages;
    readonly settlements: ALDeliverySettlement[];
    /** The msgId of each delivery `submit` received, in submission order, with the epoch it was staged in. */
    readonly submitted: { readonly msgId: string; readonly epoch: BrowserDeliverySettlements.Epoch; }[];
}

interface ConnectFixture {
    readonly context: ApiMiddleware;
    readonly engine: InboxOutboxEngine;
    readonly epoch: BrowserDeliverySettlements.Epoch;
}

function createStagesFixture(): StagesFixture {
    const clock = { atMs: START_MS };
    const settlements: ALDeliverySettlement[] = [];
    const submitted: StagesFixture['submitted'] = [];
    const stages = new BrowserPublicationStages({
        nowMs: () => clock.atMs,
        settle: (settlement) => settlements.push(settlement),
        submit: async (delivery, epoch) => {
            submitted.push({ msgId: delivery.message.id.msgId, epoch });
            return await Promise.resolve();
        }
    });
    return { clock, stages, settlements, submitted };
}

function createConnect(clock: StagesFixture['clock']): ConnectFixture {
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => clock.atMs,
        random: () => 0.5,
        reportTaskFailure: () => undefined
    });
    const sink = () => {};
    return {
        context: createDefaultApiMiddlewareTestDouble({ middleware: { qboxEngine: engine } }),
        engine,
        epoch: { settlements: { ws: sink, rtc: sink }, isOpen: () => true, close: () => {} }
    };
}

function toLiveDelivery(
    connect: ConnectFixture,
    resourceId: string,
    publication: ALPublicationPolicy = LIVE_POLICY
): BrowserPublicationStages.LiveDelivery {
    const message = newALMulticastMessage(
        'session-1',
        newALRoute('arena', 'room', resourceId),
        ROOM_REF,
        'arena.pose.v1',
        { resourceId, text: 'pose' },
        { ttlMs: 1_000, reliability: 'best-effort', ack: 'none' }
    );
    const live = toBrowserPublicationDelivery(message, {
        purpose: 'live',
        durability: undefined,
        onStorageUnavailable: 'refuse',
        publication
    });
    if (live.publication === undefined) {
        throw new Error('A live channel\'s delivery carries its publication.');
    }
    return {
        requestedConfiguration: undefined,
        rtcCapture: { status: 'unavailable', reason: 'absent' },
        context: connect.context,
        carrier: 'rtc',
        message: live.message,
        canFallback: false,
        payloadIssues: [],
        onStorageUnavailable: 'refuse',
        publication: live.publication
    };
}

/** Runs one engine pass and joins the runnable it started: `stop` awaits the work the engine owns. */
async function runEnginePass(engine: InboxOutboxEngine): Promise<void> {
    await engine.executeOnce();
    await engine.stop();
}

describe('BrowserPublicationStages', () => {
    it('stages every live delivery of one connect on that connect\'s stage and submits them at its opportunity', async () => {
        const fixture = createStagesFixture();
        const connect = createConnect(fixture.clock);
        const first = toLiveDelivery(connect, 'entity-1');
        const second = toLiveDelivery(connect, 'entity-2');

        fixture.stages.stage(first, connect.epoch);
        fixture.stages.stage(second, connect.epoch);

        expect(fixture.stages.readLane(connect.context, LANE_KEY)).toEqual({
            laneKey: LANE_KEY,
            policy: LIVE_POLICY,
            nextOpportunityAtMs: START_MS,
            staged: 2,
            streams: 2
        });
        expect(fixture.settlements.map((settlement) => [settlement.kind, settlement.msgId])).toEqual([
            ['staged', first.message.id.msgId],
            ['staged', second.message.id.msgId]
        ]);

        await runEnginePass(connect.engine);

        expect(fixture.submitted).toEqual([
            { msgId: first.message.id.msgId, epoch: connect.epoch },
            { msgId: second.message.id.msgId, epoch: connect.epoch }
        ]);
    });

    it('settles a displaced value superseded by the value that replaced it', () => {
        const fixture = createStagesFixture();
        const connect = createConnect(fixture.clock);
        const first = toLiveDelivery(connect, 'entity-1');
        const second = toLiveDelivery(connect, 'entity-1');

        fixture.stages.stage(first, connect.epoch);
        fixture.stages.stage(second, connect.epoch);

        expect(fixture.settlements).toContainEqual(expect.objectContaining({
            kind: 'superseded',
            msgId: first.message.id.msgId,
            replacementMsgId: second.message.id.msgId
        }));
    });

    it('disposes the stage of a replaced connect when a live delivery stages on the next one', async () => {
        const fixture = createStagesFixture();
        const replaced = createConnect(fixture.clock);
        const next = createConnect(fixture.clock);
        const stranded = toLiveDelivery(replaced, 'entity-1');
        const fresh = toLiveDelivery(next, 'entity-1');

        fixture.stages.stage(stranded, replaced.epoch);
        fixture.stages.stage(fresh, next.epoch);

        expect(fixture.settlements).toContainEqual(expect.objectContaining({
            kind: 'admission',
            msgId: stranded.message.id.msgId,
            verdict: expect.objectContaining({ kind: 'skipped', reason: 'disposed' })
        }));
        expect(fixture.stages.readLane(replaced.context, LANE_KEY)).toBeUndefined();
        expect(fixture.stages.readLane(next.context, LANE_KEY)).toMatchObject({ staged: 1 });

        await runEnginePass(replaced.engine);
        await runEnginePass(next.engine);

        expect(fixture.submitted.map((submission) => submission.msgId)).toEqual([fresh.message.id.msgId]);
    });

    it('settles every staged value skipped as disposed at session end, and stages afresh after it', async () => {
        const fixture = createStagesFixture();
        const connect = createConnect(fixture.clock);
        const ended = toLiveDelivery(connect, 'entity-1');
        const later = toLiveDelivery(connect, 'entity-1');

        fixture.stages.stage(ended, connect.epoch);
        fixture.stages.endSession();

        expect(fixture.settlements.at(-1)).toMatchObject({
            kind: 'admission',
            msgId: ended.message.id.msgId,
            verdict: { kind: 'skipped', reason: 'disposed' },
            trackedReceiptAlgo: 'none'
        });
        expect(fixture.stages.readLane(connect.context, LANE_KEY)).toBeUndefined();

        await runEnginePass(connect.engine);
        expect(fixture.submitted).toEqual([]);

        fixture.stages.stage(later, connect.epoch);
        await runEnginePass(connect.engine);
        expect(fixture.submitted.map((submission) => submission.msgId)).toEqual([later.message.id.msgId]);
    });

    it('refuses a delivery heavier than its drain budget oversized, staging nothing', () => {
        const fixture = createStagesFixture();
        const connect = createConnect(fixture.clock);
        const heavy = toLiveDelivery(connect, 'entity-1', { ...LIVE_POLICY, drain: { messages: 8, bytes: 64 } });

        fixture.stages.stage(heavy, connect.epoch);

        expect(fixture.settlements).toEqual([
            expect.objectContaining({
                kind: 'admission',
                msgId: heavy.message.id.msgId,
                carrier: 'rtc',
                atMs: START_MS,
                verdict: expect.objectContaining({ kind: 'refused', reason: 'oversized' }),
                trackedReceiptAlgo: 'none'
            })
        ]);
        expect(fixture.stages.readLane(connect.context, LANE_KEY)).toBeUndefined();
    });
});
