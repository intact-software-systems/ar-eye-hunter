import { readSession } from '@shared/api/auth.ts';
import type { RelicCommand, RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export async function fetchRelicSnapshot(gameId: string): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }

    const response = await fetch(`/api/relic/games/${encodeURIComponent(gameId)}`, {
        headers: {
            authorization: `Bearer ${session.accessToken}`,
            'x-client-id': session.clientId,
        },
    });
    if (response.status === 404) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`Failed to load expedition: ${response.status}`);
    }

    return await response.json() as RelicPublicSnapshot;
}

export async function resetRelicGame(gameId: string): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }

    const response = await fetch(`/api/relic/games/${encodeURIComponent(gameId)}/reset`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${session.accessToken}`,
            'x-client-id': session.clientId,
        },
    });
    if (!response.ok) {
        throw new Error(`Failed to reset expedition: ${response.status}`);
    }

    return await response.json() as RelicPublicSnapshot;
}

export async function sendRelicCommand(
    gameId: string,
    command: RelicCommand,
): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }

    const response = await fetch(`/api/relic/games/${encodeURIComponent(gameId)}/commands`, {
        method: 'POST',
        headers: {
            authorization: `Bearer ${session.accessToken}`,
            'content-type': 'application/json',
            'x-client-id': session.clientId,
        },
        body: JSON.stringify(command),
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`Failed to send expedition command: ${response.status} ${body}`);
    }

    return await response.json() as RelicPublicSnapshot;
}
