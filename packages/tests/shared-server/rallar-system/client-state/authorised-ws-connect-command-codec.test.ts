import { describe, expect, it } from 'vitest';

import { classifyAppInboxError } from '@shared-server/rallar-system/app-inbox/app-inbox-error-classification.ts';
import type {
    ClientAuthorisedWsSessionConnectAppInboxPayload,
    ClientAuthorisedWsTicketConnectAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/app-client-inbox-contracts.ts';
import {
    decodeClientAuthorisedWsSessionDisconnectAppInboxPayload,
    decodeClientAuthorisedWsTicketConnectAppInboxPayload
} from '@shared-server/rallar-system/client-state/inbox/client-state-inbox-command-codec.ts';
import { decodeGroupPresenceSessionCleanupAppInboxPayload } from '@shared-server/rallar-system/group-state/presence/group-presence-session-cleanup-app-inbox-payload.ts';

const CONNECTION: ClientAuthorisedWsSessionConnectAppInboxPayload = {
    authSession: {
        clientId: 'alice',
        username: 'alice',
        sessionId: 'session-1',
        issuedAtEpochMs: 1_700_000_000_000,
        expiresAtEpochMs: 1_700_000_060_000
    },
    generationId: 'generation-1',
    generationStartedAtEpochMs: 1_700_000_001_000,
    scope: { applicationId: 'app', workspaceId: 'default' },
    principalId: 'alice',
    clientInstanceId: 'alice-browser',
    displayName: 'Alice',
    userAgent: null,
    platform: 'web',
    capabilities: [],
    expiresAtEpochMs: 1_700_000_060_000
};

const HOLDER_ID = '00000000-0000-4000-8000-0000000000a1';

describe('the stored authorised WebSocket connect command', () => {
    it('names the process that enqueued it as the holder of its generation', () => {
        expect(decodeClientAuthorisedWsTicketConnectAppInboxPayload({
            connection: CONNECTION,
            ticketDigest: 'ticket-digest',
            holderId: HOLDER_ID
        })).toEqual({ connection: CONNECTION, ticketDigest: 'ticket-digest', holderId: HOLDER_ID });
    });

    it('refuses a previous build\'s holder-less connect, or an empty holder, as a malformed command', () => {
        const previousBuild = { connection: CONNECTION, ticketDigest: 'ticket-digest' };
        for (const stored of [previousBuild, { ...previousBuild, holderId: '' }]) {
            const decoding = (): ClientAuthorisedWsTicketConnectAppInboxPayload => decodeClientAuthorisedWsTicketConnectAppInboxPayload(stored);
            expect(decoding, JSON.stringify(Object.keys(stored))).toThrow(TypeError);
            expect(classifyAppInboxError(captureError(decoding))).toMatchObject({
                kind: 'terminal',
                code: 'app-inbox-malformed-command',
                result: { code: 'app-inbox-malformed-command', status: 400, message: 'App inbox command is malformed' }
            });
        }
    });

    it('leaves the disconnect and the group cleanup of a socket close without a holder', () => {
        const close = { connection: CONNECTION, disconnectedAtEpochMs: 1_700_000_002_000, reason: 'socket-closed' };

        expect(decodeClientAuthorisedWsSessionDisconnectAppInboxPayload(close)).toEqual(close);
        expect(decodeGroupPresenceSessionCleanupAppInboxPayload(close)).toEqual(close);
    });
});

function captureError(run: () => ClientAuthorisedWsTicketConnectAppInboxPayload): Error {
    try {
        run();
    }
    catch (error) {
        if (error instanceof Error) {
            return error;
        }
        throw new TypeError('The decoder threw a non-Error value');
    }
    throw new Error('Expected the decoder to throw');
}
