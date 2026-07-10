import { describe, expect, it } from 'vitest';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
import {
    createRallarMatchResultIdempotencyKey,
    createRallarMatchResult,
    deriveRallarMatchDiagnostics,
    deriveRallarMatchParticipants,
    deriveRallarMatchStandings,
} from '@shared/rallar-match/mod.ts';

if (false) {
    createRallarMatchResult({
        resultId: 'result-type-server',
        matchId: 'match-1',
        roomRef: { applicationId: 'app-1', groupId: 'room-1' },
        protocol: 'example.match.v1',
        authority: { kind: 'server', id: 'server-1', epoch: 1 },
        // @ts-expect-error Browser-safe result creation cannot mint server-validated trust.
        trust: 'server-validated',
        finishedAtEpochMs: 2_000,
        standings: [],
        summary: {},
    });

    // @ts-expect-error Room-trusted results require browser-director authority.
    createRallarMatchResult({
        resultId: 'result-type-room',
        matchId: 'match-1',
        roomRef: { applicationId: 'app-1', groupId: 'room-1' },
        protocol: 'example.match.v1',
        authority: { kind: 'server', id: 'server-1', epoch: 1 },
        trust: 'room-trusted',
        finishedAtEpochMs: 2_000,
        standings: [],
        summary: {},
    });
}

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
        } as unknown as GroupSnapshot;

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
        } as unknown as GroupSnapshot;

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

    it('orders participant and tied standing IDs by canonical ordinal value', () => {
        const escapedUnicodeId = '\u00e4';

        expect(deriveRallarMatchParticipants({
            members: [
                {
                    participantId: escapedUnicodeId,
                    online: false,
                    sessionIds: [],
                },
                {
                    participantId: 'z',
                    online: false,
                    sessionIds: [],
                },
            ],
        }).map((participant) => participant.participantId)).toEqual([
            'z',
            escapedUnicodeId,
        ]);

        expect(deriveRallarMatchStandings({
            rows: [
                {
                    participantId: escapedUnicodeId,
                    sessionIds: [],
                    metrics: { points: 1 },
                },
                {
                    participantId: 'z',
                    sessionIds: [],
                    metrics: { points: 1 },
                },
            ],
        }).map((standing) => standing.participantId)).toEqual([
            'z',
            escapedUnicodeId,
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
            'app-1:workspace%3Apresent%3Aworkspace-1:room-1:example.match.v1:match-1:browser-director:session-a:4:2000',
        );
        expect(result.trust).toBe('room-trusted');
        expect(result.summary).toEqual({ reason: 'finished' });
    });

    it('rejects server-validated trust and invalid room-trusted authority at runtime', () => {
        const input = {
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.match.v1',
            authority: { kind: 'server', id: 'server-1', epoch: 1 },
            finishedAtEpochMs: 2_000,
            standings: [],
            summary: {},
        } as const;

        expect(() => createRallarMatchResult({
            ...input,
            trust: 'server-validated',
        } as never)).toThrow(
            'Shared Rallar match result creation cannot assign server-validated trust.',
        );
        expect(() => createRallarMatchResult({
            ...input,
            trust: 'room-trusted',
        } as never)).toThrow(
            'Room-trusted Rallar match results require browser-director authority.',
        );
    });

    it('creates collision-safe result idempotency keys', () => {
        const serverKey = createRallarMatchResultIdempotencyKey({
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.match.v1',
            matchId: 'match-1:browser-director',
            authority: { kind: 'server', id: 'id', epoch: 1 },
            finishedAtEpochMs: 2_000,
        });
        const browserDirectorKey = createRallarMatchResultIdempotencyKey({
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1',
            },
            protocol: 'example.match.v1',
            matchId: 'match-1',
            authority: {
                kind: 'browser-director',
                id: 'server:id',
                epoch: 1,
                principalId: 'principal-a',
                sessionId: 'server:id',
            },
            finishedAtEpochMs: 2_000,
        });

        expect(serverKey).not.toBe(browserDirectorKey);
    });

    it('scopes result idempotency keys by room and preserves absent workspace identity', () => {
        const input = {
            protocol: 'example.match.v1',
            matchId: 'match-1',
            authority: { kind: 'server', id: 'server-1', epoch: 1 } as const,
            finishedAtEpochMs: 2_000,
        };
        const roomOneKey = createRallarMatchResultIdempotencyKey({
            ...input,
            roomRef: { applicationId: 'app-1', groupId: 'room-1' },
        });
        const roomTwoKey = createRallarMatchResultIdempotencyKey({
            ...input,
            roomRef: { applicationId: 'app-1', groupId: 'room-2' },
        });
        const emptyWorkspaceKey = createRallarMatchResultIdempotencyKey({
            ...input,
            roomRef: {
                applicationId: 'app-1',
                workspaceId: '',
                groupId: 'room-1',
            },
        });

        expect(roomOneKey).not.toBe(roomTwoKey);
        expect(roomOneKey).not.toBe(emptyWorkspaceKey);
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
