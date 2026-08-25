export type RallarGameEnvelopeKind =
    | 'capability'
    | 'presence'
    | 'input'
    | 'intent'
    | 'event'
    | 'snapshot'
    | 'sync-request'
    | 'heartbeat';

type RallarGameEnvelopePayload =
    | object
    | string
    | number
    | boolean
    | null
    | undefined;

export interface RallarGameEnvelope<T> {
    readonly protocol: string;
    readonly kind: RallarGameEnvelopeKind;
    readonly roomId: string;
    readonly matchId?: string;
    readonly senderId: string;
    readonly seq: number;
    readonly sentAtEpochMs: number;
    readonly directorEpoch: number;
    readonly payload: T;
}

export interface RallarGameEnvelopeCreateInput<T> {
    readonly protocol: string;
    readonly kind: RallarGameEnvelopeKind;
    readonly roomId: string;
    readonly matchId?: string;
    readonly senderId: string;
    readonly seq: number;
    readonly directorEpoch: number;
    readonly payload: T;
    readonly sentAtEpochMs?: number;
}

export type RallarGameEnvelopeRejectReason =
    | 'wrong-protocol'
    | 'wrong-room'
    | 'wrong-match'
    | 'wrong-sender'
    | 'wrong-kind'
    | 'stale-epoch'
    | 'duplicate-sequence'
    | 'stale-sequence';

export interface RallarGameSequenceAcceptConstraints {
    readonly protocol?: string;
    readonly roomId?: string;
    readonly matchId?: string;
    readonly senderId?: string;
    readonly minDirectorEpoch?: number;
    readonly kinds?: readonly RallarGameEnvelopeKind[];
}

export type RallarGameSequenceAcceptResult<T = RallarGameEnvelopePayload> =
    | Readonly<{
        accepted: true;
        envelope: RallarGameEnvelope<T>;
    }>
    | Readonly<{
        accepted: false;
        reason: RallarGameEnvelopeRejectReason;
        envelope: RallarGameEnvelope<T>;
    }>;

export interface RallarGameSequenceTracker {
    accept<T>(
        envelope: RallarGameEnvelope<T>,
        constraints?: RallarGameSequenceAcceptConstraints
    ): RallarGameSequenceAcceptResult<T>;
    last<T>(
        envelope:
            | RallarGameEnvelope<T>
            | Pick<RallarGameEnvelope<T>, 'roomId' | 'matchId' | 'directorEpoch' | 'senderId' | 'kind'>
    ): number | undefined;
    reset(): void;
}

const RALLAR_GAME_ENVELOPE_KINDS = new Set<RallarGameEnvelopeKind>([
    'capability',
    'presence',
    'input',
    'intent',
    'event',
    'snapshot',
    'sync-request',
    'heartbeat'
]);

export function createRallarGameEnvelope<T>(
    input: RallarGameEnvelopeCreateInput<T>
): RallarGameEnvelope<T> {
    return {
        protocol: input.protocol,
        kind: input.kind,
        roomId: input.roomId,
        ...(input.matchId === undefined ? {} : { matchId: input.matchId }),
        senderId: input.senderId,
        seq: input.seq,
        sentAtEpochMs: input.sentAtEpochMs ?? Date.now(),
        directorEpoch: input.directorEpoch,
        payload: input.payload
    };
}

export function isRallarGameEnvelope(
    value: unknown,
    protocol: string
): value is RallarGameEnvelope<RallarGameEnvelopePayload> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const envelope = value as Partial<RallarGameEnvelope<RallarGameEnvelopePayload>>;
    return envelope.protocol === protocol &&
        typeof envelope.kind === 'string' &&
        RALLAR_GAME_ENVELOPE_KINDS.has(envelope.kind as RallarGameEnvelopeKind) &&
        typeof envelope.roomId === 'string' &&
        envelope.roomId.length > 0 &&
        (envelope.matchId === undefined || typeof envelope.matchId === 'string') &&
        typeof envelope.senderId === 'string' &&
        envelope.senderId.length > 0 &&
        typeof envelope.seq === 'number' &&
        Number.isSafeInteger(envelope.seq) &&
        envelope.seq >= 0 &&
        typeof envelope.sentAtEpochMs === 'number' &&
        Number.isFinite(envelope.sentAtEpochMs) &&
        typeof envelope.directorEpoch === 'number' &&
        Number.isSafeInteger(envelope.directorEpoch) &&
        envelope.directorEpoch >= 0 &&
        'payload' in envelope;
}

export function createRallarGameSequenceTracker(): RallarGameSequenceTracker {
    const lastSeqByKey = new Map<string, number>();

    return {
        accept<T>(
            envelope: RallarGameEnvelope<T>,
            constraints: RallarGameSequenceAcceptConstraints = {}
        ): RallarGameSequenceAcceptResult<T> {
            const rejected = rejectByConstraints(envelope, constraints);
            if (rejected) {
                return {
                    accepted: false,
                    reason: rejected,
                    envelope
                };
            }

            const key = sequenceKey(envelope);
            const previous = lastSeqByKey.get(key);
            if (previous !== undefined) {
                if (envelope.seq === previous) {
                    return {
                        accepted: false,
                        reason: 'duplicate-sequence',
                        envelope
                    };
                }

                if (envelope.seq < previous) {
                    return {
                        accepted: false,
                        reason: 'stale-sequence',
                        envelope
                    };
                }
            }

            lastSeqByKey.set(key, envelope.seq);
            return {
                accepted: true,
                envelope
            };
        },
        last(envelope): number | undefined {
            return lastSeqByKey.get(sequenceKey(envelope));
        },
        reset(): void {
            lastSeqByKey.clear();
        }
    };
}

function rejectByConstraints<T>(
    envelope: RallarGameEnvelope<T>,
    constraints: RallarGameSequenceAcceptConstraints
): Exclude<RallarGameSequenceAcceptResult, { accepted: true; }>['reason'] | undefined {
    if (constraints.protocol && envelope.protocol !== constraints.protocol) {
        return 'wrong-protocol';
    }

    if (constraints.roomId && envelope.roomId !== constraints.roomId) {
        return 'wrong-room';
    }

    if (
        constraints.matchId !== undefined &&
        envelope.matchId !== constraints.matchId
    ) {
        return 'wrong-match';
    }

    if (constraints.senderId && envelope.senderId !== constraints.senderId) {
        return 'wrong-sender';
    }

    if (
        constraints.kinds &&
        !constraints.kinds.includes(envelope.kind)
    ) {
        return 'wrong-kind';
    }

    if (
        constraints.minDirectorEpoch !== undefined &&
        envelope.directorEpoch < constraints.minDirectorEpoch
    ) {
        return 'stale-epoch';
    }

    return undefined;
}

function sequenceKey<T>(
    envelope: Pick<RallarGameEnvelope<T>, 'roomId' | 'matchId' | 'directorEpoch' | 'senderId' | 'kind'>
): string {
    return [
        envelope.roomId,
        envelope.matchId ?? '',
        envelope.directorEpoch,
        envelope.senderId,
        envelope.kind
    ].join('\u001f');
}
