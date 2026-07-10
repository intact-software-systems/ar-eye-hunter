import type {
    RallarMatchResult,
    RallarMatchResultInput,
} from '@shared/rallar-match/mod.ts';
import { createRallarMatchResult } from '@shared/rallar-match/mod.ts';
import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';

export type RallarServerValidatedMatchResultInput<TSummary = unknown> =
    Omit<RallarMatchResultInput<TSummary>, 'authority' | 'trust'> &
    Readonly<{
        authority: RallarGameAuthorityRef & Readonly<{ kind: 'server' }>;
    }>;

export function createRallarServerValidatedMatchResult<TSummary>(
    input: RallarServerValidatedMatchResultInput<TSummary>,
): RallarMatchResult<TSummary> {
    if (input.authority.kind !== 'server') {
        throw new Error(
            'Server-validated Rallar match results require server authority.',
        );
    }

    return createRallarMatchResult({
        resultId: input.resultId,
        matchId: input.matchId,
        roomRef: input.roomRef,
        protocol: input.protocol,
        authority: input.authority,
        trust: 'server-validated',
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs: input.finishedAtEpochMs,
        standings: input.standings,
        summary: input.summary,
        idempotencyKey: input.idempotencyKey,
    });
}
