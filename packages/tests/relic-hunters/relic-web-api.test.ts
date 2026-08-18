// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELIC_PROTOCOL_VERSION, type RelicCommand } from '@relic-hunters/mod.ts';
import { clearSession, writeSession } from '@shared/api/auth.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import {
    fetchRelicSnapshot,
    resetRelicGame,
    sendRelicCommand,
} from '../../../apps/relic-hunters-v1/src/game/api.ts';

describe('Relic Hunters web API client', () => {
    beforeEach(() => {
        installMemoryLocalStorage();
        clearSession();
        vi.unstubAllGlobals();
        installMemoryLocalStorage();
    });

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
            new Response(JSON.stringify({ gameId: 'room/1' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            })
        );
        vi.stubGlobal('fetch', fetch);

        const command = joinCommand('room/1');
        await sendRelicCommand('room/1', command);

        expect(fetch).toHaveBeenCalledTimes(1);
        const [url, init = {}] = fetch.mock.calls[0];
        expect(url).toBe('/api/relic/games/room%2F1/commands');
        expect(init.method).toBe('POST');
        expect(init.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json',
            'x-client-id': 'client-1',
        });
        expect(JSON.parse(String(init.body))).toEqual(command);
    });

    it('surfaces response text when command submission fails', async () => {
        writeSession(session());
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('invalid command', { status: 400 })),
        );

        await expect(sendRelicCommand('room-1', joinCommand())).rejects.toThrow(
            'Failed to send expedition command: 400 invalid command',
        );
    });
});

function session(): AuthSession {
    return {
        clientId: 'client-1',
        accessToken: 'token-1',
        username: 'alice',
        sessionId: 'alice-session',
        expiresAtEpochMs: Date.now() + 60_000,
    };
}

function joinCommand(gameId = 'room-1'): RelicCommand {
    return {
        protocolVersion: RELIC_PROTOCOL_VERSION,
        kind: 'join-expedition',
        gameId,
        username: 'alice',
        characterId: 'kael-ironstride',
    };
}

function installMemoryLocalStorage(): void {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
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
        },
    } satisfies Storage);
}
