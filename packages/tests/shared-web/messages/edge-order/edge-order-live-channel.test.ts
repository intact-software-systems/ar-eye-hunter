import { describe, expect, it, onTestFinished, vi } from 'vitest';

import type { EdgeOrderStamp } from '@shared-web/browser/messages/edge-order/edge-order-stamp.ts';
import type { RallarRoomMessageChannelDefinition } from '@shared-web/browser/messages/rallar-message-contracts.ts';
import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from '../browser-message-sender-fixture.ts';
import { createEdgeOrderPage, EDGE_ORDER_TEST_ROOM } from './edge-order-page-fixture.ts';

const START_MS = 1_760_000_000_000;
/** A boundary inside a live value's 1 s deadline, so a test can run the lane's next opportunity. */
const POSE_PUBLICATION: ALPublicationPolicy = { cadenceMs: 500, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };
const POSE_TYPE_ID = 'arena.pose.v1';

/** The live, edge-ordered channel a receiving page declares for the poses. */
const LIVE_POSES: RallarRoomMessageChannelDefinition = {
    roomRef: EDGE_ORDER_TEST_ROOM,
    typeId: POSE_TYPE_ID,
    purpose: 'live',
    access: 'members',
    publication: POSE_PUBLICATION,
    order: 'edge'
};

/** The same channel as the message sender is handed it. */
const LIVE_POSES_POLICY: BrowserTypedChannelPolicy = {
    purpose: 'live',
    access: 'members',
    durability: undefined,
    onStorageUnavailable: 'refuse',
    publication: POSE_PUBLICATION,
    order: 'edge'
};

interface Pose {
    readonly seq: number;
}

interface LivePage extends ReturnType<typeof createBrowserMessageSenderFixture> {
    readonly engine: InboxOutboxEngine;
    /** Every envelope the RTC carrier admitted, in admission order. */
    readonly admitted: ALMessage[];
}

/** One frozen clock, read by the sender, the stage and the engine, keeps every value inside its 1 s deadline. */
function createLivePage(maxPayloadBytes?: number): LivePage {
    vi.useFakeTimers({ toFake: ['Date'], now: START_MS });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const engine = new InboxOutboxEngine({
        nowEpochMs: () => Date.now(),
        random: () => 0.5,
        reportTaskFailure: () => undefined
    });
    const middleware = createDefaultApiMiddlewareTestDouble({ middleware: { qboxEngine: engine } });
    const fixture = createBrowserMessageSenderFixture(maxPayloadBytes, undefined, middleware);
    const admitted: ALMessage[] = [];
    middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message: ALMessage) => {
        admitted.push(message);
        return await Promise.resolve(toQueuedMessageAdmission(message));
    };
    return { ...fixture, engine, admitted };
}

async function sendPose(page: LivePage, resourceId: string, seq: number) {
    return await page.sender.sendRtc({ typeId: POSE_TYPE_ID, roomId: 'room', resourceId, payload: { seq } }, LIVE_POSES_POLICY);
}

/** Runs the lane's next opportunity: one engine pass at its next boundary. */
async function runNextOpportunity(page: LivePage): Promise<void> {
    vi.setSystemTime(Date.now() + POSE_PUBLICATION.cadenceMs);
    await page.engine.executeOnce();
    await page.engine.stop();
}

/** What an admitted envelope carries: its stamp beside the application's pose. */
function readWire(message: ALMessage): { readonly edgeOrder: EdgeOrderStamp; readonly payload: Pose; } {
    return JSON.parse(message.payload.resource);
}

describe('an edge-ordered live channel: the position', () => {
    it('is taken when the value leaves the stage, so a value displaced on the stage takes none', async () => {
        const page = createLivePage();
        // The first value finds its lane idle and leaves at once; the next ones wait for the lane's next boundary.
        await sendPose(page, 'entity-1', 1);
        await vi.waitFor(() => expect(page.admitted).toHaveLength(1));
        const displaced = await sendPose(page, 'entity-1', 2);
        await sendPose(page, 'entity-1', 3);
        expect(displaced.lifecycle().state).toBe('superseded');

        await runNextOpportunity(page);

        expect(page.admitted.map(readWire)).toEqual([
            { edgeOrder: expect.objectContaining({ position: 1 }), payload: { seq: 1 } },
            { edgeOrder: expect.objectContaining({ position: 2 }), payload: { seq: 3 } }
        ]);
    });

    it('is numbered per live stream: each resource of the channel is a stream of its own', async () => {
        const page = createLivePage();
        await sendPose(page, 'entity-1', 1);
        await vi.waitFor(() => expect(page.admitted).toHaveLength(1));
        await sendPose(page, 'entity-2', 1);
        await sendPose(page, 'entity-1', 2);

        await runNextOpportunity(page);

        const stamps = new Map(page.admitted.map((message) => [
            `${message.route.resourceId} ${readWire(message).payload.seq}`,
            readWire(message).edgeOrder
        ]));
        expect(stamps.get('entity-1 1')?.position).toBe(1);
        expect(stamps.get('entity-1 2')?.position).toBe(2);
        expect(stamps.get('entity-2 1')?.position).toBe(1);
        expect(stamps.get('entity-2 1')?.stream).not.toBe(stamps.get('entity-1 1')?.stream);
        expect(stamps.get('entity-1 2')?.stream).toBe(stamps.get('entity-1 1')?.stream);
    });

    it('states no wait: nothing retries a live value, and the stream keeps nothing of it', async () => {
        const page = createLivePage();
        await sendPose(page, 'entity-1', 1);
        await vi.waitFor(() => expect(page.admitted).toHaveLength(1));
        await sendPose(page, 'entity-1', 2);

        await runNextOpportunity(page);

        expect(readWire(page.admitted[1]).edgeOrder).toEqual({
            stream: expect.any(String),
            position: 2,
            lowestOpenPosition: 2
        });
    });

    it('counts the wrapper against the payload limit when the value leaves the stage', async () => {
        const fits = JSON.stringify({ seq: 1 }).length;
        const page = createLivePage(fits + 10);

        const refused = await sendPose(page, 'entity-1', 1);
        await vi.waitFor(() => expect(refused.lifecycle().state).toBe('rejected'));

        expect(refused.lifecycle().evidence.reason).toContain('Payload exceeds');
        expect(page.admitted).toEqual([]);
    });
});

describe('an edge-ordered live channel: a receiving page', () => {
    it('hands the newest value over and drops the one that arrives after it, per stream', async () => {
        const alice = createLivePage();
        await sendPose(alice, 'entity-1', 1);
        await vi.waitFor(() => expect(alice.admitted).toHaveLength(1));
        await sendPose(alice, 'entity-1', 2);
        await sendPose(alice, 'entity-2', 1);
        await runNextOpportunity(alice);
        const byPose = new Map(alice.admitted.map((message) => [
            `${message.route.resourceId} ${readWire(message).payload.seq}`,
            message
        ]));
        const bob = createEdgeOrderPage({ sessionId: 'bob-session' });
        const seen: string[] = [];
        bob.messages.room<Pose>(LIVE_POSES).onRtc((pose, message) => {
            seen.push(`${message.resourceId} ${pose.seq}`);
        });

        // Entity 1's second value overtakes its first; entity 2's value arrives last and is still its newest.
        await bob.deliver('rtc', byPose.get('entity-1 2')!);
        await bob.deliver('rtc', byPose.get('entity-1 1')!);
        await bob.deliver('rtc', byPose.get('entity-2 1')!);

        expect(seen).toEqual(['entity-1 2', 'entity-2 1']);
        expect(bob.messages.readUsage().edgeOrder).toMatchObject({ streams: 2, lateDrops: 1, gaps: 0, heldMessages: 0 });
    });
});
