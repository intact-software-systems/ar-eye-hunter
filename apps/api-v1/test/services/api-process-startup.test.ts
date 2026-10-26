import assert from 'node:assert/strict';

import { startApiProcess } from '../../src/runtime/api-process-startup.ts';

Deno.test('API process binds HTTP before runtime readiness and waits to start application admission and workers', async () => {
    const events: string[] = [];
    let resolveRuntimeReadiness: () => void = () => undefined;
    const runtimeReadiness = new Promise<void>((resolve) => {
        resolveRuntimeReadiness = resolve;
    });
    const httpServer = { name: 'http-server' };

    const startupPromise = startApiProcess({
        runtimeReadiness,
        listen: () => {
            events.push('http-listener');
            return httpServer;
        },
        startApplication: () => events.push('application-startup'),
        stopAfterStartupFailure: () => {
            events.push('startup-cleanup');
            return Promise.resolve();
        }
    });

    assert.deepEqual(events, ['http-listener']);

    resolveRuntimeReadiness();
    const startup = await startupPromise;

    assert.strictEqual(startup.httpServer, httpServer);
    assert.deepEqual(events, ['http-listener', 'application-startup']);
});

Deno.test('API process closes bound HTTP without starting the application after readiness failure', async () => {
    const events: string[] = [];
    const startupError = new Error('topology replay failed');
    const startup = startApiProcess({
        runtimeReadiness: Promise.reject(startupError),
        listen: () => {
            events.push('http-listener');
            return { name: 'http-server' };
        },
        startApplication: () => events.push('application-startup'),
        stopAfterStartupFailure: (httpServer) => {
            events.push(httpServer === undefined ? 'cleanup:no-http' : 'cleanup:http');
            return Promise.resolve();
        }
    });

    await assert.rejects(startup, startupError);
    assert.deepEqual(events, ['http-listener', 'cleanup:http']);
});

Deno.test('API process closes bound HTTP and owned resources when application startup fails', async () => {
    const events: string[] = [];
    const httpServer = { name: 'http-server' };
    const startupError = new Error('application startup failed');

    await assert.rejects(
        () =>
            startApiProcess({
                runtimeReadiness: Promise.resolve(),
                listen: () => {
                    events.push('http-listener');
                    return httpServer;
                },
                startApplication: () => {
                    events.push('application-startup');
                    throw startupError;
                },
                stopAfterStartupFailure: (boundHttpServer) => {
                    assert.strictEqual(boundHttpServer, httpServer);
                    events.push('startup-cleanup');
                    return Promise.resolve();
                }
            }),
        startupError
    );

    assert.deepEqual(events, ['http-listener', 'application-startup', 'startup-cleanup']);
});
