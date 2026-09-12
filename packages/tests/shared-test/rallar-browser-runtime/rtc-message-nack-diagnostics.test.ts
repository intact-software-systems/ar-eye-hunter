import type { ALOutboundTransportMessage } from '@shared/alm/outbound/al-outbound-transport-message.ts';
import {
    createOutboundWorkPort
} from '../../shared/alm/outbound-runtime-test-fixture.ts';
import { computeOutboundTestAdmission } from '../../shared/alm/outbound-runtime-test-fixture.ts';
// @vitest-environment happy-dom
import { readBlackBoxRtcMessageNacks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { configureBrowserALRuntimeStores, resolveBrowserRtcOverlayALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
import type { ALOutboundAdmissionStore } from '@shared/alm/outbound/admission/al-outbound-admission-store.ts';
import { decodeALOutboundPreparedMessage } from '@shared/alm/outbound/al-outbound-effect-validation.ts';
import {
    describe,
    expect,
    it
} from 'vitest';
import '../../setup-browser-indexeddb.ts';

const diagnosticsPorts = toRallarDiagnosticsPorts(undefined);

describe('RTC message diagnostic receipts', () => {
    it('reads the admitted receiver receipt without creating sent messages or changing the evidence', async () => {
        const sessionId = `nack-diagnostics-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts });
        try {
            const stores = resolveBrowserRtcOverlayALOutboundRuntimeStores(sessionId);
            const { admissionStore } = stores;
            const controlAdmission = admissionStore.createControlAdmission(
                createOutboundWorkPort(stores.workQueue, admissionStore.namespace),
                { nowMs: Date.now },
                () => {}
            );
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'attempted')).toEqual([]);
            await admitAttemptedMessage(admissionStore, sessionId);
            const sentBefore = await admissionStore.readSentMessage('attempted');
            await controlAdmission.admit(
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
                )
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
            expect(await admissionStore.readSentMessage('attempted')).toEqual(sentBefore);
        }
        finally {
            await deleteBrowserALRuntimeEntriesForSession(sessionId, {
                onStorageReset: diagnosticsPorts.onStorageReset
            });
        }
    });
});

async function admitAttemptedMessage(
    store: ALOutboundAdmissionStore<ALOutboundTransportMessage>,
    sessionId: string
): Promise<void> {
    const nowMs = Date.now();
    const message = {
        id: { v: 2 as const, msgId: 'attempted', senderId: sessionId, ts: nowMs },
        route: { topicId: 'diagnostic-test', resourceId: 'attempted', contextId: 'room' },
        targets: { mode: 'unicast' as const, toPeerId: 'receiver' },
        payload: { typeId: 'diagnostic-test', resource: '{}' },
        constraints: { expiresAtMs: nowMs + 30_000 }
    };
    const bundle = await computeOutboundTestAdmission(store, message);
    await store.commitBundle({
        ...bundle,
        mutations: [
            ...bundle.mutations,
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
    });
}
