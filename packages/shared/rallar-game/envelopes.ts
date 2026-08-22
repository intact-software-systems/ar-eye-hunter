import type {
    RallarGameAuthorityEnvelope,
    RallarGameAuthorityEnvelopeCreateInput,
    RallarGameAuthorityEnvelopeKind,
    RallarGameAuthorityEnvelopeRejectReason,
    RallarGameAuthorityKind,
    RallarGameAuthoritySequenceAcceptConstraints,
    RallarGameAuthoritySequenceAcceptResult,
    RallarGameAuthoritySequenceTracker
} from './types.ts';

const RALLAR_GAME_AUTHORITY_ENVELOPE_KINDS = new Set<RallarGameAuthorityEnvelopeKind>([
    'command',
    'command-result',
    'event',
    'snapshot',
    'sync-request',
    'presence'
]);

const RALLAR_GAME_AUTHORITY_KINDS = new Set<RallarGameAuthorityKind>([
    'server',
    'browser-director'
]);

export function createRallarGameAuthorityEnvelope<T>(
    input: RallarGameAuthorityEnvelopeCreateInput<T>
): RallarGameAuthorityEnvelope<T> {
    return {
        protocol: input.protocol,
        kind: input.kind,
        roomId: input.roomId,
        senderId: input.senderId,
        seq: input.seq,
        sentAtEpochMs: input.sentAtEpochMs ?? Date.now(),
        authority: input.authority,
        payload: input.payload
    };
}

export function isRallarGameAuthorityEnvelope(
    value: unknown,
    protocol: string
): value is RallarGameAuthorityEnvelope<unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const envelope = value as Partial<RallarGameAuthorityEnvelope<unknown>>;
    return envelope.protocol === protocol &&
        typeof envelope.kind === 'string' &&
        RALLAR_GAME_AUTHORITY_ENVELOPE_KINDS.has(
            envelope.kind as RallarGameAuthorityEnvelopeKind
        ) &&
        typeof envelope.roomId === 'string' &&
        envelope.roomId.length > 0 &&
        typeof envelope.senderId === 'string' &&
        envelope.senderId.length > 0 &&
        typeof envelope.seq === 'number' &&
        Number.isSafeInteger(envelope.seq) &&
        envelope.seq >= 0 &&
        typeof envelope.sentAtEpochMs === 'number' &&
        Number.isFinite(envelope.sentAtEpochMs) &&
        isRallarGameAuthorityRef(envelope.authority) &&
        'payload' in envelope;
}

export function createRallarGameAuthoritySequenceTracker(): RallarGameAuthoritySequenceTracker {
    const lastSeqByKey = new Map<string, number>();

    return {
        accept(
            envelope: RallarGameAuthorityEnvelope<unknown>,
            constraints: RallarGameAuthoritySequenceAcceptConstraints = {}
        ): RallarGameAuthoritySequenceAcceptResult {
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
            return { accepted: true, envelope };
        },
        last(envelope): number | undefined {
            return lastSeqByKey.get(sequenceKey(envelope));
        },
        reset(): void {
            lastSeqByKey.clear();
        }
    };
}

function isRallarGameAuthorityRef(value: unknown): boolean {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }

    const authority = value as {
        kind?: unknown;
        id?: unknown;
        epoch?: unknown;
    };
    return typeof authority.kind === 'string' &&
        RALLAR_GAME_AUTHORITY_KINDS.has(authority.kind as RallarGameAuthorityKind) &&
        typeof authority.id === 'string' &&
        authority.id.length > 0 &&
        typeof authority.epoch === 'number' &&
        Number.isSafeInteger(authority.epoch) &&
        authority.epoch >= 0;
}

function rejectByConstraints(
    envelope: RallarGameAuthorityEnvelope<unknown>,
    constraints: RallarGameAuthoritySequenceAcceptConstraints
): RallarGameAuthorityEnvelopeRejectReason | undefined {
    if (constraints.protocol && envelope.protocol !== constraints.protocol) {
        return 'wrong-protocol';
    }

    if (constraints.roomId && envelope.roomId !== constraints.roomId) {
        return 'wrong-room';
    }

    if (constraints.senderId && envelope.senderId !== constraints.senderId) {
        return 'wrong-sender';
    }

    if (constraints.kinds && !constraints.kinds.includes(envelope.kind)) {
        return 'wrong-kind';
    }

    if (
        constraints.authorityKind &&
        envelope.authority.kind !== constraints.authorityKind
    ) {
        return 'wrong-authority-kind';
    }

    if (constraints.authorityId && envelope.authority.id !== constraints.authorityId) {
        return 'wrong-authority-id';
    }

    if (
        constraints.minAuthorityEpoch !== undefined &&
        envelope.authority.epoch < constraints.minAuthorityEpoch
    ) {
        return 'stale-authority-epoch';
    }

    return undefined;
}

function sequenceKey(
    envelope: Pick<RallarGameAuthorityEnvelope<unknown>, 'roomId' | 'authority' | 'senderId' | 'kind'>
): string {
    return [
        envelope.roomId,
        envelope.authority.kind,
        envelope.authority.id,
        envelope.authority.epoch,
        envelope.senderId,
        envelope.kind
    ].join('\u001f');
}
