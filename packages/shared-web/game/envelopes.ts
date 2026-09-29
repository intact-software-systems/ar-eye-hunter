import { RallarGameIntentSequences } from './rallar-game-intent-sequences.ts';

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
    const intentSequencesByKey = new Map<string, RallarGameIntentSequences>();
    const rejectBySequence = <T>(envelope: RallarGameEnvelope<T>, key: string) =>
        envelope.kind === 'intent'
            ? getIntentSequences(intentSequencesByKey, key).accept(envelope.seq)
            : rejectByOrderedSequence(lastSeqByKey.get(key), envelope.seq);

    return {
        accept<T>(
            envelope: RallarGameEnvelope<T>,
            constraints: RallarGameSequenceAcceptConstraints = {}
        ): RallarGameSequenceAcceptResult<T> {
            const key = sequenceKey(envelope);
            const reason = rejectByConstraints(envelope, constraints) ??
                rejectBySequence(envelope, key);
            if (reason) {
                return { accepted: false, reason, envelope };
            }
            lastSeqByKey.set(key, Math.max(envelope.seq, lastSeqByKey.get(key) ?? envelope.seq));
            return { accepted: true, envelope };
        },
        last(envelope): number | undefined {
            return lastSeqByKey.get(sequenceKey(envelope));
        },
        reset(): void {
            lastSeqByKey.clear();
            intentSequencesByKey.clear();
        }
    };
}

function rejectByOrderedSequence(
    previous: number | undefined,
    seq: number
): 'duplicate-sequence' | 'stale-sequence' | undefined {
    if (previous === undefined || seq > previous) {
        return undefined;
    }
    return seq === previous ? 'duplicate-sequence' : 'stale-sequence';
}

function getIntentSequences(
    byKey: Map<string, RallarGameIntentSequences>,
    key: string
): RallarGameIntentSequences {
    const existing = byKey.get(key);
    if (existing) {
        return existing;
    }
    const created = new RallarGameIntentSequences();
    byKey.set(key, created);
    return created;
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
