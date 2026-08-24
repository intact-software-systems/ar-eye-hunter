import { createRallarServerValidatedMatchResult } from '@shared-server/game/match-result.ts';
// dprint-ignore
import {
    describe,
    expect,
    expectTypeOf,
    it
} from 'vitest';

describe('Rallar server match result helper', () => {
    it('creates server-validated result envelopes', () => {
        const result = createRallarServerValidatedMatchResult({
            resultId: 'result-1',
            matchId: 'match-1',
            roomRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            protocol: 'example.authority.v1',
            authority: {
                kind: 'server',
                id: 'server-1',
                epoch: 2
            },
            finishedAtEpochMs: 5_000,
            standings: [
                {
                    participantId: 'principal-a',
                    principalId: 'principal-a',
                    sessionIds: ['session-a'],
                    rank: 1,
                    tieGroup: 1,
                    metrics: { points: 9 }
                }
            ],
            summary: { acceptedCommands: 3 }
        });

        expectTypeOf(result.trust).toEqualTypeOf<'server-validated'>();
        expectTypeOf(result.authority.kind).toEqualTypeOf<'server'>();
        expect(result.trust).toBe('server-validated');
        expect(result.idempotencyKey).toBe(
            'app-1:workspace%3Aworkspace-1:room-1:example.authority.v1:match-1:server:server-1:2:5000'
        );
    });

    it('rejects browser-director authority at runtime', () => {
        expect(() =>
            createRallarServerValidatedMatchResult({
                resultId: 'result-1',
                matchId: 'match-1',
                roomRef: {
                    applicationId: 'app-1',
                    workspaceId: 'workspace-1',
                    groupId: 'room-1'
                },
                protocol: 'example.authority.v1',
                authority: {
                    kind: 'browser-director',
                    id: 'session-1',
                    epoch: 2
                },
                finishedAtEpochMs: 5_000,
                standings: [],
                summary: { acceptedCommands: 0 }
            } as never)
        ).toThrow(
            'Server-validated Rallar match results require server authority.'
        );
    });
});
