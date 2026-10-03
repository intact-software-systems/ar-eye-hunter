import type { ALNackReason } from '@shared/al-contracts/al-control.ts';
import type { ALDurabilityAlgo } from '@shared/al-contracts/al-policy.ts';
import type { ALDeliveryFailure } from '@shared/alm/delivery/al-delivery-failure.ts';
import type {
    ALDeliveryDurabilityDowngrade,
    ALDeliveryRefusalReason,
    ALDeliveryRelayRejection,
    ALDeliverySkippedReason,
    ALDeliveryUnroutableReason
} from '@shared/alm/delivery/al-delivery-lifecycle.ts';
import type { ALStorageUnavailableCause } from '@shared/alm/storage/al-storage-unavailable.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeAlmRuntimeRecord } from './decode-alm-runtime-record.ts';

type AlmFailureDecoder = (failure: RallarBlackBoxTestRecord) => Either<string, ALDeliveryFailure>;

type AlmFailedAttemptOutcome = Extract<ALDeliveryFailure, Readonly<{ kind: 'attempt-failed'; }>>['outcome'];

/** Keyed by every value, so a new reason, outcome or NACK reason fails to compile here instead of decoding as invalid. */
const ALM_REFUSAL_REASONS: Readonly<Record<ALDeliveryRefusalReason, true>> = {
    unauthorized: true,
    malformed: true,
    oversized: true,
    unsupported: true,
    capacity: true
};

const ALM_SKIPPED_REASONS: Readonly<Record<ALDeliverySkippedReason, true>> = {
    disposed: true,
    'repair-exhausted': true,
    'pending-terminated': true,
    'planner-drop': true
};

const ALM_UNROUTABLE_REASONS: Readonly<Record<ALDeliveryUnroutableReason, true>> = {
    'no-route': true,
    'rate-limited': true,
    'circuit-open': true
};

const ALM_FAILED_ATTEMPT_OUTCOMES: Readonly<Record<AlmFailedAttemptOutcome, true>> = {
    failed: true,
    'no-targets': true
};

const ALM_STORAGE_UNAVAILABLE_CAUSES: Readonly<Record<ALStorageUnavailableCause, true>> = {
    missing: true,
    'open-failed': true,
    'reset-blocked': true,
    quota: true,
    closed: true,
    evicted: true,
    'transaction-failed': true
};

const ALM_DURABILITY_ALGOS: Readonly<Record<ALDurabilityAlgo, true>> = {
    volatile: true,
    'local-checkpoint': true,
    'local-outbox': true,
    'local-inbox': true
};

const ALM_NACK_REASONS: Readonly<Record<ALNackReason, true>> = {
    duplicate: true,
    gap: true,
    'resync-required': true,
    expired: true,
    unauthorized: true,
    'no-route': true,
    overloaded: true,
    stale: true,
    'not-yet-in-sync': true
};

/** Keyed by every failure kind, so a new kind fails to compile here instead of decoding as invalid. */
const ALM_FAILURE_DECODERS: Readonly<Record<ALDeliveryFailure['kind'], AlmFailureDecoder>> = {
    refused: (failure) =>
        decodeAlmFailureKey(ALM_REFUSAL_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'refused', reason })),
    'relay-rejected': (failure) =>
        decodeAlmRelayRejection(failure.rejection, 'failure.rejection')
            .mapRight((rejection): ALDeliveryFailure => ({ kind: 'relay-rejected', rejection })),
    'admission-failed': () => Either.ofRight<string, ALDeliveryFailure>({ kind: 'admission-failed' }),
    'storage-unavailable': (failure) =>
        decodeAlmFailureKey(ALM_STORAGE_UNAVAILABLE_CAUSES, failure.cause, 'cause')
            .mapRight((cause): ALDeliveryFailure => ({ kind: 'storage-unavailable', cause })),
    skipped: (failure) =>
        decodeAlmFailureKey(ALM_SKIPPED_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'skipped', reason })),
    unroutable: (failure) =>
        decodeAlmFailureKey(ALM_UNROUTABLE_REASONS, failure.reason, 'reason')
            .mapRight((reason): ALDeliveryFailure => ({ kind: 'unroutable', reason })),
    'attempt-failed': (failure) =>
        decodeAlmFailureKey(ALM_FAILED_ATTEMPT_OUTCOMES, failure.outcome, 'outcome')
            .mapRight((outcome): ALDeliveryFailure => ({ kind: 'attempt-failed', outcome })),
    'receipt-exhausted': decodeAlmReceiptExhaustedFailure,
    expired: () => Either.ofRight<string, ALDeliveryFailure>({ kind: 'expired' })
};

/** The failure the page stated, or the path of the field under the observation that it could not read. */
export function decodeAlmDeliveryFailure(value: unknown): Either<string, ALDeliveryFailure> {
    const failure = decodeAlmRuntimeRecord(value);
    const kind = failure.kind;
    return typeof kind === 'string' && Object.hasOwn(ALM_FAILURE_DECODERS, kind)
        ? ALM_FAILURE_DECODERS[kind as ALDeliveryFailure['kind']](failure)
        : Either.ofLeft('failure.kind');
}

/**
 * A trusted server relay is never named, so an id on one is refused. A trusted server refuses with `resync-required`
 * after admission or `unauthorized` before it; a peer relay only with `resync-required`.
 */
export function decodeAlmRelayRejection(
    value: unknown,
    field: string
): Either<string, ALDeliveryRelayRejection> {
    const rejection = decodeAlmRuntimeRecord(value);
    if (
        (rejection.reason === 'resync-required' || rejection.reason === 'unauthorized') &&
        rejection.relay === 'trusted-server' && rejection.peerId === undefined
    ) {
        return Either.ofRight<string, ALDeliveryRelayRejection>({
            relay: 'trusted-server',
            reason: rejection.reason
        });
    }
    if (
        rejection.reason === 'resync-required' && rejection.relay === 'peer' &&
        typeof rejection.peerId === 'string'
    ) {
        return Either.ofRight<string, ALDeliveryRelayRejection>({
            relay: 'peer',
            peerId: rejection.peerId,
            reason: 'resync-required'
        });
    }
    return Either.ofLeft(field);
}

function decodeAlmReceiptExhaustedFailure(
    failure: RallarBlackBoxTestRecord
): Either<string, ALDeliveryFailure> {
    if (failure.cause === 'budget') {
        return Either.ofRight<string, ALDeliveryFailure>({
            kind: 'receipt-exhausted',
            cause: 'budget'
        });
    }
    if (failure.cause !== 'hop-refused') {
        return Either.ofLeft('failure.cause');
    }
    const hopPeerId = failure.hopPeerId;
    if (typeof hopPeerId !== 'string') {
        return Either.ofLeft('failure.hopPeerId');
    }
    return decodeAlmFailureKey(ALM_NACK_REASONS, failure.nackReason, 'nackReason')
        .mapRight((nackReason): ALDeliveryFailure => ({
            kind: 'receipt-exhausted',
            cause: 'hop-refused',
            hopPeerId,
            nackReason
        }));
}

export function decodeAlmDurabilityDowngrade(value: unknown): Either<string, ALDeliveryDurabilityDowngrade> {
    const downgrade = decodeAlmRuntimeRecord(value);
    const requested = decodeAlmFailureKey(ALM_DURABILITY_ALGOS, downgrade.requested, 'requested').right;
    const cause = decodeAlmFailureKey(ALM_STORAGE_UNAVAILABLE_CAUSES, downgrade.cause, 'cause').right;
    if (requested === undefined) {
        return Either.ofLeft('durabilityDowngrade.requested');
    }
    if (cause === undefined) {
        return Either.ofLeft('durabilityDowngrade.cause');
    }
    return Either.ofRight({ requested, cause });
}

function decodeAlmFailureKey<TKey extends string>(
    keys: Readonly<Record<TKey, true>>,
    value: unknown,
    field: string
): Either<string, TKey> {
    return typeof value === 'string' && Object.hasOwn(keys, value)
        ? Either.ofRight(value as TKey)
        : Either.ofLeft(`failure.${field}`);
}
