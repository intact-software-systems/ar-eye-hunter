import type { GroupRef } from '@shared/api/group-types.ts';
import { DEFAULT_STATE_WORKSPACE_ID } from '@shared/api/state-types.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateRetryExhaustedError,
    RuntimeStateWriteConflictError,
    waitForRuntimeStateWriteRetry,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
} from '../group-state-storage-keys.ts';
import {
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
} from './RtcTopologyPublicationRepository.ts';
import { RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE } from './RtcTopologySnapshotRepository.ts';
import { hashStateMutationCommand } from './StateMutationOutboxRepository.ts';

export const RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE =
    'rtc-topology:scalar-recompute';

export type RtcTopologyScalarRecomputeRequest = Readonly<{
    kind: 'rtc-topology-scalar-recompute';
    schemaVersion: 1;
    status: 'pending';
    migrationId: string;
    observedAtEpochMs: number;
    commandHash: string;
    groupRef: GroupRef;
    requestId: string;
}>;

export type RtcTopologyScalarRecomputeDisposition =
    | 'enqueued'
    | 'group-absent-terminal';

export type RtcTopologyScalarAuthorityInvalidationResult = Readonly<{
    affectedGroupCount: number;
    deletedSnapshotCount: number;
    deletedPublicationCount: number;
    deletedWorkClaimCount: number;
    queuedRecomputeRequestCount: number;
}>;

export type RtcTopologyScalarRecomputeWorker = Readonly<{
    firstRun: Promise<number>;
    wake(): void;
    stop(): void;
}>;

const FAMILY_NAMESPACES = [
    RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
] as const;
const RETRY_ATTEMPTS: readonly [0, 1, 2] = [0, 1, 2];

type FamilyEntry = Readonly<{
    namespace: string;
    entry: RuntimeStateEntry;
    groupRef: GroupRef;
    legacyScalar: boolean;
    publicationId: string | null;
    workId: string | null;
}>;

export async function invalidateLegacyScalarRtcTopologyAuthority(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    options: Readonly<{
        oldWritersStopped: true;
        migrationId: string;
        observedAtEpochMs: number;
        sleep?: (delayMs: number) => Promise<void>;
    }>,
): Promise<RtcTopologyScalarAuthorityInvalidationResult> {
    validateMigrationOptions(options);
    const family = await readValidatedFamily(runtime, options.observedAtEpochMs);
    const affectedByKey = new Map<string, GroupRef>();
    for (const member of family) {
        if (!member.legacyScalar) continue;
        affectedByKey.set(groupStateGroupStorageKey(member.groupRef), member.groupRef);
    }

    let deletedSnapshotCount = 0;
    let deletedPublicationCount = 0;
    let deletedWorkClaimCount = 0;
    for (const [groupKey, groupRef] of affectedByKey) {
        const counts = await invalidateGroupFamilyWithRetry(
            runtime,
            groupKey,
            groupRef,
            options,
        );
        deletedSnapshotCount += counts.snapshots;
        deletedPublicationCount += counts.publications;
        deletedWorkClaimCount += counts.claims;
    }
    return {
        affectedGroupCount: affectedByKey.size,
        deletedSnapshotCount,
        deletedPublicationCount,
        deletedWorkClaimCount,
        queuedRecomputeRequestCount: affectedByKey.size,
    };
}

export async function drainRtcTopologyScalarRecomputeRequests(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    process: (
        groupRef: GroupRef,
        requestId: string,
    ) => Promise<RtcTopologyScalarRecomputeDisposition>,
): Promise<number> {
    const entries = await runtime.findAllEntries(
        RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
    );
    let drained = 0;
    let firstFailure: unknown;
    for (const entry of entries) {
        try {
            const request = await readRecomputeRequest(entry);
            const disposition = await process(request.groupRef, request.requestId);
            if (
                disposition !== 'enqueued' &&
                disposition !== 'group-absent-terminal'
            ) {
                throw new TypeError('RTC topology scalar recompute disposition is invalid');
            }
            const deleted = await runtime.deleteIfRevision(
                RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
                entry.key,
                entry.revision,
            );
            if (deleted.status === 'applied') drained += 1;
        } catch (error) {
            if (firstFailure === undefined) firstFailure = error;
        }
    }
    if (firstFailure !== undefined) throw firstFailure;
    return drained;
}

export function initRtcTopologyScalarRecomputeWorker(input: Readonly<{
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike;
    process: (
        groupRef: GroupRef,
        requestId: string,
    ) => Promise<RtcTopologyScalarRecomputeDisposition>;
    intervalMs?: number;
    retryDelaysMs?: readonly number[];
    schedule?: (
        callback: () => void | Promise<void>,
        delayMs: number,
    ) => unknown;
    cancel?: (handle: unknown) => void;
    onError?: (error: unknown) => void;
}>): RtcTopologyScalarRecomputeWorker {
    const intervalMs = input.intervalMs ?? 1_000;
    const retryDelaysMs = input.retryDelaysMs ?? [10, 50, 250, 1_000];
    validateWorkerDelays(intervalMs, retryDelaysMs);
    const defaultTimers = new Map<unknown, ReturnType<typeof setTimeout>>();
    const schedule = input.schedule ?? ((callback, delayMs) => {
        const identity = Symbol('rtc-topology-scalar-recompute-timer');
        const timer = setTimeout(() => {
            defaultTimers.delete(identity);
            void callback();
        }, delayMs);
        defaultTimers.set(identity, timer);
        return identity;
    });
    const cancel = input.cancel ?? ((handle) => {
        const timer = defaultTimers.get(handle);
        if (timer === undefined) return;
        clearTimeout(timer);
        defaultTimers.delete(handle);
    });
    let stopped = false;
    let running = false;
    let wakeRequested = false;
    let scheduledHandle: unknown;
    let failureCount = 0;
    let settleFirstRun: ((count: number) => void) | undefined;
    let rejectFirstRun: ((error: unknown) => void) | undefined;
    const firstRun = new Promise<number>((resolve, reject) => {
        settleFirstRun = resolve;
        rejectFirstRun = reject;
    });
    let firstRunSettled = false;

    const cancelScheduled = (): void => {
        if (scheduledHandle === undefined) return;
        cancel(scheduledHandle);
        scheduledHandle = undefined;
    };
    const scheduleRun = (delayMs: number): void => {
        if (stopped) return;
        cancelScheduled();
        let handle: unknown;
        handle = schedule(async () => {
            if (scheduledHandle === handle) scheduledHandle = undefined;
            await run();
        }, delayMs);
        scheduledHandle = handle;
    };
    const run = async (): Promise<void> => {
        if (stopped) return;
        if (running) {
            wakeRequested = true;
            return;
        }
        running = true;
        let failed = false;
        try {
            const count = await drainRtcTopologyScalarRecomputeRequests(
                input.runtime,
                input.process,
            );
            failureCount = 0;
            if (!firstRunSettled) {
                firstRunSettled = true;
                settleFirstRun?.(count);
            }
        } catch (error) {
            failed = true;
            failureCount += 1;
            try {
                input.onError?.(error);
            } catch {
                // Observability cannot own durable delivery lifecycle.
            }
            if (!firstRunSettled) {
                firstRunSettled = true;
                rejectFirstRun?.(error);
            }
        } finally {
            running = false;
            if (stopped) return;
            if (wakeRequested) {
                wakeRequested = false;
                scheduleRun(0);
            } else if (failed) {
                const index = Math.min(failureCount - 1, retryDelaysMs.length - 1);
                scheduleRun(retryDelaysMs[index] ?? intervalMs);
            } else {
                scheduleRun(intervalMs);
            }
        }
    };

    void run();
    return {
        firstRun,
        wake: () => {
            if (stopped) return;
            if (running) {
                wakeRequested = true;
                return;
            }
            scheduleRun(0);
        },
        stop: () => {
            if (stopped) return;
            stopped = true;
            wakeRequested = false;
            cancelScheduled();
        },
    };
}

async function readValidatedFamily(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    observedAtEpochMs: number,
): Promise<readonly FamilyEntry[]> {
    const [snapshots, publications, claims] = await Promise.all([
        runtime.findAllEntries(RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE),
        runtime.findAllEntries(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE),
        runtime.findAllEntries(RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE),
    ]);
    const decoded = [
        ...snapshots.map((entry) => readSnapshotFamilyEntry(entry, observedAtEpochMs)),
        ...publications.map((entry) =>
            readPublicationFamilyEntry(entry, observedAtEpochMs)
        ),
        ...claims.map((entry) => readClaimFamilyEntry(entry, observedAtEpochMs)),
    ];
    validatePublicationClaimBindings(decoded);
    return decoded;
}

async function invalidateGroupFamilyWithRetry(
    runtime: RuntimeStateOptimisticTransactionalRepositoryLike,
    groupKey: string,
    groupRef: GroupRef,
    options: Readonly<{
        migrationId: string;
        observedAtEpochMs: number;
        sleep?: (delayMs: number) => Promise<void>;
    }>,
): Promise<Readonly<{ snapshots: number; publications: number; claims: number }>> {
    let lastConflict: RuntimeStateWriteConflictError | undefined;
    for (const attempt of RETRY_ATTEMPTS) {
        await waitForRuntimeStateWriteRetry(attempt, { sleep: options.sleep });
        try {
            return await runtime.begin(async (transaction) => {
                const request = await newRecomputeRequest(groupRef, options);
                const existingRequest = await transaction.findEntry(
                    RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
                    groupKey,
                );
                if (!existingRequest) {
                    const inserted = await transaction.insertIfAbsent(
                        RTC_TOPOLOGY_SCALAR_RECOMPUTE_NAMESPACE,
                        groupKey,
                        JSON.stringify(request),
                        NEVER_EXPIRE_AT_TIMESTAMP,
                    );
                    if (inserted.status === 'conflict') {
                        throw new RuntimeStateWriteConflictError();
                    }
                } else {
                    const current = await readRecomputeRequest(existingRequest);
                    if (!sameRequestIdentity(current, request)) {
                        throw new TypeError(
                            'RTC topology scalar recompute request conflicts with migration identity',
                        );
                    }
                }

                const counts = { snapshots: 0, publications: 0, claims: 0 };
                const currentFamily = await readValidatedFamily(
                    transaction,
                    options.observedAtEpochMs,
                );
                for (const namespace of FAMILY_NAMESPACES) {
                    for (const member of currentFamily) {
                        if (!sameGroupRef(member.groupRef, groupRef)) continue;
                        if (member.namespace !== namespace) continue;
                        const deleted = await transaction.deleteIfRevision(
                            namespace,
                            member.entry.key,
                            member.entry.revision,
                        );
                        if (deleted.status === 'conflict') {
                            throw new RuntimeStateWriteConflictError();
                        }
                        if (namespace === RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE) {
                            counts.snapshots += 1;
                        } else if (namespace === RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE) {
                            counts.publications += 1;
                        } else {
                            counts.claims += 1;
                        }
                    }
                }
                return counts;
            });
        } catch (error) {
            if (!(error instanceof RuntimeStateWriteConflictError)) throw error;
            lastConflict = error;
        }
    }
    if (lastConflict !== undefined) {
        throw new RuntimeStateRetryExhaustedError(lastConflict);
    }
    throw new RuntimeStateRetryExhaustedError(new RuntimeStateWriteConflictError());
}

async function newRecomputeRequest(
    groupRef: GroupRef,
    options: Readonly<{ migrationId: string; observedAtEpochMs: number }>,
): Promise<RtcTopologyScalarRecomputeRequest> {
    const groupKey = groupStateGroupStorageKey(groupRef);
    const command = {
        kind: 'rtc-topology-scalar-authority-cutover',
        schemaVersion: 1,
        migrationId: options.migrationId,
        observedAtEpochMs: options.observedAtEpochMs,
        groupRef,
        requestId: `scalar-authority-cutover:${groupKey}`,
    };
    return {
        kind: 'rtc-topology-scalar-recompute',
        schemaVersion: 1,
        status: 'pending',
        migrationId: options.migrationId,
        observedAtEpochMs: options.observedAtEpochMs,
        commandHash: await hashStateMutationCommand(command),
        groupRef,
        requestId: `scalar-authority-cutover:${groupKey}`,
    };
}

async function readRecomputeRequest(
    entry: RuntimeStateEntry,
): Promise<RtcTopologyScalarRecomputeRequest> {
    const value = parseRecord(entry);
    exactKeys(value, [
        'kind',
        'schemaVersion',
        'status',
        'migrationId',
        'observedAtEpochMs',
        'commandHash',
        'groupRef',
        'requestId',
    ], 'RTC topology scalar recompute request');
    let keyedRef: GroupRef;
    try {
        keyedRef = decodeGroupStateGroupStorageKey(entry.key);
    } catch {
        throw new TypeError('RTC topology scalar recompute request key is invalid');
    }
    const groupRef = readRequiredGroupRef(value.groupRef, 'recompute request');
    if (!sameGroupRef(groupRef, keyedRef)) {
        throw new TypeError('RTC topology scalar recompute request scope differs from key');
    }
    if (
        value.kind !== 'rtc-topology-scalar-recompute' ||
        value.schemaVersion !== 1 || value.status !== 'pending' ||
        typeof value.migrationId !== 'string' || value.migrationId.length === 0 ||
        !isNonNegativeSafeInteger(value.observedAtEpochMs) ||
        typeof value.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.commandHash) ||
        typeof value.requestId !== 'string' ||
        value.requestId !== `scalar-authority-cutover:${entry.key}` ||
        entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP
    ) {
        throw new TypeError('RTC topology scalar recompute request is invalid');
    }
    const request: RtcTopologyScalarRecomputeRequest = {
        kind: 'rtc-topology-scalar-recompute',
        schemaVersion: 1,
        status: 'pending',
        migrationId: value.migrationId,
        observedAtEpochMs: value.observedAtEpochMs,
        commandHash: value.commandHash,
        groupRef,
        requestId: value.requestId,
    };
    const expected = await newRecomputeRequest(groupRef, request);
    if (request.commandHash !== expected.commandHash) {
        throw new TypeError('RTC topology scalar recompute request command hash is invalid');
    }
    return request;
}

function readSnapshotFamilyEntry(
    entry: RuntimeStateEntry,
    observedAtEpochMs: number,
): FamilyEntry {
    const value = parseRecord(entry);
    const decoded = readLegacyGroupRef(value.groupRef, 'snapshot');
    validateGroupPhysicalKey(entry.key, decoded, null);
    validateLivePhysicalExpiry(entry, observedAtEpochMs, 'snapshot');
    const legacyScalar = isNonNegativeSafeInteger(value.sourceGroupStateRevision);
    if (!legacyScalar && !isCausalRevision(value.sourceGroupStateCausalRevision)) {
        throw new TypeError('RTC topology snapshot source authority is invalid');
    }
    return {
        namespace: RTC_TOPOLOGY_SNAPSHOTS_NAMESPACE,
        entry,
        groupRef: decoded.groupRef,
        legacyScalar,
        publicationId: null,
        workId: null,
    };
}

function readPublicationFamilyEntry(
    entry: RuntimeStateEntry,
    observedAtEpochMs: number,
): FamilyEntry {
    const value = parseRecord(entry);
    const decoded = readLegacyGroupRef(value.groupRef, 'publication');
    const publicationId = nonEmptyString(value.publicationId, 'publication id');
    const workId = nonEmptyString(value.workId, 'publication work id');
    const overlayVersion = nonNegativeInteger(value.overlayVersion, 'overlay version');
    validateGroupPhysicalKey(entry.key, decoded, {
        kind: 'publication',
        value: publicationId,
    });
    validateLivePhysicalExpiry(entry, observedAtEpochMs, 'publication');
    const legacyScalar = isNonNegativeSafeInteger(value.sourceGroupStateRevision);
    const expectedPublicationId = legacyScalar
        ? `${workId}:${value.sourceGroupStateRevision}:${overlayVersion}`
        : publicationIdForCausal(workId, value.sourceGroupStateCausalRevision, overlayVersion);
    if (publicationId !== expectedPublicationId) {
        throw new TypeError('RTC topology publication identity is invalid');
    }
    return {
        namespace: RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        entry,
        groupRef: decoded.groupRef,
        legacyScalar,
        publicationId,
        workId,
    };
}

function readClaimFamilyEntry(
    entry: RuntimeStateEntry,
    observedAtEpochMs: number,
): FamilyEntry {
    const value = parseRecord(entry);
    const legacyKeys = ['groupRef', 'workId', 'publicationId'];
    const currentKeys = [
        'kind',
        'schemaVersion',
        'groupRef',
        'workId',
        'commandId',
        'requestId',
        'commandHash',
        'publicationId',
        'outcome',
        'attemptCount',
        'acceptedCausalRevision',
        'acceptedStorageRevision',
        'eventId',
        'outboxIds',
    ];
    const legacyScalar = sameStringArray(
        Object.keys(value).sort(),
        [...legacyKeys].sort(),
    );
    if (!legacyScalar) {
        exactKeys(value, currentKeys, 'RTC topology work claim');
    }
    const decoded = readLegacyGroupRef(value.groupRef, 'work claim');
    const publicationId = nonEmptyString(value.publicationId, 'claim publication id');
    const workId = nonEmptyString(value.workId, 'claim work id');
    if (!legacyScalar) {
        if (
            value.kind !== 'rtc-topology-execution-receipt' ||
            value.schemaVersion !== 1 || value.outcome !== 'accepted' ||
            value.commandId !== workId || value.requestId !== workId ||
            typeof value.commandHash !== 'string' ||
            !/^sha256:[0-9a-f]{64}$/u.test(value.commandHash) ||
            !Number.isSafeInteger(value.attemptCount) ||
            Number(value.attemptCount) < 1 ||
            !isCausalRevision(value.acceptedCausalRevision) ||
            !isNonNegativeSafeInteger(value.acceptedStorageRevision) ||
            value.eventId !== null || !Array.isArray(value.outboxIds) ||
            value.outboxIds.length !== 1 || value.outboxIds[0] !== publicationId
        ) {
            throw new TypeError('RTC topology work claim receipt is invalid');
        }
    }
    validateGroupPhysicalKey(entry.key, decoded, { kind: 'work', value: workId });
    validateLivePhysicalExpiry(entry, observedAtEpochMs, 'work claim');
    return {
        namespace: RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        entry,
        groupRef: decoded.groupRef,
        legacyScalar,
        publicationId,
        workId,
    };
}

function validatePublicationClaimBindings(family: readonly FamilyEntry[]): void {
    const publications = family.filter((entry) => entry.publicationId !== null &&
        entry.namespace === RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE);
    const claims = family.filter((entry) => entry.publicationId !== null &&
        entry.namespace === RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE);
    for (const publication of publications) {
        const claim = claims.find((candidate) =>
            sameGroupRef(candidate.groupRef, publication.groupRef) &&
            candidate.publicationId === publication.publicationId &&
            candidate.workId === publication.workId
        );
        if (!claim) {
            throw new TypeError('RTC topology publication work claim is missing');
        }
        if (claim.entry.expireAtTimestamp !== publication.entry.expireAtTimestamp) {
            throw new TypeError('RTC topology publication work claim expiry differs');
        }
    }
    for (const claim of claims) {
        if (!publications.some((publication) =>
            sameGroupRef(publication.groupRef, claim.groupRef) &&
            publication.publicationId === claim.publicationId &&
            publication.workId === claim.workId
        )) {
            throw new TypeError('RTC topology work claim publication is missing');
        }
    }
}

function publicationIdForCausal(
    workId: string,
    value: unknown,
    overlayVersion: number,
): string {
    if (!isCausalRevision(value)) {
        throw new TypeError('RTC topology publication causal authority is invalid');
    }
    return `${workId}:${value.groupRevision}:${value.presenceRevision}:${overlayVersion}`;
}

function validateGroupPhysicalKey(
    key: string,
    decoded: Readonly<{ groupRef: GroupRef; legacyGroupKey: string }>,
    child: Readonly<{ kind: 'publication' | 'work'; value: string }> | null,
): void {
    const canonicalGroupKey = groupStateGroupStorageKey(decoded.groupRef);
    const expected = child === null
        ? [canonicalGroupKey, decoded.legacyGroupKey]
        : [
            `${canonicalGroupKey}:${child.kind}=${encodeURIComponent(child.value)}`,
            `${decoded.legacyGroupKey}:${child.kind}=${encodeURIComponent(child.value)}`,
            child.value,
        ];
    if (!expected.includes(key)) {
        throw new TypeError('RTC topology persisted key differs from value scope');
    }
}

function readLegacyGroupRef(
    value: unknown,
    label: string,
): Readonly<{ groupRef: GroupRef; legacyGroupKey: string }> {
    if (!isRecord(value)) throw new TypeError(`RTC topology ${label} groupRef is invalid`);
    const keys = Object.keys(value).sort();
    const expected = Object.hasOwn(value, 'workspaceId')
        ? ['applicationId', 'groupId', 'workspaceId']
        : ['applicationId', 'groupId'];
    if (!sameStringArray(keys, [...expected].sort())) {
        throw new TypeError(`RTC topology ${label} groupRef fields are invalid`);
    }
    const applicationId = nonEmptyString(value.applicationId, `${label} application id`);
    const groupId = nonEmptyString(value.groupId, `${label} group id`);
    const rawWorkspaceId = Object.hasOwn(value, 'workspaceId')
        ? nonEmptyString(value.workspaceId, `${label} workspace id`)
        : undefined;
    const workspaceId = rawWorkspaceId === undefined
        ? DEFAULT_STATE_WORKSPACE_ID
        : rawWorkspaceId;
    return {
        groupRef: { applicationId, workspaceId, groupId },
        legacyGroupKey: [
            `app=${encodeURIComponent(applicationId)}`,
            `ws=${rawWorkspaceId === undefined ? '_' : encodeURIComponent(rawWorkspaceId)}`,
            `group=${encodeURIComponent(groupId)}`,
        ].join(':'),
    };
}

function readRequiredGroupRef(value: unknown, label: string): GroupRef {
    if (!isRecord(value)) throw new TypeError(`RTC topology ${label} groupRef is invalid`);
    exactKeys(value, ['applicationId', 'workspaceId', 'groupId'],
        `RTC topology ${label} groupRef`);
    return {
        applicationId: nonEmptyString(value.applicationId, `${label} application id`),
        workspaceId: nonEmptyString(value.workspaceId, `${label} workspace id`),
        groupId: nonEmptyString(value.groupId, `${label} group id`),
    };
}

function validateMigrationOptions(options: Readonly<{
    oldWritersStopped: true;
    migrationId: string;
    observedAtEpochMs: number;
}>): void {
    if (options.oldWritersStopped !== true) {
        throw new Error('RTC topology scalar authority invalidation requires old writers stopped');
    }
    if (typeof options.migrationId !== 'string' || options.migrationId.length === 0) {
        throw new TypeError('RTC topology scalar authority migration id is invalid');
    }
    if (!isNonNegativeSafeInteger(options.observedAtEpochMs)) {
        throw new TypeError('RTC topology scalar authority observation time is invalid');
    }
}

function validateWorkerDelays(
    intervalMs: number,
    retryDelaysMs: readonly number[],
): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
        throw new RangeError('RTC topology scalar recompute interval is invalid');
    }
    if (
        retryDelaysMs.length === 0 ||
        retryDelaysMs.some((delayMs) => !Number.isSafeInteger(delayMs) || delayMs < 0)
    ) {
        throw new RangeError('RTC topology scalar recompute retry schedule is invalid');
    }
}

function validateLivePhysicalExpiry(
    entry: RuntimeStateEntry,
    observedAtEpochMs: number,
    label: string,
): void {
    if (
        entry.expireAtTimestamp !== NEVER_EXPIRE_AT_TIMESTAMP &&
        entry.expireAtTimestamp <= observedAtEpochMs
    ) {
        throw new TypeError(`RTC topology ${label} expired before migration observation`);
    }
}

function exactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
    label: string,
): void {
    if (!sameStringArray(Object.keys(value).sort(), [...expected].sort())) {
        throw new TypeError(`${label} fields are invalid`);
    }
}

function parseRecord(entry: RuntimeStateEntry): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(entry.value);
    } catch {
        throw new TypeError(`RTC topology persisted JSON is invalid: ${entry.key}`);
    }
    if (!isRecord(value)) {
        throw new TypeError(`RTC topology persisted value is invalid: ${entry.key}`);
    }
    return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function nonNegativeInteger(value: unknown, label: string): number {
    if (!isNonNegativeSafeInteger(value)) throw new TypeError(`RTC topology ${label} is invalid`);
    return value;
}

function nonEmptyString(value: unknown, label: string): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`RTC topology ${label} is invalid`);
    }
    return value;
}

function isCausalRevision(value: unknown): value is Readonly<{
    groupRevision: number;
    presenceRevision: number;
}> {
    return isRecord(value) &&
        sameStringArray(Object.keys(value).sort(), ['groupRevision', 'presenceRevision']) &&
        isNonNegativeSafeInteger(value.groupRevision) &&
        isNonNegativeSafeInteger(value.presenceRevision);
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length &&
        left.every((value, index) => value === right[index]);
}

function sameRequestIdentity(
    left: RtcTopologyScalarRecomputeRequest,
    right: RtcTopologyScalarRecomputeRequest,
): boolean {
    return left.kind === right.kind && left.schemaVersion === right.schemaVersion &&
        left.status === right.status && left.migrationId === right.migrationId &&
        left.observedAtEpochMs === right.observedAtEpochMs &&
        left.commandHash === right.commandHash && left.requestId === right.requestId &&
        sameGroupRef(left.groupRef, right.groupRef);
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}
