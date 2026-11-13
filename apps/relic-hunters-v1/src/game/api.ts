import {
    decodeRelicSnapshotPayload,
    type RelicCommand,
    type RelicPublicSnapshot
} from '@relic-hunters/mod.ts';
import { readApiBaseUrl } from '@shared-web/browser/api-client-config.ts';
import { newApiRequestHeaders, readApiErrorBody } from '@shared-web/browser/api/send-api-http-request.ts';
import { readSession } from '@shared/api/auth.ts';

export async function fetchRelicSnapshot(
    gameId: string,
    signal?: AbortSignal
): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }

    const response = await fetch(`${readApiBaseUrl()}/api/relic/games/${encodeURIComponent(gameId)}`, {
        headers: newApiRequestHeaders({ authSession: session }),
        signal
    });
    if (response.status === 404 || response.status === 204) {
        return undefined;
    }
    if (!response.ok) {
        throw new Error(`Failed to load expedition: ${response.status}`);
    }

    return await decodeRelicResponse(response, 'Failed to load expedition');
}

export async function initializeRelicGame(gameId: string): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }
    const response = await fetch(
        `${readApiBaseUrl()}/api/relic/games/${encodeURIComponent(gameId)}/initialize/requests/${crypto.randomUUID()}`,
        { method: 'POST', headers: newApiRequestHeaders({ authSession: session }) }
    );
    if (!response.ok) {
        throw new Error(`Failed to initialize expedition: ${response.status}`);
    }
    return await decodeRelicResponse(response, 'Failed to initialize expedition');
}

export async function resetRelicGame(gameId: string): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session) {
        return undefined;
    }

    const response = await fetch(
        `${readApiBaseUrl()}/api/relic/games/${encodeURIComponent(gameId)}/reset/requests/${crypto.randomUUID()}`,
        { method: 'POST', headers: newApiRequestHeaders({ authSession: session }) }
    );
    if (!response.ok) {
        throw new Error(`Failed to reset expedition: ${response.status}`);
    }

    return await decodeRelicResponse(response, 'Failed to reset expedition');
}

export interface RelicCommandRequest {
    readonly gameId: string;
    readonly command: RelicCommand;
    readonly requestId: string;
    readonly sessionId: string;
}

export async function sendRelicCommand(
    { gameId, command, requestId, sessionId }: RelicCommandRequest
): Promise<RelicPublicSnapshot | undefined> {
    const session = readSession();
    if (!session || session.sessionId !== sessionId) {
        return undefined;
    }

    const response = await fetch(
        `${readApiBaseUrl()}/api/relic/games/${encodeURIComponent(gameId)}/commands/requests/${
            encodeURIComponent(requestId)
        }`,
        {
            method: 'POST',
            headers: newApiRequestHeaders({ authSession: session }),
            body: JSON.stringify(command)
        }
    );
    if (!response.ok) {
        const body = await readApiErrorBody(response);
        const message = `Failed to send expedition command: ${response.status} ${body}`;
        let refused = false;
        try {
            refused = decodeRelicCommandRefusal(JSON.parse(body));
        }
        catch {
            // An unreadable error body cannot establish a durable result.
        }
        throw refused ? new RelicCommandRefusedError(message) : new Error(message);
    }

    return await decodeRelicResponse(response, 'Failed to send expedition command');
}

/** A durable AppInbox refusal; transport/auth failures do not establish a command outcome. */
export class RelicCommandRefusedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'RelicCommandRefusedError';
    }
}

async function decodeRelicResponse(response: Response, failure: string): Promise<RelicPublicSnapshot> {
    const decoded = decodeRelicSnapshotPayload(await response.json());
    if (decoded.right === undefined) {
        throw new Error(`${failure}: ${decoded.left?.message ?? 'Invalid expedition snapshot'}`);
    }
    return decoded.right;
}

function decodeRelicCommandRefusal(value: unknown): boolean {
    return typeof value === 'object' && value !== null && 'status' in value && value.status === 'refused' &&
        'code' in value && typeof value.code === 'string' && 'error' in value && typeof value.error === 'string';
}
