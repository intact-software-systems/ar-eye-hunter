import type { RallarGameAuthorityRef } from '@shared/rallar-game/mod.ts';
import type {
    RallarMatchServerAuthorityDescriptor,
    RallarServerValidatedMatchResult
} from '@shared/rallar-match/mod.ts';
import { createRallarMatchResultIdempotencyKey } from '@shared/rallar-match/mod.ts';

export type RallarServerValidatedMatchResultInput<TSummary> =
    & Omit<RallarServerValidatedMatchResult<TSummary>, 'authority' | 'trust' | 'idempotencyKey'>
    & Readonly<{
        authority: RallarGameAuthorityRef & Readonly<{ kind: 'server'; }>;
        idempotencyKey?: string;
    }>;

export function createRallarServerValidatedMatchResult<TSummary>(
    input: RallarServerValidatedMatchResultInput<TSummary>
): RallarServerValidatedMatchResult<TSummary> {
    if (input.authority.kind !== 'server') {
        throw new Error(
            'Server-validated Rallar match results require server authority.'
        );
    }

    const authority: RallarMatchServerAuthorityDescriptor = {
        kind: 'server',
        id: input.authority.id,
        epoch: input.authority.epoch
    };

    return {
        resultId: input.resultId,
        matchId: input.matchId,
        roomRef: input.roomRef,
        protocol: input.protocol,
        authority,
        trust: 'server-validated',
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs: input.finishedAtEpochMs,
        standings: input.standings,
        summary: input.summary,
        idempotencyKey: input.idempotencyKey ??
            createRallarMatchResultIdempotencyKey({
                roomRef: input.roomRef,
                protocol: input.protocol,
                matchId: input.matchId,
                authority,
                finishedAtEpochMs: input.finishedAtEpochMs
            })
    };
}
