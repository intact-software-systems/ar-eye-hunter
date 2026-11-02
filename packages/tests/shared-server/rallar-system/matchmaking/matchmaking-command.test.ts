import { describe, expect, it } from 'vitest';

import { decodeMatchmakingCommand, decodeMatchmakingResult } from '@shared-server/rallar-system/matchmaking/matchmaking-command.ts';
import { decodeMatchmakingRequest } from '@shared/api/matchmaking/matchmaking-request.ts';

const scope = { applicationId: 'game', workspaceId: 'default' };
const command = {
    scope,
    principalId: 'alice',
    sessionId: 'session-a',
    sessionIssuedAtEpochMs: 1000,
    sessionExpiresAtEpochMs: 600000,
    requestId: 'request-a',
    request: { action: 'start', searchId: 'search-a' },
    capturedAtEpochMs: null,
    policy: null,
    serviceId: null
};

describe('matchmaking ingress and replay binding', () => {
    it('accepts search intent while refusing caller-supplied authority or policy', () => {
        expect(decodeMatchmakingRequest(command.request)).toEqual(command.request);
        expect(() => decodeMatchmakingRequest({ ...command.request, principalId: 'bob' })).toThrow();
        expect(() => decodeMatchmakingRequest({ ...command.request, players: 1 })).toThrow();
        expect(() => decodeMatchmakingRequest({ action: 'expire', searchId: 'search-a' })).toThrow();
    });

    it('rejects identities that cannot become scoped room routes', () => {
        for (const searchId of ['../escape', 'contains space', '.', 'x'.repeat(97)]) {
            expect(() => decodeMatchmakingRequest({ action: 'start', searchId })).toThrow();
        }
        expect(() => decodeMatchmakingCommand({ ...command, scope: { ...scope, applicationId: '../other' } })).toThrow();
    });

    it('requires a complete winning capture and a coherent authenticated session lifetime', () => {
        expect(decodeMatchmakingCommand(command)).toEqual(command);
        expect(() => decodeMatchmakingCommand({ ...command, capturedAtEpochMs: 2000 })).toThrow();
        expect(() => decodeMatchmakingCommand({ ...command, sessionExpiresAtEpochMs: 999 })).toThrow();
        expect(() => decodeMatchmakingCommand({ ...command, scope: { ...scope, groupId: 'room' } })).toThrow();
    });

    it('rejects a replay result for another account, scope or request', () => {
        const captured = decodeMatchmakingCommand({
            ...command,
            capturedAtEpochMs: 2000,
            serviceId: 'test-api',
            policy: { players: 2, searchTimeoutMs: 120000, confirmationTimeoutMs: 30000, maxSearching: 256 }
        });
        const result = { scope, principalId: 'alice', requestId: 'request-a', status: 'applied', searchId: 'search-a', code: null };
        expect(decodeMatchmakingResult(result, captured)).toEqual(result);
        for (
            const changed of [
                { ...result, principalId: 'bob' },
                { ...result, requestId: 'request-b' },
                { ...result, scope: { ...scope, workspaceId: 'other' } }
            ]
        ) {
            expect(() => decodeMatchmakingResult(changed, captured)).toThrow();
        }
    });
});
