import { expect, test } from 'bun:test';

import { createDefaultBackgroundTimers } from '@shared/resilience/timers.ts';

import { stopApiHttpServer } from '../../src/runtime/stop-api-http-server.ts';

const GRACE_MS = 400;
const BOUND_MS = GRACE_MS + 2_000;
const silent = { warn: () => undefined };

interface TestServer {
    readonly server: Bun.Server<undefined>;
    readonly sockets: Set<Bun.ServerWebSocket<undefined>>;
}

function serve(handle: (request: Request) => Promise<Response>): TestServer {
    const sockets = new Set<Bun.ServerWebSocket<undefined>>();
    const server = Bun.serve<undefined>({
        hostname: '127.0.0.1',
        port: 0,
        fetch: (request, bunServer) => {
            if (new URL(request.url).pathname === '/ws') {
                return bunServer.upgrade(request, { data: undefined }) ? undefined : new Response('no', { status: 400 });
            }
            return handle(request);
        },
        websocket: { open: (ws) => void sockets.add(ws), message: () => undefined, close: (ws) => void sockets.delete(ws) }
    });
    return { server, sockets };
}

async function stopWithinBound(target: TestServer): Promise<{ outcome: string; elapsedMs: number; }> {
    const startedAt = performance.now();
    const outcome = await Promise.race([
        stopApiHttpServer(target.server, {
            graceMs: GRACE_MS,
            timers: createDefaultBackgroundTimers(),
            closeWebSockets: () => {
                for (const socket of target.sockets) {
                    socket.close(1001, 'server-shutting-down');
                }
            },
            log: silent
        }),
        Bun.sleep(BOUND_MS).then(() => 'still-stopping')
    ]);
    return { outcome, elapsedMs: performance.now() - startedAt };
}

test('an in-flight request that finishes within the grace completes and the drain is graceful', async () => {
    const target = serve(async () => {
        await Bun.sleep(150);
        return new Response('mutation committed');
    });
    const response = fetch(`http://127.0.0.1:${target.server.port}/mutation`).then((value) => value.text());
    await Bun.sleep(30);

    const stopped = await stopWithinBound(target);

    expect({ outcome: stopped.outcome, body: await response }).toEqual({ outcome: 'drained', body: 'mutation committed' });
});

test('a request that never finishes is force-closed at the grace instead of holding the stop', async () => {
    const target = serve(() => new Promise(() => undefined));
    const response = fetch(`http://127.0.0.1:${target.server.port}/hang`).then(() => 'answered', () => 'cut');
    await Bun.sleep(30);

    const stopped = await stopWithinBound(target);

    expect({ outcome: stopped.outcome, client: await response }).toEqual({ outcome: 'forced', client: 'cut' });
    expect(stopped.elapsedMs).toBeGreaterThanOrEqual(GRACE_MS - 50);
});

test('a WebSocket client that never answers the close frame cannot hold the stop past the grace', async () => {
    const target = serve(() => Promise.resolve(new Response('ok')));
    const upgraded = Promise.withResolvers<void>();
    // A raw TCP client completes the handshake and then ignores every frame, including the close.
    const client = await Bun.connect<undefined>({
        hostname: '127.0.0.1',
        port: target.server.port ?? 0,
        socket: { data: () => upgraded.resolve() }
    });
    client.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'
    );
    await upgraded.promise;

    const stopped = await stopWithinBound(target);
    client.end();

    expect(['drained', 'forced']).toContain(stopped.outcome);
});
