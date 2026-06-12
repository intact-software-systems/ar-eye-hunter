import assert from 'node:assert/strict';
import { toAuthorisedWsClientInput } from '../src/routes/ws-routes.ts';

Deno.test('websocket route forwards scoped state parameters to authorised connect', () => {
    const input = toAuthorisedWsClientInput(
        new URL(
            'https://api.example.test/api/ws/session-1?ticket=ticket-1&applicationId=ar-eye-hunter&workspaceId=default',
        ),
        'Browser',
    );

    assert.deepEqual(input, {
        applicationId: 'ar-eye-hunter',
        workspaceId: 'default',
        userAgent: 'Browser',
    });
});
