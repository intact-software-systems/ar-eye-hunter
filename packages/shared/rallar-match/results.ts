import type {
    RallarLocalMatchResult,
    RallarLocalMatchResultInput,
    RallarMatchResultInput,
    RallarRoomTrustedMatchResult,
    RallarRoomTrustedMatchResultInput,
} from './types.ts';

export function createRallarMatchResult<TSummary>(
    input: RallarLocalMatchResultInput<TSummary>,
): RallarLocalMatchResult<TSummary>;
export function createRallarMatchResult<TSummary>(
    input: RallarRoomTrustedMatchResultInput<TSummary>,
): RallarRoomTrustedMatchResult<TSummary>;
export function createRallarMatchResult<TSummary>(
    input: RallarMatchResultInput<TSummary>,
): RallarLocalMatchResult<TSummary> | RallarRoomTrustedMatchResult<TSummary>;
export function createRallarMatchResult<TSummary>(
    input: RallarMatchResultInput<TSummary>,
): RallarLocalMatchResult<TSummary> | RallarRoomTrustedMatchResult<TSummary> {
    if ((input as Readonly<{ trust?: unknown }>).trust === 'server-validated') {
        throw new Error(
            'Shared Rallar match result creation cannot assign server-validated trust.',
        );
    }
    if (
        input.trust === 'room-trusted' &&
        !isBrowserDirectorAuthority(input.authority)
    ) {
        throw new Error(
            'Room-trusted Rallar match results require browser-director authority.',
        );
    }

    const idempotencyKey = input.idempotencyKey ??
        createRallarMatchResultIdempotencyKey(input);
    if (input.trust === 'room-trusted') {
        return { ...input, idempotencyKey };
    }
    return { ...input, idempotencyKey };
}

export function createRallarMatchResultIdempotencyKey(
    input: Pick<
        RallarLocalMatchResultInput<unknown>,
        | 'roomRef'
        | 'protocol'
        | 'matchId'
        | 'authority'
        | 'finishedAtEpochMs'
    >,
): string {
    const workspace = `workspace:${input.roomRef.workspaceId ?? ''}`;

    return [
        input.roomRef.applicationId,
        workspace,
        input.roomRef.groupId,
        input.protocol,
        input.matchId,
        input.authority.kind,
        input.authority.id,
        String(input.authority.epoch),
        String(input.finishedAtEpochMs),
    ].map(encodeURIComponent).join(':');
}

function isBrowserDirectorAuthority(
    authority: unknown,
): boolean {
    if (!authority || typeof authority !== 'object') {
        return false;
    }

    const value = authority as Readonly<Record<string, unknown>>;
    return value.kind === 'browser-director' &&
        typeof value.id === 'string' &&
        typeof value.epoch === 'number' &&
        typeof value.principalId === 'string' &&
        typeof value.sessionId === 'string';
}
