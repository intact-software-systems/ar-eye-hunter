import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { validatePersistedGroupSnapshot } from './services/group-snapshot-validation.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from './rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from './rtc-topology-semantic-equality.ts';

export const RTC_RTT_MUTATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

type RtcRttMutationReceiptContract = Readonly<{
    receiptId: string;
    sessionIdFrom: string;
    sessionIdTo: string;
    measurementVersion: number;
    affectedGroupRefs: readonly GroupRef[];
    acceptedAtEpochMs: number;
    outcome: 'accepted';
    commandHash: string;
}>;

type RtcRttRecomputeIntentContract = Readonly<{
    outboxId: string;
    receiptId: string;
    groupSnapshot: GroupSnapshot;
    rtt: RttMeasurementInfo;
    createdAtEpochMs: number;
    commandHash: string;
    delivery:
        | Readonly<{ state: 'pending' }>
        | Readonly<{ state: 'delivered'; deliveredAtEpochMs: number }>;
}>;

export function validateRtcRttMutationReceipt(
    value: unknown,
    physicalExpiry?: number,
): asserts value is RtcRttMutationReceiptContract {
    const receipt = record(value, 'RTC RTT receipt');
    exactKeys(receipt, [
        'receiptId', 'sessionIdFrom', 'sessionIdTo', 'measurementVersion',
        'affectedGroupRefs', 'acceptedAtEpochMs', 'outcome', 'commandHash',
    ]);
    nonEmptyString(receipt.receiptId, 'receipt id');
    nonEmptyString(receipt.sessionIdFrom, 'receipt source session');
    nonEmptyString(receipt.sessionIdTo, 'receipt target session');
    if (receipt.sessionIdFrom === receipt.sessionIdTo) {
        throw new TypeError('RTC RTT receipt pair is invalid');
    }
    safeInteger(receipt.measurementVersion, 1, 'receipt measurement version');
    safeInteger(receipt.acceptedAtEpochMs, 0, 'receipt accepted time');
    if (receipt.outcome !== 'accepted') {
        throw new TypeError('RTC RTT receipt outcome is invalid');
    }
    validateCommandHash(receipt.commandHash);
    if (
        receipt.receiptId !== toRtcRttMutationReceiptId({
            sessionIdFrom: receipt.sessionIdFrom as string,
            sessionIdTo: receipt.sessionIdTo as string,
            version: receipt.measurementVersion as number,
        })
    ) {
        throw new TypeError('RTC RTT receipt identity is invalid');
    }
    if (
        !Array.isArray(receipt.affectedGroupRefs) ||
        receipt.affectedGroupRefs.length === 0
    ) {
        throw new TypeError('RTC RTT receipt affected group refs are invalid');
    }
    let previousIdentity: string | undefined;
    for (const valueRef of receipt.affectedGroupRefs) {
        validateCanonicalGroupRef(valueRef);
        const identity = toCanonicalRtcTopologyGroupIdentity(valueRef);
        if (
            previousIdentity !== undefined &&
            compareRtcTopologyIdentifiers(previousIdentity, identity) >= 0
        ) {
            throw new TypeError(
                'RTC RTT receipt affected group refs are not canonical',
            );
        }
        previousIdentity = identity;
    }
    if (physicalExpiry !== undefined) {
        validateExactFamilyExpiry(
            receipt.acceptedAtEpochMs as number,
            physicalExpiry,
            'receipt',
        );
    }
}

export function validateRtcRttRecomputeIntent(
    value: unknown,
    physicalExpiry?: number,
): asserts value is RtcRttRecomputeIntentContract {
    const intent = record(value, 'RTC RTT recompute intent');
    exactKeys(intent, [
        'outboxId', 'receiptId', 'groupSnapshot', 'rtt', 'createdAtEpochMs',
        'commandHash', 'delivery',
    ]);
    nonEmptyString(intent.outboxId, 'recompute outbox id');
    nonEmptyString(intent.receiptId, 'recompute receipt id');
    safeInteger(intent.createdAtEpochMs, 0, 'recompute creation time');
    validateCommandHash(intent.commandHash);
    validatePersistedGroupSnapshot(intent.groupSnapshot);
    validateMeasurement(intent.rtt);
    const group = intent.groupSnapshot as GroupSnapshot;
    const rtt = intent.rtt as RttMeasurementInfo;
    const receiptId = toRtcRttMutationReceiptId(rtt);
    if (
        intent.receiptId !== receiptId ||
        intent.outboxId !== toRtcRttRecomputeOutboxId(
            receiptId,
            group.group,
            intent.commandHash as string,
        )
    ) {
        throw new TypeError('RTC RTT recompute intent identity is invalid');
    }
    const delivery = record(intent.delivery, 'RTC RTT recompute delivery');
    if (delivery.state === 'pending') {
        exactKeys(delivery, ['state']);
    } else if (delivery.state === 'delivered') {
        exactKeys(delivery, ['state', 'deliveredAtEpochMs']);
        safeInteger(
            delivery.deliveredAtEpochMs,
            intent.createdAtEpochMs as number,
            'recompute delivered time',
        );
        if (
            physicalExpiry !== undefined &&
            (delivery.deliveredAtEpochMs as number) > physicalExpiry
        ) {
            throw new TypeError('RTC RTT recompute delivered time is invalid');
        }
    } else {
        throw new TypeError('RTC RTT recompute delivery state is invalid');
    }
    if (physicalExpiry !== undefined) {
        validateExactFamilyExpiry(
            intent.createdAtEpochMs as number,
            physicalExpiry,
            'recompute intent',
        );
    }
}

export function validateRtcRttWriteCandidate(
    value: unknown,
    mutationExpireAtTimestamp: number,
): void {
    const candidate = record(value, 'RTC RTT write candidate');
    const receipt = candidate.receipt;
    validateRtcRttMutationReceipt(receipt, mutationExpireAtTimestamp);
    const canonicalReceipt = receipt as RtcRttMutationReceiptContract;
    if (!Array.isArray(candidate.recomputeIntents)) {
        throw new TypeError('RTC RTT recompute intents are mandatory');
    }
    const intents = candidate.recomputeIntents;
    if (intents.length !== canonicalReceipt.affectedGroupRefs.length) {
        throw new TypeError('RTC RTT recompute intent set is incomplete');
    }
    const expectedGroups = canonicalReceipt.affectedGroupRefs.map(
        toCanonicalRtcTopologyGroupIdentity,
    );
    const observedGroups: string[] = [];
    for (const rawIntent of intents) {
        validateRtcRttRecomputeIntent(rawIntent, mutationExpireAtTimestamp);
        const intent = rawIntent as RtcRttRecomputeIntentContract;
        if (intent.delivery.state !== 'pending') {
            throw new TypeError('RTC RTT write intent must be pending');
        }
        validateIntentAgainstReceipt(intent, canonicalReceipt);
        observedGroups.push(
            toCanonicalRtcTopologyGroupIdentity(intent.groupSnapshot.group),
        );
    }
    observedGroups.sort(compareRtcTopologyIdentifiers);
    if (!rtcTopologySemanticEqual(observedGroups, expectedGroups)) {
        throw new TypeError('RTC RTT recompute intent set differs from receipt');
    }
}

function validateIntentAgainstReceipt(
    intent: RtcRttRecomputeIntentContract,
    receipt: RtcRttMutationReceiptContract,
): void {
    const groupIdentity = toCanonicalRtcTopologyGroupIdentity(
        intent.groupSnapshot.group,
    );
    const receiptIncludesGroup = receipt.affectedGroupRefs.some((ref) =>
        toCanonicalRtcTopologyGroupIdentity(ref) === groupIdentity
    );
    const activeSessionIds = new Set(
        intent.groupSnapshot.activeSessions
            .filter((session) =>
                session.connectedAtEpochMs <= intent.createdAtEpochMs &&
                session.expiresAtEpochMs > intent.createdAtEpochMs
            )
            .map((session) => session.sessionId),
    );
    const groupExpiry = intent.groupSnapshot.group.expiresAtEpochMs;
    if (
        receipt.receiptId !== intent.receiptId ||
        receipt.sessionIdFrom !== intent.rtt.sessionIdFrom ||
        receipt.sessionIdTo !== intent.rtt.sessionIdTo ||
        receipt.measurementVersion !== intent.rtt.version ||
        receipt.commandHash !== intent.commandHash ||
        receipt.acceptedAtEpochMs !== intent.createdAtEpochMs ||
        !receiptIncludesGroup ||
        intent.groupSnapshot.group.status !== 'active' ||
        (groupExpiry !== undefined && groupExpiry <= intent.createdAtEpochMs) ||
        !activeSessionIds.has(receipt.sessionIdFrom) ||
        !activeSessionIds.has(receipt.sessionIdTo)
    ) {
        throw new TypeError(
            'RTC RTT recompute intent differs from immutable receipt authority',
        );
    }
}

function validateMeasurement(value: unknown): asserts value is RttMeasurementInfo {
    const measurement = record(value, 'RTC RTT measurement');
    exactKeys(measurement, [
        'sessionIdFrom', 'sessionIdTo', 'rttMs', 'createdAtEpochMs', 'version',
    ]);
    nonEmptyString(measurement.sessionIdFrom, 'measurement source session');
    nonEmptyString(measurement.sessionIdTo, 'measurement target session');
    if (measurement.sessionIdFrom === measurement.sessionIdTo) {
        throw new TypeError('RTC RTT measurement pair is invalid');
    }
    if (
        typeof measurement.rttMs !== 'number' ||
        !Number.isFinite(measurement.rttMs) ||
        measurement.rttMs <= 0
    ) {
        throw new TypeError('RTC RTT measurement duration is invalid');
    }
    safeInteger(measurement.createdAtEpochMs, 0, 'measurement creation time');
    safeInteger(measurement.version, 1, 'measurement version');
}

function validateExactFamilyExpiry(
    acceptedAtEpochMs: number,
    physicalExpiry: number,
    authority: string,
): void {
    const expectedExpiry = acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
    if (!Number.isSafeInteger(expectedExpiry)) {
        throw new TypeError(`RTC RTT ${authority} physical expiry overflows retention`);
    }
    if (physicalExpiry !== expectedExpiry) {
        throw new TypeError(
            `RTC RTT ${authority} physical expiry differs from exact retention`,
        );
    }
}

function validateCanonicalGroupRef(value: unknown): asserts value is GroupRef {
    const ref = record(value, 'RTC RTT receipt group ref');
    exactKeys(
        ref,
        ref.workspaceId === undefined
            ? ['applicationId', 'groupId']
            : ['applicationId', 'workspaceId', 'groupId'],
    );
    nonEmptyString(ref.applicationId, 'group application id');
    nonEmptyString(ref.groupId, 'group id');
    if (ref.workspaceId !== undefined) {
        nonEmptyString(ref.workspaceId, 'group workspace id');
    }
}

function validateCommandHash(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) {
        throw new TypeError('RTC RTT command hash is invalid');
    }
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
    const keys = Object.keys(value).sort(compareRtcTopologyIdentifiers);
    const canonical = [...expected].sort(compareRtcTopologyIdentifiers);
    if (!rtcTopologySemanticEqual(keys, canonical)) {
        throw new TypeError('RTC RTT persisted fields are invalid');
    }
}

function nonEmptyString(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}

function safeInteger(value: unknown, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}
