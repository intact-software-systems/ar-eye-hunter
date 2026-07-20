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
        'receiptId', 'commandId', 'requestId', 'sessionIdFrom', 'sessionIdTo',
        'aggregateRef', 'measurementVersion', 'affectedGroupRefs',
        'acceptedAtEpochMs', 'outcome', 'attemptCount',
        'acceptedStorageRevision', 'eventId', 'outboxIds', 'commandHash',
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
        receipt.outboxIds.some((outboxId) =>
            typeof outboxId !== 'string' || outboxId.length === 0
        )
    ) {
        throw new TypeError('RTC RTT receipt outbox ids are invalid');
    }
    validateCommandHash(receipt.commandHash);
    if (
        receipt.commandId !== receipt.receiptId ||
        receipt.requestId !== receipt.receiptId ||
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
    validateRtcRttMeasurement(intent.rtt);
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
    exactKeys(candidate, [
        'outcome', 'reason', 'affectedGroups', 'endpointGuards',
        'measurementGuard', 'receipt', 'recomputeIntents',
    ]);
    if (candidate.outcome !== 'write' || candidate.reason !== 'accepted') {
        throw new TypeError('RTC RTT write candidate discriminant is invalid');
    }
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
    const intentByGroup = new Map<string, RtcRttRecomputeIntentContract>();
    for (const rawIntent of intents) {
        validateRtcRttRecomputeIntent(rawIntent, mutationExpireAtTimestamp);
        const intent = rawIntent as RtcRttRecomputeIntentContract;
        if (intent.delivery.state !== 'pending') {
            throw new TypeError('RTC RTT write intent must be pending');
        }
        validateIntentAgainstReceipt(intent, canonicalReceipt);
        const groupIdentity = toCanonicalRtcTopologyGroupIdentity(
            intent.groupSnapshot.group,
        );
        observedGroups.push(groupIdentity);
        intentByGroup.set(groupIdentity, intent);
    }
    if (!rtcTopologySemanticEqual(observedGroups, expectedGroups)) {
        throw new TypeError('RTC RTT recompute intent set differs from receipt');
    }
    validateAffectedGroups(candidate.affectedGroups, expectedGroups, intentByGroup);
    const measurement = validateMeasurementGuard(
        candidate.measurementGuard,
        canonicalReceipt,
        intents,
    );
    validateEndpointGuards(
        candidate.endpointGuards,
        canonicalReceipt,
        measurement.purgeAfterEpochMs,
    );
}

function validateAffectedGroups(
    value: unknown,
    expectedGroups: readonly string[],
    intentByGroup: ReadonlyMap<string, RtcRttRecomputeIntentContract>,
): void {
    if (!Array.isArray(value) || value.length !== expectedGroups.length) {
        throw new TypeError('RTC RTT affected group set is incomplete');
    }
    const observed: string[] = [];
    for (const rawGroup of value) {
        validatePersistedGroupSnapshot(rawGroup);
        const group = rawGroup as GroupSnapshot;
        const identity = toCanonicalRtcTopologyGroupIdentity(group.group);
        const intent = intentByGroup.get(identity);
        if (!intent || !rtcTopologySemanticEqual(group, intent.groupSnapshot)) {
            throw new TypeError('RTC RTT affected group differs from recompute intent');
        }
        observed.push(identity);
    }
    if (!rtcTopologySemanticEqual(observed, expectedGroups)) {
        throw new TypeError('RTC RTT affected groups are not canonical');
    }
}

function validateMeasurementGuard(
    value: unknown,
    receipt: RtcRttMutationReceiptContract,
    rawIntents: readonly unknown[],
): Readonly<{ value: RttMeasurementInfo; purgeAfterEpochMs: number }> {
    const guard = record(value, 'RTC RTT measurement guard');
    exactKeys(guard, ['expectedRevision', 'value', 'purgeAfterEpochMs']);
    validateExpectedRevision(guard.expectedRevision, 'measurement');
    validateRtcRttMeasurement(guard.value);
    const measurement = guard.value as RttMeasurementInfo;
    safeInteger(
        guard.purgeAfterEpochMs,
        receipt.acceptedAtEpochMs + 1,
        'measurement purge time',
    );
    if (
        measurement.sessionIdFrom !== receipt.sessionIdFrom ||
        measurement.sessionIdTo !== receipt.sessionIdTo ||
        measurement.version !== receipt.measurementVersion ||
        measurement.createdAtEpochMs > receipt.acceptedAtEpochMs
    ) {
        throw new TypeError('RTC RTT measurement guard differs from receipt');
    }
    for (const rawIntent of rawIntents) {
        const intent = rawIntent as RtcRttRecomputeIntentContract;
        if (!rtcTopologySemanticEqual(measurement, intent.rtt)) {
            throw new TypeError('RTC RTT measurement guard differs from intent');
        }
    }
    return {
        value: measurement,
        purgeAfterEpochMs: guard.purgeAfterEpochMs as number,
    };
}

function validateEndpointGuards(
    value: unknown,
    receipt: RtcRttMutationReceiptContract,
    purgeAfterEpochMs: number,
): void {
    if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError('RTC RTT endpoint guard pair is incomplete');
    }
    const expectedEndpointIds = [receipt.sessionIdFrom, receipt.sessionIdTo]
        .sort(compareRtcTopologyIdentifiers);
    for (let index = 0; index < value.length; index += 1) {
        const guard = record(value[index], 'RTC RTT endpoint guard');
        exactKeys(guard, [
            'endpointId', 'expectedRevision', 'expireAtTimestamp', 'value',
        ]);
        const endpointId = guard.endpointId;
        nonEmptyString(endpointId, 'endpoint guard id');
        if (endpointId !== expectedEndpointIds[index]) {
            throw new TypeError('RTC RTT endpoint guards are not canonical');
        }
        validateExpectedRevision(guard.expectedRevision, 'endpoint');
        safeInteger(
            guard.expireAtTimestamp,
            receipt.acceptedAtEpochMs + 1,
            'endpoint guard expiry',
        );
        validateRtcRttEndpointAdmission(
            guard.value,
            endpointId,
            guard.expireAtTimestamp as number,
        );
        const admission = guard.value as RtcRttEndpointAdmissionContract;
        validateRtcRttEndpointAdmissionCandidateVersion(
            admission.version,
            guard.expectedRevision,
        );
        if (admission.updatedAtEpochMs !== receipt.acceptedAtEpochMs) {
            throw new TypeError('RTC RTT endpoint admission lifecycle is invalid');
        }
        const counterpart = endpointId === receipt.sessionIdFrom
            ? receipt.sessionIdTo
            : receipt.sessionIdFrom;
        const pairLease = admission.peers.find((peer) =>
            peer.peerSessionId === counterpart
        );
        if (!pairLease || pairLease.expiresAtEpochMs < purgeAfterEpochMs) {
            throw new TypeError('RTC RTT endpoint admission is missing pair lease');
        }
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
        (groupExpiry !== null && groupExpiry <= intent.createdAtEpochMs) ||
        !activeSessionIds.has(receipt.sessionIdFrom) ||
        !activeSessionIds.has(receipt.sessionIdTo)
    ) {
        throw new TypeError(
            'RTC RTT recompute intent differs from immutable receipt authority',
        );
    }
}

export function validateRtcRttMeasurement(
    value: unknown,
): asserts value is RttMeasurementInfo {
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

export function validateRtcRttEndpointAdmission(
    value: unknown,
    expectedEndpointId: string,
    physicalExpiry: number,
): asserts value is RtcRttEndpointAdmissionContract {
    const admission = record(value, 'RTC RTT endpoint admission');
    exactKeys(admission, ['endpointId', 'peers', 'version', 'updatedAtEpochMs']);
    if (admission.endpointId !== expectedEndpointId) {
        throw new TypeError('RTC RTT endpoint admission identity is invalid');
    }
    safeInteger(admission.version, 1, 'endpoint admission version');
    safeInteger(admission.updatedAtEpochMs, 0, 'endpoint admission update time');
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
                compareRtcTopologyIdentifiers(
                    previous,
                    peer.peerSessionId,
                ) >= 0)
        ) {
            throw new TypeError('RTC RTT endpoint peers are not canonical');
        }
        previous = peer.peerSessionId;
        latestExpiry = Math.max(latestExpiry, peer.expiresAtEpochMs as number);
    }
    if (physicalExpiry !== latestExpiry) {
        throw new TypeError('RTC RTT endpoint physical expiry differs from leases');
    }
}

export function validateRtcRttEndpointAdmissionCandidateVersion(
    domainVersion: number,
    expectedRevision: number | null,
): void {
    safeInteger(domainVersion, 1, 'endpoint admission version');
    validateExpectedRevision(expectedRevision, 'endpoint');
    const requiredVersion = expectedRevision === null
        ? 1
        : expectedRevision + 2;
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
        throw new TypeError(`RTC RTT ${authority} expected revision is invalid`);
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
