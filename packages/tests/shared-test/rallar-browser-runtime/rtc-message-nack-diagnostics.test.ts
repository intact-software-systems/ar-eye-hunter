// @vitest-environment happy-dom
import { readBlackBoxRtcMessageNacks } from '@shared-test/black-box-runner/browser/rallar-browser-runtime/browser-rallar-runtime-composition.ts';
import { deleteBrowserALRuntimeEntriesForSession } from '@shared-web/browser/al-runtime/browser-al-runtime-cleanup.ts';
import { configureBrowserALRuntimeStores, resolveBrowserRtcOverlayALOutboundRuntimeStores } from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { newALNackControlMessage } from '@shared/al-contracts/al-control.ts';
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
            if (!admissionStore) {
                throw new Error('Fixture did not configure its admission store.');
            }
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'attempted')).toEqual([]);
            await admissionStore.acceptControlMessage(newALNackControlMessage('receiver', sessionId, 'attempted', 'not-yet-in-sync'));
            const receipt = await readBlackBoxRtcMessageNacks(sessionId, 'attempted');
            expect(receipt).toEqual([expect.objectContaining({
                msgId: 'attempted',
                fromPeerId: 'receiver',
                toPeerId: sessionId,
                reason: 'not-yet-in-sync'
            })]);
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'another')).toEqual([]);
            expect(await readBlackBoxRtcMessageNacks(sessionId, 'attempted')).toEqual(receipt);
            expect(await admissionStore.getAllSentMessages()).toEqual([]);
        }
        finally {
            await deleteBrowserALRuntimeEntriesForSession(sessionId);
        }
    });
});
