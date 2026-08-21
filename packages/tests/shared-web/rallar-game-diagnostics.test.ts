import { deriveRallarGameDiagnostics } from '@shared-web/game/mod.ts';
import type { RallarGameMatchStatus } from '@shared-web/game/mod.ts';
import { describe, expect, it } from 'vitest';

describe('Rallar Game diagnostics', () => {
    it('aggregates match, election, readiness, capability, and RTC status', () => {
        const status: RallarGameMatchStatus = {
            phase: 'active',
            protocol: 'test.game.v1',
            topicId: 'test.game',
            roomId: 'room-1',
            localPeerId: 'peer-a',
            directorPeerId: 'peer-b',
            directorEpoch: 2,
            directorIsFresh: true,
            directorAuthority: 'none',
            egress: { reliable: 'ready', realtime: 'partial' },
            recovery: { status: 'idle' },
            started: true,
            stopped: false,
            updatedAtEpochMs: 1_000
        };

        expect(
            deriveRallarGameDiagnostics({
                status,
                nowEpochMs: 2_000,
                election: {
                    host: {
                        peerId: 'peer-b',
                        score: 10,
                        eligible: true,
                        reason: 'fresh-capability'
                    },
                    backup: {
                        peerId: 'peer-a',
                        score: 9,
                        eligible: true,
                        reason: 'fresh-capability'
                    },
                    candidates: [],
                    nowEpochMs: 2_000,
                    capabilityTtlMs: 10_000
                },
                peerReadiness: {
                    status: 'partial',
                    roomId: 'room-1',
                    laneIds: ['game-input'],
                    readyPeerIds: ['peer-b'],
                    notReadyPeerIds: ['peer-c'],
                    missingPeerIds: [],
                    extraPeerIds: [],
                    observedCount: 1,
                    lanes: []
                },
                rtcStatus: {
                    sessionId: 'peer-a',
                    laneId: 'game-input',
                    knownPeerIds: ['peer-b', 'peer-c'],
                    activePeerIds: ['peer-b'],
                    peerIdsWithNoReconnectableLanes: [],
                    readyPeerIds: ['peer-b'],
                    peers: []
                },
                capabilities: [
                    { peerId: 'peer-a', reportedAtEpochMs: 1_000 },
                    { peerId: 'peer-b', reportedAtEpochMs: 1_000 }
                ],
                realtimeHealth: [
                    {
                        peerId: 'peer-b',
                        laneId: 'game-input'
                    }
                ]
            })
        ).toMatchObject({
            generatedAtEpochMs: 2_000,
            phase: 'active',
            roomId: 'room-1',
            localPeerId: 'peer-a',
            directorPeerId: 'peer-b',
            directorEpoch: 2,
            directorIsFresh: true,
            hostPeerId: 'peer-b',
            backupPeerId: 'peer-a',
            knownPeerIds: ['peer-b', 'peer-c'],
            readyPeerIds: ['peer-b'],
            notReadyPeerIds: ['peer-c'],
            capabilityCount: 2,
            rtcPeerCount: 2,
            issues: ['partial-lane-readiness']
        });
    });

    it('reports missing room, local peer, and director recovery issues', () => {
        const diagnostics = deriveRallarGameDiagnostics({
            status: {
                phase: 'recovering',
                protocol: 'test.game.v1',
                topicId: 'test.game',
                directorIsFresh: false,
                directorAuthority: 'none',
                egress: { reliable: 'empty', realtime: 'empty' },
                recovery: {
                    status: 'recovering',
                    reason: 'No fresh director.',
                    sinceEpochMs: 1_000
                },
                started: true,
                stopped: false,
                updatedAtEpochMs: 1_000
            },
            nowEpochMs: 2_000,
            election: {
                candidates: [],
                nowEpochMs: 2_000,
                capabilityTtlMs: 10_000
            }
        });

        expect(diagnostics.issues).toEqual([
            'no-director',
            'no-electable-host',
            'no-local-peer',
            'no-room',
            'recovering'
        ]);
    });

    it('reports appointment and WS transport issues', () => {
        const diagnostics = deriveRallarGameDiagnostics({
            status: {
                phase: 'recovering',
                protocol: 'test.game.v1',
                topicId: 'test.game',
                roomId: 'room-1',
                localPeerId: 'peer-a',
                directorIsFresh: false,
                directorAuthority: 'none',
                egress: { reliable: 'empty', realtime: 'empty' },
                recovery: { status: 'idle' },
                started: true,
                stopped: false,
                updatedAtEpochMs: 1_000
            },
            appointment: {
                allowed: false,
                status: 'not-authorized',
                policy: 'metadata-owner-admin',
                localPeerId: 'peer-a',
                localPrincipalId: 'principal-a',
                localRole: 'member',
                localMemberStatus: 'active',
                reason: 'Only active room owners/admins can appoint the browser director.'
            },
            lastAppointment: {
                status: 'not-authorized',
                election: {
                    candidates: [],
                    nowEpochMs: 1_000,
                    capabilityTtlMs: 10_000
                },
                reason: 'Only active room owners/admins can appoint the browser director.'
            },
            wsStatus: {
                connectState: 'connecting',
                readyState: 'closed',
                isOpen: false,
                reconnecting: true,
                reconnectEnabled: true,
                reconnectAttempts: 1,
                maxReconnectAttempts: 5,
                reconnectExhausted: false
            }
        });

        expect(diagnostics.appointment).toMatchObject({
            status: 'not-authorized',
            localRole: 'member',
            lastResultStatus: 'not-authorized'
        });
        expect(diagnostics.wsStatus?.readyState).toBe('closed');
        expect(diagnostics.issues).toEqual([
            'director-not-authorized',
            'no-director',
            'ws-not-open'
        ]);
    });
});
