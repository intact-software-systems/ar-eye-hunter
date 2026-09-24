import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    createInboundTestMessage,
    readInboundTestAdmission,
    readInboundTestDecisionSurface
} from '../../shared/alm/inbound-runtime-test-fixture.ts';

describe('browser session inbound admission store', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('shares one in-memory admission state across every resolve of one session', async () => {
        vi.stubGlobal('indexedDB', undefined);
        const sessionId = `session-inbound-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
        const first = resolveBrowserSessionALInboundRuntimeStores(sessionId);
        const second = resolveBrowserSessionALInboundRuntimeStores(sessionId);
        const msg = createInboundTestMessage({ msgId: 'admitted-through-the-first-resolve' });

        await expect(first.admissionStore.commitBundle(await readInboundTestAdmission(first.admissionStore, msg)))
            .resolves.toBe('committed');

        // The WS and RTC inbound services each hold a resolve: a duplicate one carrier admitted must
        // read as a duplicate through the other.
        const read = await readInboundTestDecisionSurface(second.admissionStore, msg);
        expect(read.dedupExpiresAt).toBeTypeOf('number');
    });
});
