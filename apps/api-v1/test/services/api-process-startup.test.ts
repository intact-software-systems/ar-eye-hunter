import assert from 'node:assert/strict';

import { startApiProcess } from '../../src/runtime/api-process-startup.ts';

Deno.test('API process listens before runtime readiness and then starts queue workers', async () => {
    const events: string[] = [];
    let resolveRuntimeReadiness: () => void = () => undefined;
    const runtimeReadiness = new Promise<void>((resolve) => {
        resolveRuntimeReadiness = resolve;
    });
    const httpServer = { name: 'http-server' };

    const startup = startApiProcess({
        runtimeReadiness,
        listen: () => {
            events.push('http-listener');
            return httpServer;
        },
        startQueueWorkers: () => events.push('queue-workers')
    });

    assert.strictEqual(startup.httpServer, httpServer);
    assert.deepEqual(events, ['http-listener']);

    resolveRuntimeReadiness();
    await startup.readiness;

    assert.deepEqual(events, ['http-listener', 'queue-workers']);
});

Deno.test('API process preserves runtime readiness failure after binding HTTP', async () => {
    const events: string[] = [];
    const startupError = new Error('topology replay failed');
    const startup = startApiProcess({
        runtimeReadiness: Promise.reject(startupError),
        listen: () => {
            events.push('http-listener');
            return { name: 'http-server' };
        },
        startQueueWorkers: () => events.push('queue-workers')
    });

    assert.deepEqual(events, ['http-listener']);
    await assert.rejects(startup.readiness, startupError);
    assert.deepEqual(events, ['http-listener']);
});
