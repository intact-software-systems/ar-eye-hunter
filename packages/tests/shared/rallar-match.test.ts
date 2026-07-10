import { describe, expect, it } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createRallarMatchResult,
    deriveRallarMatchDiagnostics,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings,
} from '@shared/rallar-match/mod.ts';

describe('Rallar match shared helpers', () => {
    it('derives principal-first participants from active group members and sessions', () => {
        const snapshot = {
            members: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-b',
                    role: 'member',
                    status: 'active',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    role: 'owner',
                    status: 'active',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-removed',
                    role: 'member',
                    status: 'removed',
                },
            ],
            activeSessions: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    sessionId: 'session-a2',
                },
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    sessionId: 'session-a1',
                },
            ],
        } as GroupSnapshot;

        expect(deriveRallarMatchParticipants({ snapshot })).toEqual([
            {
                participantId: 'principal-a',
                principalId: 'principal-a',
                role: 'owner',
                status: 'active',
                online: true,
                sessionIds: ['session-a1', 'session-a2'],
            },
            {
                participantId: 'principal-b',
                principalId: 'principal-b',
                role: 'member',
                status: 'active',
                online: false,
                sessionIds: [],
            },
        ]);
    });

    it('supports custom participant identities', () => {
        const snapshot = {
            members: [
                {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1',
                    principalId: 'principal-a',
                    role: 'member',
                    status: 'active',
                },
            ],
            activeSessions: [],
        } as GroupSnapshot;

        expect(
            deriveRallarMatchParticipants({
                snapshot,
                resolveParticipantId: ({ principalId }) => `seat:${principalId}`,
            })[0]?.participantId,
        ).toBe('seat:principal-a');
    });

    it('derives stable standings with rank ties', () => {
        expect(
            deriveRallarMatchStandings({
                rows: [
                    {
                        participantId: 'b',
                        principalId: 'principal-b',
                        sessionIds: ['session-b'],
                        metrics: { points: 10, objectives: 1 },
                    },
                    {
                        participantId: 'a',
                        principalId: 'principal-a',
                        sessionIds: ['session-a'],
                        metrics: { points: 10, objectives: 1 },
                    },
                    {
                        participantId: 'c',
                        principalId: 'principal-c',
                        sessionIds: ['session-c'],
                        metrics: { points: 4, objectives: 3 },
                    },
                ],
                compare: (left, right) =>
                    right.metrics.points - left.metrics.points ||
                    right.metrics.objectives - left.metrics.objectives,
            }),
        ).toEqual([
            {
                participantId: 'a',
                principalId: 'principal-a',
                sessionIds: ['session-a'],
                rank: 1,
                tieGroup: 1,
                metrics: { points: 10, objectives: 1 },
            },
            {
                participantId: 'b',
                principalId: 'principal-b',
                sessionIds: ['session-b'],
                rank: 1,
                tieGroup: 1,
                metrics: { points: 10, objectives: 1 },
            },
            {
                participantId: 'c',
                principalId: 'principal-c',
                sessionIds: ['session-c'],
                rank: 3,
                tieGroup: 2,
                metrics: { points: 4, objectives: 3 },
            },
        ]);
    });

    it('creates deterministic match result envelopes', () => {
        const result = createRallarMatchResult({
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.match.v1',
            authority: {
                kind: 'browser-director',
                id: 'session-a',
                epoch: 4,
                principalId: 'principal-a',
                sessionId: 'session-a',
            },
            trust: 'room-trusted',
            startedAtEpochMs: 1_000,
            finishedAtEpochMs: 2_000,
            standings: [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    rank: 1,
                    tieGroup: 1,
                    metrics: { points: 10 },
                },
            ],
            summary: { reason: 'finished' },
        });

        expect(result.idempotencyKey).toBe(
            'match-1:browser-director:session-a:4:2000',
        );
        expect(result.trust).toBe('room-trusted');
        expect(result.summary).toEqual({ reason: 'finished' });
    });

    it('reports generic match diagnostics', () => {
        expect(
            deriveRallarMatchDiagnostics({
                participants: [],
                standings: [],
                result: undefined,
                authorityFresh: false,
                pendingCommandCount: 2,
                snapshotAgeMs: 12_000,
                maxSnapshotAgeMs: 5_000,
            }).issues,
        ).toEqual([
            'no-participants',
            'no-standings',
            'no-result',
            'stale-authority',
            'pending-commands',
            'stale-snapshot',
        ]);
    });
});
