import type {
    RallarMatchResult,
    RallarMatchResultInput,
} from './types.ts';

export function createRallarMatchResult<TSummary>(
    input: RallarMatchResultInput<TSummary>,
): RallarMatchResult<TSummary> {
    return {
        resultId: input.resultId,
        matchId: input.matchId,
        roomRef: input.roomRef,
        protocol: input.protocol,
        authority: input.authority,
        trust: input.trust,
        startedAtEpochMs: input.startedAtEpochMs,
        finishedAtEpochMs: input.finishedAtEpochMs,
        standings: input.standings,
        summary: input.summary,
        idempotencyKey: input.idempotencyKey ??
            createRallarMatchResultIdempotencyKey(input),
    };
}

export function createRallarMatchResultIdempotencyKey(
    input: Pick<
        RallarMatchResultInput<unknown>,
        'matchId' | 'authority' | 'finishedAtEpochMs'
    >,
): string {
    return [
        input.matchId,
        input.authority.kind,
        input.authority.id,
        String(input.authority.epoch),
        String(input.finishedAtEpochMs),
    ].map(encodeURIComponent).join(':');
}
