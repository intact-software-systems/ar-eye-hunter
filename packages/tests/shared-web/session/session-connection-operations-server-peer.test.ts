import { describe, expect, it, vi } from 'vitest';

import { BrowserFacadeRuntimeState } from '@shared-web/browser/composition/browser-facade-runtime-state.ts';
import { BrowserTransportRuntime } from '@shared-web/browser/connection/browser-transport-runtime.ts';
import type { RallarSessionAuthLifecycle } from '@shared-web/browser/session/session-auth-lifecycle.ts';
import { createRallarSessionConnectionOperations } from '@shared-web/browser/session/session-connection-operations.ts';

import { createDefaultApiMiddlewareTestDouble } from '../api-middleware-test-double.ts';

describe('the WS server peer id on the connection operations (D57 as applied)', () => {
    it('reads the id the connected WS client learned, and nothing before a connection', () => {
        const transportRuntime = new BrowserTransportRuntime();
        const operations = createRallarSessionConnectionOperations({
            connectionRuntime: new BrowserFacadeRuntimeState(transportRuntime),
            transportRuntime,
            authLifecycle: {} as RallarSessionAuthLifecycle
        });

        expect(operations.serverPeerId()).toBeUndefined();
        vi.spyOn(transportRuntime, 'readMiddleware').mockReturnValue(
            createDefaultApiMiddlewareTestDouble({
                middleware: { webSocketQueueBox: { serverPeerId: 'server-7' } }
            })
        );
        expect(operations.serverPeerId()).toBe('server-7');
    });
});
