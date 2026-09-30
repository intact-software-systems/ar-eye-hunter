import { describe, expect, it } from 'vitest';

import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
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

    it('refuses a principal target in another application', () => {
        const message: ALMessage = {
            ...createIncomingMessage(),
            targets: {
                mode: 'broadcast',
                scope: 'principal',
                principalRef: {
                    applicationId: 'other',
                    workspaceId: 'workspace',
                    principalId: 'alice'
                }
            }
        };
        expect(
            toWsQueueBoxServerScopeAuthorization({
                message,
                proof: PROOF,
                nowMs: 1_000,
                sendNack: true
            })
        )
            .toMatchObject({ authorized: false, reason: 'unauthorized', sendNack: true });
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
