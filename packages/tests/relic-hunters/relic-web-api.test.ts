// @vitest-environment happy-dom

import {
    createRelicGame,
    RELIC_PROTOCOL_VERSION,
    toPublicRelicSnapshot,
    type RelicCommand
} from '@relic-hunters/mod.ts';
import { validateALTraceId } from '@shared/al-contracts/trace/al-trace-id.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';
import {
    fetchRelicSnapshot,
    resetRelicGame,
    sendRelicCommand
} from '../../../apps/relic-hunters-v1/src/game/api.ts';

describe('Relic Hunters web API client', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        installMemoryLocalStorage();
        clearSession();
    });

    afterEach(() => vi.unstubAllGlobals());

    it('does not call relic endpoints without a browser auth session', async () => {
        const fetch = vi.fn();
        vi.stubGlobal('fetch', fetch);

        await expect(fetchRelicSnapshot('room-1')).resolves.toBeUndefined();
        await expect(sendRelicCommand('room-1', joinCommand())).resolves.toBeUndefined();
        await expect(resetRelicGame('room-1')).resolves.toBeUndefined();
        expect(fetch).not.toHaveBeenCalled();
    });

    it('sends command requests with encoded game id and browser auth headers', async () => {
        writeSession(session());
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response(JSON.stringify(toPublicRelicSnapshot(createRelicGame('room/1', 'room/1', 1))), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );
        vi.stubGlobal('fetch', fetch);

        const command = joinCommand('room/1');
        await sendRelicCommand('room/1', command);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init = {}] = fetch.mock.calls[0];
        expect(url).toMatch(/^\/api\/relic\/games\/room%2F1\/commands\/requests\/[0-9a-f-]{36}$/);
        expect(init.method).toBe('POST');
        const headers = new Headers(init.headers);
        expect(headers.get('authorization')).toBe('Bearer token-1');
        expect(headers.get('content-type')).toBe('application/json');
        expect(headers.get('x-client-id')).toBe('client-1');
        expect(JSON.parse(String(init.body))).toEqual(command);
    });

    it('sends each Relic request with the api headers and its own grammar-valid x-request-id', async () => {
        writeSession(session());
        const fetch = vi.fn<typeof globalThis.fetch>(async () =>
            new Response(JSON.stringify(toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1))), { status: 200 })
        );
        vi.stubGlobal('fetch', fetch);

        await fetchRelicSnapshot('room-1');
        await resetRelicGame('room-1');
        await sendRelicCommand('room-1', joinCommand());

        const headers = fetch.mock.calls.map(([, init]) => new Headers(init?.headers));
        const traces = headers.map((sent) => sent.get('x-request-id') ?? '');
        expect(headers.map((sent) => sent.get('authorization'))).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-1']);
        expect(headers.map((sent) => sent.get('x-client-id'))).toEqual(['client-1', 'client-1', 'client-1']);
        expect(traces.map((traceId) => validateALTraceId(traceId))).toEqual([[], [], []]);
        expect(new Set(traces).size).toBe(3);
    });

    it('gives each reset a request identity and rejects malformed success payloads', async () => {
        writeSession(session());
        const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ gameId: 'room-1' })));
        vi.stubGlobal('fetch', fetch);
        await expect(resetRelicGame('room-1')).rejects.toThrow('not a Relic snapshot');
        expect(fetch.mock.calls[0][0]).toMatch(/^\/api\/relic\/games\/room-1\/reset\/requests\/[0-9a-f-]{36}$/);
        await expect(sendRelicCommand('room-1', joinCommand())).rejects.toThrow('not a Relic snapshot');
    });

    it('reads a Relic snapshot body and rejects one that names no game incarnation', async () => {
        writeSession(session());
        const snapshot = toPublicRelicSnapshot(createRelicGame('room-1', 'room-1', 1));
        const { createdAtEpochMs: _createdAtEpochMs, ...withoutCreatedAt } = snapshot;
        const bodies = [snapshot, withoutCreatedAt];
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify(bodies.shift()), { status: 200 }))
        );

        await expect(fetchRelicSnapshot('room-1')).resolves.toEqual(snapshot);
        await expect(fetchRelicSnapshot('room-1')).rejects.toThrow('Failed to load expedition: not a Relic snapshot');
    });

    it('surfaces response text when command submission fails', async () => {
        writeSession(session());
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('invalid command', { status: 400 }))
        );

        await expect(sendRelicCommand('room-1', joinCommand())).rejects.toThrow(
            'Failed to send expedition command: 400 invalid command'
        );
    });

    it('surfaces an unreadable command failure body as empty, as the shared API error reader does', async () => {
        writeSession(session());
        const unreadable = new Response('invalid command', { status: 400 });
        vi.spyOn(unreadable, 'text').mockRejectedValue(new TypeError('body stream already read'));
        vi.stubGlobal('fetch', vi.fn(async () => unreadable));

        await expect(sendRelicCommand('room-1', joinCommand())).rejects.toThrow(
            /^Failed to send expedition command: 400 $/
        );
    });
});

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000
    };
}

function joinCommand(gameId = 'room-1'): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'alice',
        characterId: 'kael-ironstride'
    };
}

function installMemoryLocalStorage(): void {
    const values = new Map<string, string>();
    vi.stubGlobal(
        'localStorage',
        {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => {
                values.set(key, value);
            },
            removeItem: (key: string) => {
                values.delete(key);
            },
            clear: () => {
                values.clear();
            },
            key: (index: number) => Array.from(values.keys())[index] ?? null,
            get length() {
                return values.size;
            }
        } satisfies Storage
    );
}
