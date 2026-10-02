import '../../setup-browser-indexeddb.ts';
import { describe, expect, it } from 'vitest';

import {
    configureBrowserALRuntimeStores,
    resolveBrowserSessionALInboundRuntimeStores
} from '@shared-web/browser/al-runtime/browser-al-runtime-stores.ts';
import { defaultStateScope } from '@shared-web/browser/api/state-http-path.ts';
import { toRallarDiagnosticsPorts } from '@shared-web/browser/connection/rallar-diagnostics-ports.ts';
import {
    createInboundTestMessage,
    readInboundTestAdmission,
    readInboundTestDecisionSurface
} from '../../shared/alm/inbound-runtime-test-fixture.ts';

describe('browser session inbound admission store', () => {
    it('shares one admission state across every resolve of one session', async () => {
        const sessionId = `session-inbound-${crypto.randomUUID()}`;
        configureBrowserALRuntimeStores(sessionId, { scope: defaultStateScope(), diagnosticsPorts: toRallarDiagnosticsPorts(undefined) });
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
