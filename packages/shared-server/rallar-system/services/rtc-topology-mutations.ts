import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    RtcRttRepository,
    DEFAULT_RTC_RTT_MUTATION_RETENTION_MS,
    toRtcRttMutationReceiptId,
    toRtcRttRecomputeOutboxId,
} from '../repositories/RtcRttRepository.ts';
import { hashStateMutationCommand } from '../repositories/StateMutationOutboxRepository.ts';
import { compareRtcTopologyIdentifiers } from '../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../repositories/RtcTopologyPublicationRepository.ts';
import {
    compareTopologyTuple,
    decideTopologySnapshot,
    RtcTopologyRepositoryInvariantCorruptionError,
    validateTopologySnapshot,
} from '../repositories/RtcTopologySnapshotRepository.ts';
import {
    evaluateRtcRttMeasurement,
    type RtcRttAcceptanceReason,
} from './rtc-rtt-measurement-policy.ts';
import { recordRallarTiming, type RallarTimingSink } from './timing.ts';

export type RtcTopologyPublicationClaim = Readonly<{
    publication: RtcTopologyPublication;
}>;

export type RtcTopologyMutationRead = Readonly<{
    snapshot: RuntimeStateEntryValue<RallarOverlayTopologySnapshot> | null;
    publicationClaim: RtcTopologyPublicationClaim | null;
}>;

export type RtcTopologyMutationInput = Readonly<{
    read: RtcTopologyMutationRead;
    candidate: RallarOverlayTopologySnapshot;
    publication: RtcTopologyPublication | null;
    facts: RtcTopologyMutationFacts;
}>;

export type RtcTopologyMutationFacts = Readonly<{
    publicationExpireAtTimestamp: number | null;
}>;

export type RtcTopologyMutationComputed =
    | Readonly<{
        outcome: 'loaded';
        snapshot: RallarOverlayTopologySnapshot;
        publication: RtcTopologyPublication;
    }>
    | Readonly<{
        outcome: 'retry';
        reason: 'publication-ahead-of-snapshot';
    }>
    | Readonly<{
        outcome: 'superseded';
        current: RallarOverlayTopologySnapshot;
    }>
    | (
        Readonly<{
            outcome: 'write';
            observation: 'inserted' | 'advanced' | 'duplicate';
            snapshotGuard: Readonly<{
                expectedRevision: number | null;
                candidate: RallarOverlayTopologySnapshot;
            }>;
        }> & (
            | Readonly<{
                publication: RtcTopologyPublication;
                publicationExpireAtTimestamp: number;
            }>
            | Readonly<{
                publication: null;
                publicationExpireAtTimestamp: null;
            }>
        )
    );

export function computeTopologyMutation(
    input: RtcTopologyMutationInput,
): RtcTopologyMutationComputed {
    if (input.read.publicationClaim) {
        if (!input.read.snapshot) {
            throw new TypeError(
                'RTC topology publication claim has no durable snapshot',
            );
        }
        const storedPublication = input.read.publicationClaim.publication;
        const storedSnapshot = input.read.snapshot.value;
        const publicationSnapshot = assertPublicationSelfConsistent(storedPublication);
        const relation = compareTopologyTuple(publicationSnapshot, storedSnapshot);
        if (relation > 0) {
            return {
                outcome: 'retry',
                reason: 'publication-ahead-of-snapshot',
            };
        }
        if (
            relation === 0 &&
            !canonicalDeepEqual(publicationSnapshot, storedSnapshot)
        ) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                storedPublication.publicationId,
                'RTC topology publication equal causal tuple differs from durable snapshot',
            );
        }
        return {
            outcome: 'loaded',
            snapshot: storedSnapshot,
            publication: storedPublication,
        };
    }

    const current = input.read.snapshot?.value;
    const observation = decideTopologySnapshot(current, input.candidate);
    if (observation === 'stale') {
        return { outcome: 'superseded', current: current! };
    }
    validatePublicationExpiryFact(input.publication, input.facts);
    const write = {
        outcome: 'write',
        observation,
        snapshotGuard: {
            expectedRevision: input.read.snapshot?.entry.revision ?? null,
            candidate: input.candidate,
        },
    } as const;
    if (input.publication === null) {
        return {
            ...write,
            publication: null,
            publicationExpireAtTimestamp: null,
        };
    }
    const publicationExpireAtTimestamp =
        input.facts.publicationExpireAtTimestamp;
    if (publicationExpireAtTimestamp === null) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
    return {
        ...write,
        publication: input.publication,
        publicationExpireAtTimestamp,
    };
}

function assertPublicationSelfConsistent(
    publication: RtcTopologyPublication,
): RallarOverlayTopologySnapshot {
    let payload: unknown;
    try {
        payload = JSON.parse(publication.message.payload.resource);
    } catch {
        throw new TypeError('RTC topology publication payload snapshot is invalid');
    }
    validateTopologySnapshot(payload, publication.groupRef);
    const snapshot = payload;
    if (
        !snapshot.groupRef ||
        !sameGroupRef(publication.groupRef, snapshot.groupRef) ||
        publication.sourceGroupStateRevision !== snapshot.sourceGroupStateRevision ||
        publication.overlayVersion !== snapshot.version ||
        !jsonEquals(publication.recipientSessionIds, snapshot.activeSessionIds)
    ) {
        throw new TypeError('RTC topology publication winner is internally inconsistent');
    }
    return snapshot;
}

export function validateTopologyMutation(
    input: RtcTopologyMutationInput & Readonly<{
        computed: RtcTopologyMutationComputed;
    }>,
): void {
    const recomputed = computeTopologyMutation(input);
    if (!jsonEquals(recomputed, input.computed)) {
        throw new TypeError('RTC topology mutation differs from canonical computation');
    }
    if (
        input.publication &&
        (!sameGroupRef(input.publication.groupRef, input.candidate.groupRef) ||
            input.publication.sourceGroupStateRevision !==
                input.candidate.sourceGroupStateRevision ||
            input.publication.overlayVersion !== input.candidate.version)
    ) {
        throw new TypeError('RTC topology publication differs from candidate identity');
    }
    if (input.publication && input.computed.outcome === 'write') {
        const publicationSnapshot = assertPublicationSelfConsistent(input.publication);
        if (!canonicalDeepEqual(publicationSnapshot, input.candidate)) {
            throw new TypeError('RTC topology publication payload differs from candidate');
        }
    }
}

export type RtcRttEndpointAdmission = Readonly<{
    endpointId: string;
    peers: readonly Readonly<{
        peerSessionId: string;
        expiresAtEpochMs: number;
    }>[];
    version: number;
    updatedAtEpochMs: number;
}>;

export type RtcRttMutationCommand = Readonly<{
    rtt: RttMeasurementInfo;
    alSenderId: string;
    candidateGroups: readonly GroupSnapshot[];
    overlaySnapshotsByGroupKey: ReadonlyMap<string, RallarOverlayTopologySnapshot>;
    degreeLimit: number;
}>;

export type RtcRttMutationRead =
    | Readonly<{
        receipt: RuntimeStateEntryValue<RtcRttMutationReceipt>;
    }>
    | Readonly<{
        receipt: null;
        measurement: RuntimeStateEntryValue<RttMeasurementInfo> | null;
        endpointAdmissions: readonly RuntimeStateEntryValue<RtcRttEndpointAdmission>[];
        measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[];
    }>;

export type RtcRttMutationFacts = Readonly<{
    purgeAfterEpochMs: number;
    requestedAtEpochMs: number;
    commandHash: string;
}>;

export type RtcRttMutationLifecycleFacts = Readonly<{
    purgeAfterEpochMs: number;
    requestedAtEpochMs: number;
}>;

export type RtcRttEndpointGuard = Readonly<{
    endpointId: string;
    expectedRevision: number | null;
    expireAtTimestamp: number;
    value: RtcRttEndpointAdmission;
}>;

export type RtcRttMutationComputed =
    | Readonly<{
        outcome: 'replay';
        reason: 'accepted';
        affectedGroups: readonly GroupSnapshot[];
        receipt: RtcRttMutationReceipt;
    }>
    | Readonly<{
        outcome: 'rejected';
        reason: RtcRttAcceptanceReason | 'stale';
        affectedGroups: readonly GroupSnapshot[];
    }>
    | Readonly<{
        outcome: 'write';
        reason: 'accepted';
        affectedGroups: readonly GroupSnapshot[];
        endpointGuards: readonly RtcRttEndpointGuard[];
        measurementGuard: Readonly<{
            expectedRevision: number | null;
            value: RttMeasurementInfo;
            purgeAfterEpochMs: number;
        }>;
        receipt: RtcRttMutationReceipt;
        recomputeIntents: readonly RtcRttRecomputeIntent[];
    }>;

export type RtcRttMutationReceipt = Readonly<{
    receiptId: string;
    sessionIdFrom: string;
    sessionIdTo: string;
    measurementVersion: number;
    affectedGroupRefs: readonly GroupRef[];
    acceptedAtEpochMs: number;
    outcome: 'accepted';
    commandHash: string;
}>;

export type RtcRttRecomputeIntent = Readonly<{
    outboxId: string;
    receiptId: string;
    groupSnapshot: GroupSnapshot;
    rtt: RttMeasurementInfo;
    createdAtEpochMs: number;
    commandHash: string;
}>;

export class RtcRttMutationIdempotencyConflictError extends Error {
    readonly status = 409;
    readonly code = 'rtc-rtt-idempotency-conflict';

    constructor(readonly receiptId: string) {
        super(`RTC RTT receipt ${receiptId} was already claimed by another command`);
        this.name = 'RtcRttMutationIdempotencyConflictError';
    }
}

export function computeRttMutation(input: Readonly<{
    command: RtcRttMutationCommand;
    read: RtcRttMutationRead;
    facts: RtcRttMutationFacts;
}>): RtcRttMutationComputed {
    validateRttMutationFacts(input.facts);
    if (input.read.receipt) {
        if (input.read.receipt.value.commandHash !== input.facts.commandHash) {
            throw new RtcRttMutationIdempotencyConflictError(
                input.read.receipt.value.receiptId,
            );
        }
        return {
            outcome: 'replay',
            reason: 'accepted',
            affectedGroups: [],
            receipt: input.read.receipt.value,
        };
    }
    const authorityRead = input.read as Extract<
        RtcRttMutationRead,
        { receipt: null }
    >;
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version > input.command.rtt.version
    ) {
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: [],
        };
    }
    if (
        authorityRead.measurement &&
        authorityRead.measurement.value.version === input.command.rtt.version
    ) {
        if (!sameMeasurement(authorityRead.measurement.value, input.command.rtt)) {
            throw new RtcTopologyRepositoryInvariantCorruptionError(
                authorityRead.measurement.entry.key,
                'RTC RTT equal version differs from durable measurement',
            );
        }
        return {
            outcome: 'rejected',
            reason: 'stale',
            affectedGroups: [],
        };
    }

    const acceptance = evaluateRtcRttMeasurement({
        ...input.command,
        existingMeasurements: authorityRead.measurements.map(({ value }) => value),
    });
    if (!acceptance.accepted) {
        return {
            outcome: 'rejected',
            reason: acceptance.reason,
            affectedGroups: acceptance.affectedGroups,
        };
    }

    const admissionByEndpoint = new Map(
        authorityRead.endpointAdmissions.map((stored) => [stored.value.endpointId, stored]),
    );
    if (exceedsEndpointAdmissionDegree(
        input.command.rtt,
        admissionByEndpoint,
        input.command.degreeLimit,
        input.facts.requestedAtEpochMs,
    )) {
        return {
            outcome: 'rejected',
            reason: 'over-degree',
            affectedGroups: acceptance.affectedGroups,
        };
    }

    const endpoints = [...new Set([
        input.command.rtt.sessionIdFrom,
        input.command.rtt.sessionIdTo,
    ])].sort(compareRtcTopologyIdentifiers);
    const endpointGuards = endpoints.map((endpointId) => {
        const stored = admissionByEndpoint.get(endpointId);
        const peerExpiry = new Map<string, number>();
        for (const peer of stored?.value.peers ?? []) {
            if (peer.expiresAtEpochMs > input.facts.requestedAtEpochMs) {
                peerExpiry.set(peer.peerSessionId, peer.expiresAtEpochMs);
            }
        }
        for (const peer of peersForEndpoint(endpointId, authorityRead.measurements)) {
            peerExpiry.set(
                peer.peerSessionId,
                Math.max(peerExpiry.get(peer.peerSessionId) ?? 0, peer.expiresAtEpochMs),
            );
        }
        const incomingPeer = endpointId === input.command.rtt.sessionIdFrom
            ? input.command.rtt.sessionIdTo
            : input.command.rtt.sessionIdFrom;
        peerExpiry.set(
            incomingPeer,
            Math.max(
                peerExpiry.get(incomingPeer) ?? 0,
                input.facts.purgeAfterEpochMs,
            ),
        );
        const peers = [...peerExpiry].map(([peerSessionId, expiresAtEpochMs]) => ({
            peerSessionId,
            expiresAtEpochMs,
        })).sort((left, right) =>
            compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId)
        );
        return {
            endpointId,
            expectedRevision: stored?.entry.revision ?? null,
            expireAtTimestamp: Math.max(...peers.map((peer) => peer.expiresAtEpochMs)),
            value: {
                endpointId,
                peers,
                version: (stored?.value.version ?? 0) + 1,
                updatedAtEpochMs: input.facts.requestedAtEpochMs,
            },
        };
    });
    const receiptId = toRtcRttMutationReceiptId(input.command.rtt);
    const affectedGroupRefs = acceptance.affectedGroups.map((group) =>
        canonicalGroupRef(group.group)
    );
    return {
        outcome: 'write',
        reason: 'accepted',
        affectedGroups: acceptance.affectedGroups,
        endpointGuards,
        measurementGuard: {
            expectedRevision: authorityRead.measurement?.entry.revision ?? null,
            value: input.command.rtt,
            purgeAfterEpochMs: input.facts.purgeAfterEpochMs,
        },
        receipt: {
            receiptId,
            sessionIdFrom: input.command.rtt.sessionIdFrom,
            sessionIdTo: input.command.rtt.sessionIdTo,
            measurementVersion: input.command.rtt.version,
            affectedGroupRefs,
            acceptedAtEpochMs: input.facts.requestedAtEpochMs,
            outcome: 'accepted',
            commandHash: input.facts.commandHash,
        },
        recomputeIntents: acceptance.affectedGroups.map((group) => ({
            outboxId: toRtcRttRecomputeOutboxId(
                receiptId,
                group.group,
                input.facts.commandHash,
            ),
            receiptId,
            groupSnapshot: group,
            rtt: input.command.rtt,
            createdAtEpochMs: input.facts.requestedAtEpochMs,
            commandHash: input.facts.commandHash,
        })),
    };
}

function exceedsEndpointAdmissionDegree(
    rtt: RttMeasurementInfo,
    admissions: ReadonlyMap<
        string,
        RuntimeStateEntryValue<RtcRttEndpointAdmission>
    >,
    degreeLimit: number,
    requestedAtEpochMs: number,
): boolean {
    for (const [endpointId, incomingPeerId] of [
        [rtt.sessionIdFrom, rtt.sessionIdTo],
        [rtt.sessionIdTo, rtt.sessionIdFrom],
    ] as const) {
        const peers = new Set(
            (admissions.get(endpointId)?.value.peers ?? [])
                .filter((peer) => peer.expiresAtEpochMs > requestedAtEpochMs)
                .map((peer) => peer.peerSessionId),
        );
        if (!peers.has(incomingPeerId) && peers.size >= degreeLimit) return true;
    }
    return false;
}

export function validateRttMutation(input: Readonly<{
    command: RtcRttMutationCommand;
    read: RtcRttMutationRead;
    facts: RtcRttMutationFacts;
    computed: RtcRttMutationComputed;
}>): void {
    const recomputed = computeRttMutation(input);
    if (!jsonEquals(recomputed, input.computed)) {
        throw new TypeError('RTC RTT mutation differs from canonical computation');
    }
    if (input.computed.outcome === 'write') {
        const endpointIds = input.computed.endpointGuards.map((guard) => guard.endpointId);
        if (
            JSON.stringify(endpointIds) !==
                JSON.stringify([...endpointIds].sort(compareRtcTopologyIdentifiers))
        ) {
            throw new TypeError('RTC RTT endpoint guards are not in lexical order');
        }
    }
}

export function validateRttMutationFacts(facts: RtcRttMutationFacts): void {
    if (
        !Number.isSafeInteger(facts.requestedAtEpochMs) ||
        facts.requestedAtEpochMs < 0
    ) {
        throw new TypeError('RTC RTT requested-at lifecycle fact is invalid');
    }
    if (
        !Number.isSafeInteger(facts.purgeAfterEpochMs) ||
        facts.purgeAfterEpochMs <= facts.requestedAtEpochMs
    ) {
        throw new TypeError('RTC RTT purge-after lifecycle fact is invalid');
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(facts.commandHash)) {
        throw new TypeError('RTC RTT command hash fact is invalid');
    }
}

export async function readRttMutation(
    repository: RtcRttRepository,
    command: RtcRttMutationCommand,
): Promise<RtcRttMutationRead> {
    const receipt = await repository.findMutationReceiptEntry(
        toRtcRttMutationReceiptId(command.rtt),
    );
    if (receipt) return { receipt };

    const [measurement, measurements, ...endpointAdmissions] = await Promise.all([
        repository.findMeasurementEntry(
            command.rtt.sessionIdFrom,
            command.rtt.sessionIdTo,
        ),
        repository.listMeasurementEntries(),
        ...[...new Set([
            command.rtt.sessionIdFrom,
            command.rtt.sessionIdTo,
        ])].sort(compareRtcTopologyIdentifiers).map((endpointId) =>
            repository.findEndpointAdmissionEntry(endpointId)
        ),
    ]);
    return {
        receipt: null,
        measurement: measurement ?? null,
        endpointAdmissions: endpointAdmissions.filter((entry): entry is
            NonNullable<typeof entry> => entry !== undefined),
        measurements,
    };
}

export async function writeRttMutation(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    options: ConstructorParameters<typeof RtcRttRepository>[1],
    computed: Extract<RtcRttMutationComputed, { outcome: 'write' }>,
): Promise<'accepted' | 'conflict'> {
    try {
        const accepted = await runtime.begin(async (transaction) => {
            const repository = new RtcRttRepository(transaction, options);
            for (let index = 0; index < computed.endpointGuards.length; index += 1) {
                const guard = computed.endpointGuards[index]!;
                const written = await repository.commitEndpointAdmission(
                    guard.value,
                    guard.expectedRevision,
                    guard.expireAtTimestamp,
                );
                if (written.status === 'conflict') {
                    if (index === 0) return false;
                    throw new RuntimeStateWriteConflictError();
                }
            }
            const measurement = await repository.commitMeasurement(
                computed.measurementGuard.value,
                computed.measurementGuard.expectedRevision,
                computed.measurementGuard.purgeAfterEpochMs,
            );
            if (measurement.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            const mutationExpireAtTimestamp = computed.receipt.acceptedAtEpochMs +
                DEFAULT_RTC_RTT_MUTATION_RETENTION_MS;
            const receipt = await repository.insertMutationReceipt(
                computed.receipt,
                mutationExpireAtTimestamp,
            );
            if (receipt.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            for (const intent of computed.recomputeIntents) {
                const inserted = await repository.insertRecomputeIntent(
                    intent,
                    mutationExpireAtTimestamp,
                );
                if (inserted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
            return true;
        });
        return accepted ? 'accepted' : 'conflict';
    } catch (error) {
        if (error instanceof RuntimeStateWriteConflictError) return 'conflict';
        throw error;
    }
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return ref.workspaceId === undefined
        ? { applicationId: ref.applicationId, groupId: ref.groupId }
        : {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
        };
}

export type ExecuteRttMutationResult = Readonly<{
    computed: RtcRttMutationComputed;
    updated: boolean;
}>;

export async function executeRttMutation(input: Readonly<{
    repository: RtcRttRepository;
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike;
    command: RtcRttMutationCommand;
    readCommand?: () => RtcRttMutationCommand | Promise<RtcRttMutationCommand>;
    readFacts: () => RtcRttMutationLifecycleFacts | Promise<RtcRttMutationLifecycleFacts>;
    sleep?: (delayMs: number) => Promise<void>;
    timing?: RallarTimingSink;
    serviceId?: string;
}>): Promise<ExecuteRttMutationResult> {
    const commandHash = await hashStateMutationCommand({
        rtt: input.command.rtt,
        alSenderId: input.command.alSenderId,
    });
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const backoffMs = await waitForRuntimeStateWriteRetry(attempt as 0 | 1 | 2, {
            sleep: input.sleep,
        });
        const readStarted = performance.now();
        const facts: RtcRttMutationFacts = {
            ...await input.readFacts(),
            commandHash,
        };
        validateRttMutationFacts(facts);
        const command = await input.readCommand?.() ?? input.command;
        if (!sameRttRequest(command, input.command)) {
            throw new TypeError('RTC RTT retry changed the stable request payload');
        }
        const read = await readRttMutation(input.repository, command);
        recordRttPhase(input, 'read', readStarted, attempt, backoffMs);

        const computeStarted = performance.now();
        const computed = computeRttMutation({
            command,
            read,
            facts,
        });
        recordRttPhase(input, 'compute', computeStarted, attempt, backoffMs);

        const validateStarted = performance.now();
        validateRttMutation({
            command,
            read,
            facts,
            computed,
        });
        recordRttPhase(input, 'validate', validateStarted, attempt, backoffMs);
        if (computed.outcome === 'rejected' || computed.outcome === 'replay') {
            return { computed, updated: false };
        }

        const writeStarted = performance.now();
        const transactionStarted = performance.now();
        const written = await writeRttMutation(
            input.runtime,
            {
                ttlMs: facts.purgeAfterEpochMs - facts.requestedAtEpochMs,
                now: () => facts.requestedAtEpochMs,
            },
            computed,
        );
        recordRttPhase(
            input,
            'transaction',
            transactionStarted,
            attempt,
            backoffMs,
        );
        recordRttPhase(input, 'write', writeStarted, attempt, backoffMs);
        if (written === 'accepted') return { computed, updated: true };

        lastConflict = new RuntimeStateWriteConflictError();
        recordRallarTiming(input.timing, {
            component: 'rtc-rtt-service',
            operation: 'mutation.conflict',
            serviceId: input.serviceId,
            requestId: `${input.command.rtt.sessionIdFrom}:${input.command.rtt.sessionIdTo}:${input.command.rtt.version}`,
            details: { attempt, backoffMs, conflict: true },
        }, 'error', 0, lastConflict);
    }
    throw new RuntimeStateRetryExhaustedError(
        lastConflict ?? new RuntimeStateWriteConflictError(),
    );
}

function sameRttRequest(
    left: RtcRttMutationCommand,
    right: RtcRttMutationCommand,
): boolean {
    return jsonEquals(left.rtt, right.rtt) && left.alSenderId === right.alSenderId;
}

function recordRttPhase(
    input: Pick<Parameters<typeof executeRttMutation>[0], 'timing' | 'serviceId' | 'command'>,
    phase: 'read' | 'compute' | 'validate' | 'transaction' | 'write',
    started: number,
    attempt: number,
    backoffMs: number,
): void {
    recordRallarTiming(input.timing, {
        component: 'rtc-rtt-service',
        operation: `mutation.${phase}`,
        serviceId: input.serviceId,
        requestId: `${input.command.rtt.sessionIdFrom}:${input.command.rtt.sessionIdTo}:${input.command.rtt.version}`,
        details: { attempt, backoffMs },
    }, 'ok', performance.now() - started);
}

function peersForEndpoint(
    endpointId: string,
    measurements: readonly RuntimeStateEntryValue<RttMeasurementInfo>[],
): readonly Readonly<{ peerSessionId: string; expiresAtEpochMs: number }>[] {
    const peers = new Map<string, number>();
    for (const measurement of measurements) {
        const peerSessionId = measurement.value.sessionIdFrom === endpointId
            ? measurement.value.sessionIdTo
            : measurement.value.sessionIdTo === endpointId
            ? measurement.value.sessionIdFrom
            : undefined;
        if (peerSessionId) {
            peers.set(
                peerSessionId,
                Math.max(
                    peers.get(peerSessionId) ?? 0,
                    measurement.entry.expireAtTimestamp,
                ),
            );
        }
    }
    return [...peers].map(([peerSessionId, expiresAtEpochMs]) => ({
        peerSessionId,
        expiresAtEpochMs,
    })).sort((left, right) =>
        compareRtcTopologyIdentifiers(left.peerSessionId, right.peerSessionId)
    );
}

function sameGroupRef(
    left: RtcTopologyPublication['groupRef'],
    right: RtcTopologyPublication['groupRef'],
): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function jsonEquals(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalDeepEqual(left: unknown, right: unknown): boolean {
    if (Object.is(left, right)) return true;
    if (Array.isArray(left) || Array.isArray(right)) {
        return Array.isArray(left) && Array.isArray(right) &&
            left.length === right.length &&
            left.every((value, index) => canonicalDeepEqual(value, right[index]));
    }
    if (isPlainRecord(left) || isPlainRecord(right)) {
        if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
        const leftKeys = Object.keys(left).sort(compareRtcTopologyIdentifiers);
        const rightKeys = Object.keys(right).sort(compareRtcTopologyIdentifiers);
        return leftKeys.length === rightKeys.length &&
            leftKeys.every((key, index) =>
                key === rightKeys[index] &&
                canonicalDeepEqual(left[key], right[key])
            );
    }
    return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function sameMeasurement(
    left: RttMeasurementInfo,
    right: RttMeasurementInfo,
): boolean {
    return left.sessionIdFrom === right.sessionIdFrom &&
        left.sessionIdTo === right.sessionIdTo &&
        left.rttMs === right.rttMs &&
        left.createdAtEpochMs === right.createdAtEpochMs &&
        left.version === right.version;
}

function validatePublicationExpiryFact(
    publication: RtcTopologyPublication | null,
    facts: RtcTopologyMutationFacts,
): void {
    const expiresAt = facts.publicationExpireAtTimestamp;
    if (publication === null) {
        if (expiresAt !== null) {
            throw new TypeError(
                'RTC topology publication expiry must be null without publication',
            );
        }
        return;
    }
    if (
        expiresAt === null || !Number.isSafeInteger(expiresAt) ||
        expiresAt <= publication.createdAtEpochMs
    ) {
        throw new TypeError('RTC topology publication expiry fact is invalid');
    }
}
