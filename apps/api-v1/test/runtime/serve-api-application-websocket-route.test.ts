import { expect, test } from 'bun:test';

import { IN_MEMORY_API_STARTUP_TIMEOUT_MS, startInMemoryApiProcess } from './in-memory-api-process.ts';

test('the served API answers a WebSocket path without Upgrade: websocket with 426 and echoes its trace', async () => {
    const api = await startInMemoryApiProcess();
    try {
        const response = await fetch(`${api.baseUrl}/api/ws/session-1`, {
            headers: { 'x-request-id': 'request-ws-no-upgrade' }
        });

        expect({
            status: response.status,
            body: await response.text(),
            traceId: response.headers.get('x-request-id'),
            timed: response.headers.get('server-timing')?.startsWith('total;dur=')
        }).toEqual({
            status: 426,
            body: 'Expected Upgrade: websocket',
            traceId: 'request-ws-no-upgrade',
            timed: true
        });
    }
    finally {
        api.child.kill('SIGKILL');
    }
}, IN_MEMORY_API_STARTUP_TIMEOUT_MS);
