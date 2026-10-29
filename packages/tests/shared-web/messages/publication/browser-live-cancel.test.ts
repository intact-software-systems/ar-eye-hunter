import type { BrowserTypedChannelPolicy } from '@shared-web/browser/messages/to-browser-message-send-defaults.ts';
import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ALPublicationPolicy } from '@shared/al-contracts/publication/al-publication-policy.ts';
import type { ALOutboundEnqueueResult } from '@shared/alm/outbound/al-outbound-message-runtime.ts';
import { InboxOutboxEngine } from '@shared/services/inbox-outbox-engine.ts';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { createDefaultApiMiddlewareTestDouble } from '../../api-middleware-test-double.ts';
import { createBrowserMessageSenderFixture, toQueuedMessageAdmission } from '../browser-message-sender-fixture.ts';

const START_MS = 1_760_000_000_000;
const LIVE_CHANNEL: BrowserTypedChannelPolicy = {
    purpose: 'live',
    durability: undefined,
    onStorageUnavailable: 'refuse',
    publication: { cadenceMs: 60_000, retainNewest: 1, drain: { messages: 8, bytes: 65_536 } } satisfies ALPublicationPolicy
};

interface LiveCancelFixture extends ReturnType<typeof createBrowserMessageSenderFixture> {
    readonly engine: InboxOutboxEngine;
    /** Every envelope the RTC carrier was asked to admit, in call order. */
    readonly admitted: ALMessage[];
    /** Each carrier cancel the registry's cancel reached, in call order. */
    readonly carrierCancels: (readonly ['rtc' | 'ws', string])[];
}

/** The registry, the dispatch and the engine all read `Date.now`, so one frozen clock holds every deadline ahead. */
function createLiveCancelFixture(admit: (message: ALMessage) => Promise<ALOutboundEnqueueResult>): LiveCancelFixture {
    vi.useFakeTimers({ toFake: ['Date'], now: START_MS });
    onTestFinished(() => {
        vi.useRealTimers();
    });
    const engine = new InboxOutboxEngine({ nowEpochMs: () => Date.now(), random: () => 0.5, reportTaskFailure: () => undefined });
    const admitted: ALMessage[] = [];
    const carrierCancels: LiveCancelFixture['carrierCancels'] = [];
    const middleware = createDefaultApiMiddlewareTestDouble({
        middleware: {
            qboxEngine: engine,
            rtcRxStreamer: {
                enqueueOutboxIfAbsent: async (message: ALMessage) => {
                    admitted.push(message);
                    return await admit(message);
                },
                cancelOutbox: (msgId: string) => {
                    carrierCancels.push(['rtc', msgId]);
                    return 'cancelled' as const;
                }
            },
            webSocketQueueBox: {
                cancelOutbox: (msgId: string) => {
                    carrierCancels.push(['ws', msgId]);
                    return 'cancelled' as const;
                }
            }
        }
    });
    return { ...createBrowserMessageSenderFixture(undefined, undefined, middleware), engine, admitted, carrierCancels };
}

function toPoseSend(resourceId: string) {
    return { typeId: 'arena.pose.v1', roomId: 'room', resourceId, payload: { seq: 1, text: 'pose' } };
}

/** Runs one engine pass and joins the runnable it started: `stop` awaits the work the engine owns. */
async function runEnginePass(engine: InboxOutboxEngine): Promise<void> {
    await engine.executeOnce();
    await engine.stop();
}

describe('cancelling a live channel send', () => {
    it('settles a staged value cancelled at its stage, reaches no carrier, and never admits it', async () => {
        const fixture = createLiveCancelFixture(async (message) => await Promise.resolve(toQueuedMessageAdmission(message)));
        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1'), LIVE_CHANNEL);

        handle.cancel();
        await runEnginePass(fixture.engine);

        expect(handle.lifecycle().state).toBe('cancelled');
        expect(fixture.carrierCancels).toEqual([]);
        expect(fixture.admitted).toEqual([]);
    });

    it('asks both carriers to cancel a send no stage holds', async () => {
        const fixture = createLiveCancelFixture(async (message) => await Promise.resolve(toQueuedMessageAdmission(message)));
        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1'), undefined);

        handle.cancel();

        expect(handle.lifecycle().state).toBe('cancelled');
        expect(fixture.carrierCancels).toEqual([['rtc', handle.msgId], ['ws', handle.msgId]]);
    });

    it('cancels a value its opportunity selected at the carriers only, while its admission is still pending', async () => {
        let releaseAdmission: () => void = () => undefined;
        const admissionHeld = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
        });
        const fixture = createLiveCancelFixture(async (message) => {
            await admissionHeld;
            return toQueuedMessageAdmission(message);
        });
        const handle = await fixture.sender.sendRtc(toPoseSend('entity-1'), LIVE_CHANNEL);
        const pass = fixture.engine.executeOnce();
        await vi.waitFor(() => expect(fixture.admitted.map((message) => message.id.msgId)).toEqual([handle.msgId]));

        handle.cancel();
        releaseAdmission();
        await pass;
        await fixture.engine.stop();

        expect(fixture.carrierCancels).toEqual([['rtc', handle.msgId], ['ws', handle.msgId]]);
        expect(handle.lifecycle().state).toBe('cancelled');
    });
});
