import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import { toALPublicationStreamKey } from '@shared/al-contracts/publication/to-al-publication-stream-key.ts';
import { AL_LIVE_CHANNEL_TTL_MS } from '@shared/al-contracts/resolve-al-channel-send-defaults.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from '../browser-message-sender-fixture.ts';

const START_MS = 1_760_000_000_000;
/** A cadence no test outlives, so every value staged after a lane's first opportunity waits for the next one. */
const LIVE_POLICY: ALPublicationPolicy = { cadenceMs: 60_000, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } };

interface LiveSendFixture extends ReturnType<typeof createBrowserMessageSenderFixture> {
    readonly engine: InboxOutboxEngine;
    /** Every envelope the RTC carrier admitted, in admission order. */
    readonly admitted: ALMessage[];
}

/**
 * The fixture's dispatch and registry, the envelope builders and the engine all read `Date.now`; one frozen clock
 * keeps every value inside its 1 s deadline however long the test runner stalls between the send and the pass.
 */
function createLiveSendFixture(): LiveSendFixture {
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
    const fixture = createBrowserMessageSenderFixture(undefined, undefined, middleware);
    const admitted: ALMessage[] = [];
    middleware.middleware.rtcRxStreamer.enqueueOutboxIfAbsent = async (message: ALMessage) => {
        admitted.push(message);
        return await Promise.resolve(toQueuedMessageAdmission(message));
    };
    return { ...fixture, engine, admitted };
}

function toLiveChannel(publication: ALPublicationPolicy): BrowserTypedChannelPolicy {
    return { purpose: 'live', access: 'members', durability: undefined, onStorageUnavailable: 'refuse', publication };
}

function toPoseSend(resourceId: string, seq: number, text = 'pose') {
    return { typeId: 'arena.pose.v1', roomId: 'room', resourceId, payload: { seq, text } };
}

/** Runs one engine pass and joins the runnable it started: `stop` awaits the work the engine owns. */
async function runEnginePass(engine: InboxOutboxEngine): Promise<void> {
    await engine.executeOnce();
    await engine.stop();
}

describe('a live channel send', () => {
    it('stages the send and admits nothing until its lane\'s opportunity runs', async () => {
        const fixture = createLiveSendFixture();

        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1', 1), toLiveChannel(LIVE_POLICY));

        expect(handle.lifecycle().state).toBe('staged');
        expect(fixture.admitted).toEqual([]);

        await runEnginePass(fixture.engine);

        expect(fixture.admitted.map((message) => message.id.msgId)).toEqual([handle.msgId]);
        expect(handle.lifecycle().state).toBe('queued');
    });

    it('admits the envelope latest-wins on its stream key, best-effort, unreceipted, volatile and short-lived', async () => {
        const fixture = createLiveSendFixture();

        await fixture.sender.sendRtc(toPoseSend('entity-1', 1), toLiveChannel(LIVE_POLICY));
        await runEnginePass(fixture.engine);

        const [message] = fixture.admitted;
        expect(message.qos?.supersedence).toEqual({
            algo: 'latest-wins',
            opts: { supersedenceKey: toALPublicationStreamKey(message) }
        });
        expect(message.delivery).toMatchObject({ reliability: 'best-effort', ack: 'none' });
        expect(message.qos?.durability).toEqual({ algo: 'volatile' });
        expect(message.constraints?.expiresAtMs).toBe(message.id.ts + AL_LIVE_CHANNEL_TTL_MS);
    });

    it('leaves a value displaced within the cadence superseded, and admits only the newest at the opportunity', async () => {
        const fixture = createLiveSendFixture();
        const channel = toLiveChannel(LIVE_POLICY);

        const first = await fixture.sender.sendRtc(toPoseSend('entity-1', 1), channel);
        const second = await fixture.sender.sendRtc(toPoseSend('entity-1', 2), channel);

        expect(first.lifecycle()).toMatchObject({
            state: 'superseded',
            evidence: { reason: 'A newer live value of the stream displaced it before its opportunity.' }
        });
        expect(second.lifecycle().state).toBe('staged');

        await runEnginePass(fixture.engine);

        expect(fixture.admitted.map((message) => message.id.msgId)).toEqual([second.msgId]);
    });

    it('settles a staged value failed, skipped as disposed, when its session ends, and never admits it', async () => {
        const fixture = createLiveSendFixture();

        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1', 1), toLiveChannel(LIVE_POLICY));
        fixture.sessionDeliveries.endSession(fixture.middleware.session);
        await runEnginePass(fixture.engine);

        expect(handle.lifecycle()).toMatchObject({
            state: 'failed',
            evidence: { failure: { kind: 'skipped', reason: 'disposed' } }
        });
        expect(fixture.admitted).toEqual([]);
    });

    it('settles a staged value skipped as disposed when its connect closes, and its stopped engine never admits it', async () => {
        const fixture = createLiveSendFixture();

        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1', 1), toLiveChannel(LIVE_POLICY));
        fixture.replaceTransport();
        await fixture.engine.stop();

        expect(handle.lifecycle()).toMatchObject({
            state: 'failed',
            evidence: { failure: { kind: 'skipped', reason: 'disposed' } }
        });
        expect(fixture.admitted).toEqual([]);
    });

    it('refuses a value heavier than its channel\'s drain budget oversized, without staging it', async () => {
        const fixture = createLiveSendFixture();
        const narrow = toLiveChannel({ ...LIVE_POLICY, drain: { messages: 8, bytes: 512 } });

        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1', 1, 'x'.repeat(1_024)), narrow);
        await runEnginePass(fixture.engine);

        expect(handle.lifecycle()).toMatchObject({
            state: 'rejected',
            evidence: { failure: { kind: 'refused', reason: 'oversized' } }
        });
        expect(fixture.admitted).toEqual([]);
    });
});
