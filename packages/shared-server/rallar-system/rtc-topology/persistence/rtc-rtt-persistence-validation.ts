import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
// prettier-ignore
import * as snapshotValidation
    from '../../group-state/snapshot/validate-persisted-group-snapshot.ts';
import {
    compareRtcTopologyIdentifiers,
    toCanonicalRtcTopologyGroupIdentity,
} from '../../rtc-topology-identifiers.ts';
import {
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../mutation/rtc-rtt-mutation-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';

export const RTC_RTT_MUTATION_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RTC_RTT_MUTATION_RETENTION_MS =
    RTC_RTT_MUTATION_RETENTION_MS;

type RtcRttMutationReceiptContract = Readonly<{
    receiptId: string;
    commandId: string;
    requestId: string;
    sessionIdFrom: string;
    sessionIdTo: string;
    aggregateRef: Readonly<{ sessionIdFrom: string; sessionIdTo: string }>;
    measurementVersion: number;
    affectedGroupRefs: readonly GroupRef[];
    acceptedAtEpochMs: number;
    outcome: 'accepted';
    attemptCount: number;
    acceptedStorageRevision: number;
    eventId: null;
    outboxIds: readonly string[];
    commandHash: string;
}>;

type RtcRttRecomputeIntentContract = Readonly<{
    outboxId: string;
    receiptId: string;
    groupSnapshot: GroupSnapshot;
    rtt: RttMeasurementInfo;
    createdAtEpochMs: number;
    commandHash: string;
    senderId: string;
    delivery:
        | Readonly<{ state: 'pending' }>
        | Readonly<{ state: 'delivered'; deliveredAtEpochMs: number }>;
}>;

type RtcRttEndpointAdmissionContract = Readonly<{
    endpointId: string;
    peers: readonly Readonly<{
        peerSessionId: string;
        expiresAtEpochMs: number;
    }>[];
    version: number;
    updatedAtEpochMs: number;
}>;

export function validateRtcRttMutationReceipt(
    value: unknown,
    physicalExpiry?: number,
): asserts value is RtcRttMutationReceiptContract {
    const receipt = record(value, 'RTC RTT receipt');
    exactKeys(receipt, [
        'receiptId',
        'commandId',
        'requestId',
        'sessionIdFrom',
        'sessionIdTo',
        'aggregateRef',
        'measurementVersion',
        'affectedGroupRefs',
        'acceptedAtEpochMs',
        'outcome',
        'attemptCount',
        'acceptedStorageRevision',
        'eventId',
        'outboxIds',
        'commandHash',
    ]);
    nonEmptyString(receipt.receiptId, 'receipt id');
    nonEmptyString(receipt.commandId, 'receipt command id');
    nonEmptyString(receipt.requestId, 'receipt request id');
    nonEmptyString(receipt.sessionIdFrom, 'receipt source session');
    nonEmptyString(receipt.sessionIdTo, 'receipt target session');
    if (receipt.sessionIdFrom === receipt.sessionIdTo) {
        throw new TypeError('RTC RTT receipt pair is invalid');
    }
    const aggregateRef = record(receipt.aggregateRef, 'receipt aggregate ref');
    exactKeys(aggregateRef, ['sessionIdFrom', 'sessionIdTo']);
    if (
        aggregateRef.sessionIdFrom !== receipt.sessionIdFrom ||
        aggregateRef.sessionIdTo !== receipt.sessionIdTo
    ) {
        throw new TypeError('RTC RTT receipt aggregate ref is invalid');
    }
    safeInteger(receipt.measurementVersion, 1, 'receipt measurement version');
    safeInteger(receipt.acceptedAtEpochMs, 0, 'receipt accepted time');
    if (receipt.outcome !== 'accepted') {
        throw new TypeError('RTC RTT receipt outcome is invalid');
    }
    safeInteger(receipt.attemptCount, 1, 'receipt attempt count');
    safeInteger(
        receipt.acceptedStorageRevision,
        0,
        'receipt accepted storage revision',
    );
    if (receipt.eventId !== null) {
        throw new TypeError('RTC RTT receipt event id must be null');
    }
    if (
        !Array.isArray(receipt.outboxIds) ||
        receipt.outboxIds.some(
            (outboxId) => typeof outboxId !== 'string' || outboxId.length === 0,
        )
    ) {
        throw new TypeError('RTC RTT receipt outbox ids are invalid');
    }
    validateCommandHash(receipt.commandHash);
    if (
        receipt.commandId !== receipt.receiptId ||
        receipt.requestId !== receipt.receiptId ||
        receipt.receiptId !==
            toRtcRttMutationReceiptId({
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
        'outboxId',
        'receiptId',
        'groupSnapshot',
        'rtt',
        'createdAtEpochMs',
        'commandHash',
        'senderId',
        'delivery',
    ]);
    nonEmptyString(intent.outboxId, 'recompute outbox id');
    nonEmptyString(intent.receiptId, 'recompute receipt id');
    safeInteger(intent.createdAtEpochMs, 0, 'recompute creation time');
    validateCommandHash(intent.commandHash);
    nonEmptyString(intent.senderId, 'recompute sender id');
    snapshotValidation.validatePersistedGroupSnapshot(intent.groupSnapshot);
    validateRtcRttMeasurement(intent.rtt);
    const group = intent.groupSnapshot as GroupSnapshot;
    const rtt = intent.rtt as RttMeasurementInfo;
    const receiptId = toRtcRttMutationReceiptId(rtt);
    if (
        intent.receiptId !== receiptId ||
        intent.outboxId !==
            toRtcRttRecomputeOutboxId(
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

export function validateRtcRttMeasurement(
    value: unknown,
): asserts value is RttMeasurementInfo {
    const measurement = record(value, 'RTC RTT measurement');
    exactKeys(measurement, [
        'sessionIdFrom',
        'sessionIdTo',
        'rttMs',
        'createdAtEpochMs',
        'version',
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

export function validateRtcRttEndpointAdmission(
    value: unknown,
    expectedEndpointId: string,
    physicalExpiry: number,
): asserts value is RtcRttEndpointAdmissionContract {
    const admission = record(value, 'RTC RTT endpoint admission');
    exactKeys(admission, [
        'endpointId',
        'peers',
        'version',
        'updatedAtEpochMs',
    ]);
    if (admission.endpointId !== expectedEndpointId) {
        throw new TypeError('RTC RTT endpoint admission identity is invalid');
    }
    safeInteger(admission.version, 1, 'endpoint admission version');
    safeInteger(
        admission.updatedAtEpochMs,
        0,
        'endpoint admission update time',
    );
    if (!Array.isArray(admission.peers) || admission.peers.length === 0) {
        throw new TypeError('RTC RTT endpoint admission peers are invalid');
    }
    let previous: string | undefined;
    let latestExpiry = 0;
    for (const rawPeer of admission.peers) {
        const peer = record(rawPeer, 'RTC RTT endpoint peer');
        exactKeys(peer, ['peerSessionId', 'expiresAtEpochMs']);
        nonEmptyString(peer.peerSessionId, 'endpoint peer id');
        safeInteger(
            peer.expiresAtEpochMs,
            (admission.updatedAtEpochMs as number) + 1,
            'endpoint peer expiry',
        );
        if (
            peer.peerSessionId === expectedEndpointId ||
            (previous !== undefined &&
                compareRtcTopologyIdentifiers(previous, peer.peerSessionId) >=
                    0)
        ) {
            throw new TypeError('RTC RTT endpoint peers are not canonical');
        }
        previous = peer.peerSessionId;
        latestExpiry = Math.max(latestExpiry, peer.expiresAtEpochMs as number);
    }
    if (physicalExpiry !== latestExpiry) {
        throw new TypeError(
            'RTC RTT endpoint physical expiry differs from leases',
        );
    }
}

export function validateRtcRttEndpointAdmissionCandidateVersion(
    domainVersion: number,
    expectedRevision: number | null,
): void {
    safeInteger(domainVersion, 1, 'endpoint admission version');
    validateExpectedRevision(expectedRevision, 'endpoint');
    const requiredVersion =
        expectedRevision === null ? 1 : expectedRevision + 2;
    if (
        !Number.isSafeInteger(requiredVersion) ||
        domainVersion !== requiredVersion
    ) {
        throw new TypeError(
            'RTC RTT endpoint admission version differs from storage guard',
        );
    }
}

export function validateRtcRttEndpointAdmissionPersistedVersion(
    domainVersion: number,
    storageRevision: number,
): void {
    safeInteger(domainVersion, 1, 'endpoint admission version');
    if (
        !Number.isSafeInteger(storageRevision) ||
        Object.is(storageRevision, -0) ||
        storageRevision < 0
    ) {
        throw new TypeError('RTC RTT endpoint storage revision is invalid');
    }
    const requiredVersion = storageRevision + 1;
    if (
        !Number.isSafeInteger(requiredVersion) ||
        domainVersion !== requiredVersion
    ) {
        throw new TypeError(
            'RTC RTT persisted endpoint version differs from storage revision',
        );
    }
}

function validateExactFamilyExpiry(
    acceptedAtEpochMs: number,
    physicalExpiry: number,
    authority: string,
): void {
    const expectedExpiry = acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS;
    if (!Number.isSafeInteger(expectedExpiry)) {
        throw new TypeError(
            `RTC RTT ${authority} physical expiry overflows retention`,
        );
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

function validateExpectedRevision(
    value: unknown,
    authority: string,
): asserts value is number | null {
    if (value === null) return;
    if (
        !Number.isSafeInteger(value) ||
        Object.is(value, -0) ||
        (value as number) < 0 ||
        (value as number) >= Number.MAX_SAFE_INTEGER
    ) {
        throw new TypeError(
            `RTC RTT ${authority} expected revision is invalid`,
        );
    }
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} is invalid`);
    }
    return value as Record<string, unknown>;
}

function exactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
): void {
    const keys = Object.keys(value).sort(compareRtcTopologyIdentifiers);
    const canonical = [...expected].sort(compareRtcTopologyIdentifiers);
    if (!rtcTopologySemanticEqual(keys, canonical)) {
        throw new TypeError('RTC RTT persisted fields are invalid');
    }
}

function nonEmptyString(
    value: unknown,
    label: string,
): asserts value is string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}

function safeInteger(value: unknown, minimum: number, label: string): void {
    if (!Number.isSafeInteger(value) || (value as number) < minimum) {
        throw new TypeError(`RTC RTT ${label} is invalid`);
    }
}
