import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientPrincipalRef } from '@shared/api/client-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import { toWsQueueBoxServerScopeAuthorization } from '@shared/services/ws-queue-box-server/scope/to-ws-queue-box-server-scope-authorization.ts';

import { createIncomingMessage, createRoomMessage } from './ws-queue-box-server-ingress-fixture.ts';

const PROOF = {
    scope: { applicationId: 'app', workspaceId: 'workspace' },
    expiresAtEpochMs: 2_000
};

describe('WS ingress scope authorization', () => {
    it('authorizes a room message inside its connection scope and keeps the proof', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: createRoomMessage(),
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        )
            .toEqual({ authorized: true, proof: PROOF });
    });

    it('authorizes a message that names no scope', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: createIncomingMessage(),
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        )
            .toEqual({ authorized: true, proof: PROOF });
    });

    it.each([true, false])(
        'refuses a room in another workspace under the NACK policy %s',
        (sendNack) => {
            const message: ALMessage = {
                ...createRoomMessage(),
                targets: {
                    mode: 'broadcast',
                    scope: 'room',
                    groupRef: { applicationId: 'app', workspaceId: 'other', groupId: 'room-1' }
                }
            };
            expect(
                toWsQueueBoxServerScopeAuthorization({
                    message,
                    proof: PROOF,
                    nowMs: 1_000,
                    sendNack
                })
            ).toEqual({
                authorized: false,
                reason: 'unauthorized',
                rejectionCode: 'unauthorized',
                logMessage: 'AL message message-1 addresses app/other, outside its connection\'s authenticated scope',
                sendNack
            });
        }
    );

    it.each(
        [
            ['principal', { applicationId: 'other', workspaceId: 'workspace' }, { applicationId: 'app', workspaceId: 'workspace' }, 'other/workspace'],
            ['room', { applicationId: 'app', workspaceId: 'workspace' }, { applicationId: 'app', workspaceId: 'other' }, 'app/other']
        ] as const
    )('refuses a principal broadcast whose %s is in another scope', (_outside, principalScope, roomScope, named) => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: createPrincipalMessage({ ...principalScope, principalId: 'alice' }, { ...roomScope, groupId: 'room-1' }),
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        ).toEqual({
            authorized: false,
            reason: 'unauthorized',
            rejectionCode: 'unauthorized',
            logMessage: `AL message message-1 addresses ${named}, outside its connection's authenticated scope`,
            sendNack: true
        });
    });

    it('authorizes a principal broadcast in a room of its connection scope', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: createPrincipalMessage(
                    { applicationId: 'app', workspaceId: 'workspace', principalId: 'alice' },
                    { applicationId: 'app', workspaceId: 'workspace', groupId: 'room-1' }
                ),
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        ).toEqual({ authorized: true, proof: PROOF });
    });

    it('refuses a principal broadcast that names no room as malformed', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: createPrincipalMessage({ applicationId: 'app', workspaceId: 'workspace', principalId: 'alice' }),
                proof: PROOF,
                nowMs: 1_000,
                sendNack: false
            })
        ).toEqual({
            authorized: false,
            reason: 'no-route',
            rejectionCode: 'malformed',
            logMessage: 'AL message message-1 addresses a principal without the room it is addressed in',
            sendNack: false
        });
    });

    it('refuses an all broadcast, which only the server may address', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: { ...createIncomingMessage(), targets: { mode: 'broadcast', scope: 'all' } },
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        ).toEqual({
            authorized: false,
            reason: 'unauthorized',
            rejectionCode: 'unauthorized',
            logMessage: 'AL message message-1 addresses every scope, which only the server may address',
            sendNack: true
        });
    });

    it('refuses a world broadcast on a room topic as malformed', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: { ...createRoomMessage(), targets: { mode: 'broadcast', scope: 'world' } },
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        ).toEqual({
            authorized: false,
            reason: 'no-route',
            rejectionCode: 'malformed',
            logMessage: 'AL message message-1 addresses the world on room topic room.notification',
            sendNack: true
        });
    });

    it('authorizes a world broadcast, which reaches its connection scope', () => {
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message: { ...createIncomingMessage(), targets: { mode: 'broadcast', scope: 'world' } },
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        ).toEqual({ authorized: true, proof: PROOF });
    });

    it.each([undefined, { ...PROOF, expiresAtEpochMs: 1_000 }])(
        'refuses a connection whose scope proof is %j',
        (proof) => {
            expect(
                toWsQueueBoxServerScopeAuthorization({
                    message: createIncomingMessage(),
                    proof,
                    nowMs: 1_000,
                    sendNack: true
                })
            ).toEqual({
                authorized: false,
                reason: 'unauthorized',
                rejectionCode: 'unauthorized',
                logMessage: 'AL message message-1 arrived without a current authenticated WS scope',
                sendNack: true
            });
        }
    );
});

function createPrincipalMessage(principalRef: ClientPrincipalRef, groupRef?: GroupRef): ALMessage {
    return {
        ...createIncomingMessage(),
        targets: { mode: 'broadcast', scope: 'principal', principalRef, ...(groupRef === undefined ? {} : { groupRef }) }
    };
}
