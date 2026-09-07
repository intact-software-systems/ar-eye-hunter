// @vitest-environment happy-dom
import { readBlackBoxRtcMessageNacks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { configureBrowserALRuntimeStores, resolveBrowserRtcOverlayALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import '../../setup-browser-indexeddb.ts';

describe('RTC message diagnostic receipts', () => {
    it('reads the admitted receiver receipt without creating sent messages or changing the evidence', async () => {
        const sessionId = `nack-diagnostics-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId);
        try {
            const { admissionStore } = resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId);
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'attempted')).toEqual([]);
            await admitAttemptedMessage(admissionStore, sessionId);
            const sentBefore = await admissionStore.getAllSentMessages();
            await admissionStore.acceptControlMessage(
                newALNackControlMessage(
                    {
                        v: 2,
                        msgId: `${sessionId}:nack-attempted`,
                        ts: 1,
                        senderId: 'receiver'
                    },
                    {
                        msgId: 'attempted',
                        fromPeerId: 'receiver',
                        toPeerId: sessionId,
                        reason: 'not-yet-in-sync',
                        observedAtEpochMs: 1
                    }
                ),
                decodeALOutboundPreparedMessage
            );
            const receipt = await readBlackBoxRtcMessageNacks(sessionId, 'attempted');
            expect(receipt).toEqual([expect.objectContaining({
                msgId: 'attempted',
                fromPeerId: 'receiver',
                toPeerId: sessionId,
                reason: 'not-yet-in-sync'
            })]);
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'another')).toEqual([]);
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'attempted')).toEqual(receipt);
            expect(await admissionStore.getAllSentMessages()).toEqual(sentBefore);
        }
        finally {
            await deleteBrowserALRuntimeEntriesForSession(sessionId);
        }
    });
});

async function admitAttemptedMessage(store: ALOutboundAdmissionStore, sessionId: string): Promise<void> {
    await store.commitBundle({
        senderId: sessionId,
        mutations: [
            { kind: 'set-msg-owner', msgId: 'attempted', senderId: sessionId },
            {
                kind: 'set-sent-message',
                snapshot: {
                    msgId: 'attempted',
                    msg: {
                        id: { v: 2, msgId: 'attempted', senderId: sessionId, ts: Date.now() },
                        route: { topicId: 'diagnostic-test', resourceId: 'attempted', contextId: 'room' },
                        targets: { mode: 'unicast', toPeerId: 'receiver' },
                        payload: { typeId: 'diagnostic-test', resource: '{}' }
                    }
                }
            },
            {
                kind: 'set-pending-ack',
                snapshot: {
                    msgId: 'attempted',
                    expectedPeerIds: ['receiver'],
                    ackedPeerIds: [],
                    timeoutMs: 2000,
                    maxAttempts: 3,
                    attempts: 0,
                    deadlineAtMs: Date.now() + 2000
                }
            }
        ],
        durableEffects: []
    }, decodeALOutboundPreparedMessage);
}
