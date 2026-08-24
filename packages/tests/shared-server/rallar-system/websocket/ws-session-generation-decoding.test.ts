import {
    decodeWsSessionCloseHighWaterState,
    type WsSessionHighWaterIdentity
} from '@shared-server/rallar-system/websocket/ws-session-generation-computation.ts';
import { describe, expect, it } from 'vitest';

const IDENTITY: WsSessionHighWaterIdentity = {
    scope: {
        kind: 'client',
        applicationId: 'app-1',
        workspaceId: 'workspace-1',
        principalId: 'principal-1',
        clientInstanceId: 'instance-1'
    },
    sessionId: 'session-1'
};

describe('WebSocket session generation decoding', () => {
    it('accepts the exact current version-3 close state', () => {
        const current = {
            version: 3,
            status: 'closed',
            ...IDENTITY,
            generationId: 'generation-1',
            generationStartedAtEpochMs: 1_000,
            disconnectedAtEpochMs: 1_100,
            reason: 'socket-closed',
            expireAtEpochMs: 10_000
        } as const;

        expect(decodeWsSessionCloseHighWaterState(current, IDENTITY)).toEqual(current);
    });

    it('rejects extra fields at the persisted contract boundary', () => {
        expect(() =>
            decodeWsSessionCloseHighWaterState(
                {
                    version: 3,
                    status: 'open',
                    ...IDENTITY,
                    generationId: 'generation-1',
                    generationStartedAtEpochMs: 1_000,
                    expireAtEpochMs: 10_000,
                    fallbackGenerationId: 'predecessor-generation'
                },
                IDENTITY
            )
        ).toThrow('WebSocket session close high-water state fields are invalid');
    });
});
