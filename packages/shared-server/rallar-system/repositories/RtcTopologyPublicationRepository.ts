import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    RuntimeStateWriteConflictError,
} from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
} from '../group-state-storage-keys.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../rtc-topology-errors.ts';
import {
    toRtcTopologyPublicationId,
    toRtcTopologyPublicationMessageId,
} from '../rtc-topology-identifiers.ts';
import type { RtcTopologyPublication } from '../rtc-topology-publication-contract.ts';
import { validateTopologySnapshot } from '../rtc-topology-snapshot-contract.ts';
import { rtcTopologySemanticEqual } from '../rtc-topology-semantic-equality.ts';
import { validatePersistedALMessage } from '../services/al-message-persistence-validation.ts';
import { validateRtcTopologyPublication } from '../rtc-topology-publication-validation.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../topology/replay/rtc-topology-replay-policy.ts';
import { hashMutationCommand, type JsonWireValue } from '../services/mutation-command-identity.ts';
import { RtcTopologySnapshotRepository } from './RtcTopologySnapshotRepository.ts';

export type { RtcTopologyPublication } from '../rtc-topology-publication-contract.ts';
export { toRtcTopologyPublicationId } from '../rtc-topology-identifiers.ts';

export const RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE = 'rtc-topology:publications';
export const RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE =
    'rtc-topology:publication-work-index';
export const DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS =
    RTC_TOPOLOGY_REPLAY_RETENTION_MS;

export type RtcTopologyPublicationWorkClaim = Readonly<{
    kind: 'rtc-topology-execution-receipt';
    schemaVersion: 1;
    groupRef: GroupRef;
    workId: string;
    commandId: string;
    requestId: string;
    commandHash: string;
    publicationId: string;
    outcome: 'accepted';
    attemptCount: number;
    acceptedCausalRevision: GroupStateCausalRevision;
    acceptedStorageRevision: number;
    eventId: null;
    outboxIds: readonly string[];
}>;

export type RtcTopologyExecutionReceiptFacts = Readonly<{
    commandHash: string;
    attemptCount: number;
    acceptedStorageRevision: number;
}>;

export type RtcTopologyClaimedPublication = Readonly<{
    claim: RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>;
    publication: RtcTopologyPublication;
}>;

export async function hashRtcTopologyExecutionCommand(
    publication: RtcTopologyPublication,
): Promise<string> {
    validateRtcTopologyPublication(publication, publication.groupRef);
    return await hashMutationCommand({
        kind: 'rtc-topology-execution',
        schemaVersion: 1,
        publication,
    } as unknown as JsonWireValue);
}

export function createRtcTopologyExecutionReceipt(
    publication: RtcTopologyPublication,
    facts: RtcTopologyExecutionReceiptFacts,
): RtcTopologyPublicationWorkClaim {
    const receipt: RtcTopologyPublicationWorkClaim = {
        kind: 'rtc-topology-execution-receipt',
        schemaVersion: 1,
        groupRef: publication.groupRef,
        workId: publication.workId,
        commandId: publication.workId,
        requestId: publication.workId,
        commandHash: facts.commandHash,
        publicationId: publication.publicationId,
        outcome: 'accepted',
        attemptCount: facts.attemptCount,
        acceptedCausalRevision: publication.sourceGroupStateCausalRevision,
        acceptedStorageRevision: facts.acceptedStorageRevision,
        eventId: null,
        outboxIds: [publication.publicationId],
    };
    validateWorkClaim(receipt, publication.groupRef);
    return receipt;
}

export type PutRtcTopologyPublicationResult = Readonly<{
    publication: RtcTopologyPublication;
    inserted: boolean;
}>;

export class RtcTopologyPublicationCollisionError extends Error {
    readonly code = 'rtc-topology-publication-collision';
    readonly status = 409;

    constructor(readonly storageKey: string) {
        super(`RTC topology immutable publication collision: ${storageKey}`);
        this.name = 'RtcTopologyPublicationCollisionError';
    }
}

export async function migrateLegacyRtcTopologyPublicationKeys(
    repository: RtcTopologyPublicationRepository,
    options: Readonly<{
        oldWritersStopped: true;
    }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error('RTC topology publication migration requires old writers stopped');
    }
    const runtime = requireOptimisticRuntime(repository.runtimeRepository);
    const publications = await runtime.findAllEntries(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    );
    for (const sourcePublication of publications) {
        const publication = readPublicationForMigration(sourcePublication);
        const migrationClaim = createRtcTopologyExecutionReceipt(publication, {
            commandHash: await hashRtcTopologyExecutionCommand(publication),
            attemptCount: 1,
            // Legacy publication claims predate the snapshot CAS receipt. Zero
            // is the explicit migration sentinel; no live storage revision is
            // fabricated or used to authorize a new write.
            acceptedStorageRevision: 0,
        });
        const destinationPublicationKey = repository.publicationKey(
            publication.groupRef,
            publication.publicationId,
        );
        const sourceIsCanonical = sourcePublication.key === destinationPublicationKey;
        if (
            sourceIsCanonical &&
            publications.some((entry) => entry.key === publication.publicationId)
        ) {
            continue;
        }
        if (!sourceIsCanonical && sourcePublication.key !== publication.publicationId) {
            throw publicationCorruption(
                sourcePublication.key,
                'Legacy publication key differs from stored publication id',
            );
        }
        await runtime.begin(async (transaction) => {
            const currentSource = await transaction.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                sourcePublication.key,
            );
            if (!currentSource) {
                await validateCompletedPublicationMigration(
                    transaction,
                    repository,
                    publication,
                    migrationClaim,
                    sourceIsCanonical,
                    sourcePublication.expireAtTimestamp,
                );
                return;
            }
            const currentPublication = readPublicationForMigration(
                currentSource,
            );
            if (!rtcTopologySemanticEqual(currentPublication, publication)) {
                throw publicationCorruption(
                    currentSource.key,
                    'Legacy publication changed before migration',
                );
            }
            const destinationClaimKey = repository.workIndexKey(
                publication.groupRef,
                publication.workId,
            );
            const [legacyClaim, destinationClaim] = await Promise.all([
                transaction.findEntry(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    publication.workId,
                ),
                transaction.findEntry(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    destinationClaimKey,
                ),
            ]);
            if (!legacyClaim && !destinationClaim) {
                throw publicationCorruption(
                    currentSource.key,
                    'Publication work claim is missing',
                );
            }
            if (legacyClaim) {
                readWorkClaimForMigration(legacyClaim, migrationClaim);
                if (
                    legacyClaim.expireAtTimestamp !==
                        currentSource.expireAtTimestamp
                ) {
                    throw publicationCorruption(
                        legacyClaim.key,
                        'Legacy publication work claim physical expiry differs from publication',
                    );
                }
            }
            const claimExpiry = currentSource.expireAtTimestamp;
            let destinationClaimIsCanonical = false;
            if (destinationClaim) {
                destinationClaimIsCanonical = readWorkClaimForMigration(
                    destinationClaim,
                    migrationClaim,
                );
                if (destinationClaim.expireAtTimestamp !== claimExpiry) {
                    throw publicationCorruption(
                        destinationClaim.key,
                        'Canonical publication work claim physical expiry differs from legacy source',
                    );
                }
            }
            if (!destinationClaim) {
                if (!legacyClaim) {
                    throw publicationCorruption(
                        currentSource.key,
                        'Publication work claim source is missing',
                    );
                }
                const inserted = await transaction.insertIfAbsent(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    destinationClaimKey,
                    JSON.stringify(migrationClaim),
                    claimExpiry,
                );
                if (inserted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            } else if (!destinationClaimIsCanonical) {
                const updated = await transaction.upsertIfRevision(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    destinationClaimKey,
                    JSON.stringify(migrationClaim),
                    claimExpiry,
                    destinationClaim.revision,
                );
                if (updated.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }

            const destinationPublication = sourceIsCanonical
                ? currentSource
                : await transaction.findEntry(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    destinationPublicationKey,
                );
            if (!destinationPublication) {
                const inserted = await transaction.insertIfAbsent(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    destinationPublicationKey,
                    JSON.stringify(publication),
                    currentSource.expireAtTimestamp,
                );
                if (inserted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            } else {
                const destinationValue = readPublicationForMigration(
                    destinationPublication,
                );
                if (!rtcTopologySemanticEqual(
                    destinationValue,
                    publication,
                )) {
                    throw publicationCorruption(
                        destinationPublicationKey,
                        'Canonical publication differs from legacy source',
                    );
                }
                if (
                    destinationPublication.expireAtTimestamp !==
                        currentSource.expireAtTimestamp
                ) {
                    throw publicationCorruption(
                        destinationPublication.key,
                        'Canonical publication physical expiry differs from legacy source',
                    );
                }
                if (
                    !rtcTopologySemanticEqual(
                        parseValue(destinationPublication),
                        publication,
                    )
                ) {
                    const updated = await transaction.upsertIfRevision(
                        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                        destinationPublicationKey,
                        JSON.stringify(publication),
                        currentSource.expireAtTimestamp,
                        destinationPublication.revision,
                    );
                    if (updated.status === 'conflict') {
                        throw new RuntimeStateWriteConflictError();
                    }
                }
            }

            if (!sourceIsCanonical) {
                const deleted = await transaction.deleteIfRevision(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    currentSource.key,
                    currentSource.revision,
                );
                if (deleted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
            if (legacyClaim) {
                const deleted = await transaction.deleteIfRevision(
                    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                    legacyClaim.key,
                    legacyClaim.revision,
                );
                if (deleted.status === 'conflict') {
                    throw new RuntimeStateWriteConflictError();
                }
            }
        });
    }
}

export class RtcTopologyPublicationRepository extends RuntimeStateJsonStore {
    constructor(
        readonly runtimeRepository: RuntimeStateRepositoryLike,
        private readonly retentionMs: number =
            DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
        private readonly now: () => number = () => Date.now(),
    ) {
        super(runtimeRepository);
    }

    async findPublication(
        groupRef: GroupRef,
        publicationId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublication(
        publicationId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublication(
        groupRefOrPublicationId: GroupRef | string,
        maybePublicationId?: string,
    ): Promise<RtcTopologyPublication | undefined> {
        if (typeof groupRefOrPublicationId === 'string') {
            const entries = await this.listPublicationEntries();
            const matches = entries.filter(({ value }) =>
                value.publicationId === groupRefOrPublicationId
            );
            if (matches.length > 1) {
                throw publicationCorruption(
                    groupRefOrPublicationId,
                    'RTC topology publication id resolves multiple scopes',
                );
            }
            return matches[0]?.value;
        }
        const publicationId = maybePublicationId!;
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            this.publicationKey(groupRefOrPublicationId, publicationId),
        );
        if (!entry) return undefined;
        return (await this.toLivePublicationEntry(
            entry,
            groupRefOrPublicationId,
            publicationId,
        ))?.value;
    }

    async findPublicationForWork(
        groupRef: GroupRef,
        workId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublicationForWork(
        workId: string,
    ): Promise<RtcTopologyPublication | undefined>;
    async findPublicationForWork(
        groupRefOrWorkId: GroupRef | string,
        maybeWorkId?: string,
    ): Promise<RtcTopologyPublication | undefined> {
        if (typeof groupRefOrWorkId === 'string') {
            const claims = await this.listWorkClaimEntries();
            const matches = claims.filter(({ value }) =>
                value.workId === groupRefOrWorkId
            );
            if (matches.length > 1) {
                throw publicationCorruption(
                    groupRefOrWorkId,
                    'RTC topology work id resolves multiple scopes',
                );
            }
            const claim = matches[0]?.value;
            return claim
                ? (await this.findClaimedPublicationForWork(
                    claim.groupRef,
                    claim.workId,
                ))?.publication
                : undefined;
        }
        const groupRef = groupRefOrWorkId;
        if (maybeWorkId === undefined) {
            throw new TypeError('RTC topology work id is required');
        }
        return (await this.findClaimedPublicationForWork(groupRef, maybeWorkId))
            ?.publication;
    }

    async findClaimedPublicationForWork(
        groupRef: GroupRef,
        workId: string,
    ): Promise<RtcTopologyClaimedPublication | undefined> {
        const claim = await this.findWorkClaimEntry(groupRef, workId);
        if (!claim) return undefined;
        const publication = await this.findPublication(
            groupRef,
            claim.value.publicationId,
        );
        if (!publication || publication.workId !== workId) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology work claim publication is missing or mismatched',
            );
        }
        if (
            !rtcTopologySemanticEqual(
                claim.value.acceptedCausalRevision,
                publication.sourceGroupStateCausalRevision,
            ) || claim.value.outboxIds[0] !== publication.publicationId
        ) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology execution receipt effects differ from publication',
            );
        }
        const commandHash = await hashRtcTopologyExecutionCommand(publication);
        if (claim.value.commandHash !== commandHash) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology execution receipt command hash differs from publication',
            );
        }
        return { claim, publication };
    }

    async findWorkClaimEntry(
        groupRef: GroupRef,
        workId: string,
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim> | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            this.workIndexKey(groupRef, workId),
        );
        if (!entry) return undefined;
        return await this.toLiveWorkClaimEntry(entry, groupRef, workId);
    }

    async listPublicationEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcTopologyPublication>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLivePublicationEntry(entry)
        )));
    }

    async listPublicationEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublication>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLivePublicationEntry(entry)
        )));
    }

    async listWorkClaimEntries(): Promise<
        readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]
    > {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveWorkClaimEntry(entry)
        )));
    }

    async listWorkClaimEntriesPage(
        options: RuntimeStateEntryPageOptions,
    ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            '',
            options,
        );
        return compact(await Promise.all(entries.map((entry) =>
            this.toLiveWorkClaimEntry(entry)
        )));
    }

    async putOrLoad(
        publication: RtcTopologyPublication,
        receiptFacts: RtcTopologyExecutionReceiptFacts,
    ): Promise<PutRtcTopologyPublicationResult> {
        // Compatibility seam with explicit optimistic first-writer semantics.
        // It never overwrites either immutable row and never retries a conflict.
        validateRtcTopologyPublication(publication, publication.groupRef);
        if (
            receiptFacts.commandHash !==
                await hashRtcTopologyExecutionCommand(publication)
        ) {
            throw new TypeError(
                'RTC topology execution receipt command hash is invalid',
            );
        }
        const runtime = requireOptimisticRuntime(this.runtimeRepository);
        const expireAtTimestamp = this.now() + this.retentionMs;
        const inserted = await runtime.begin(async (transaction) => {
            const repository = this.withRepository(transaction);
            const existing = await repository.findClaimedPublicationForWork(
                publication.groupRef,
                publication.workId,
            );
            if (existing) return false;
            const snapshots = new RtcTopologySnapshotRepository(transaction);
            const guardedSnapshot = await snapshots.findSnapshotEntry(
                publication.groupRef,
            );
            if (
                !guardedSnapshot ||
                guardedSnapshot.entry.revision !==
                    receiptFacts.acceptedStorageRevision
            ) {
                throw new RuntimeStateWriteConflictError();
            }
            const guard = await snapshots.commitSnapshotGuard(
                guardedSnapshot.value,
                guardedSnapshot.entry.revision,
            );
            if (guard.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
            }
            const claimed = await repository.insertWorkClaim(
                createRtcTopologyExecutionReceipt(publication, {
                    ...receiptFacts,
                    acceptedStorageRevision: guard.storageRevision,
                }),
                expireAtTimestamp,
            );
            if (!claimed) return false;
            await repository.insertPublication(
                publication,
                expireAtTimestamp,
            );
            return true;
        });
        if (inserted) return { publication, inserted: true };
        const winner = await this.findPublicationForWork(
            publication.groupRef,
            publication.workId,
        );
        if (!winner) throw new RuntimeStateWriteConflictError();
        if (!rtcTopologySemanticEqual(winner, publication)) {
            throw new RtcTopologyPublicationCollisionError(
                this.workIndexKey(publication.groupRef, publication.workId),
            );
        }
        return { publication: winner, inserted: false };
    }

    async insertWorkClaim(
        claim: RtcTopologyPublicationWorkClaim,
        expireAtTimestamp: number,
    ): Promise<boolean> {
        validateWorkClaim(claim, claim.groupRef);
        const result = await this.putValueIfAbsent(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            this.workIndexKey(claim.groupRef, claim.workId),
            claim,
            expireAtTimestamp,
        );
        return result.status === 'applied';
    }

    async insertPublication(
        publication: RtcTopologyPublication,
        expireAtTimestamp: number,
    ): Promise<void> {
        validateRtcTopologyPublication(publication, publication.groupRef);
        const result = await this.putValueIfAbsent(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            this.publicationKey(publication.groupRef, publication.publicationId),
            publication,
            expireAtTimestamp,
        );
        if (result.status === 'conflict') {
            throw new RtcTopologyPublicationCollisionError(
                this.publicationKey(publication.groupRef, publication.publicationId),
            );
        }
    }

    publicationKey(groupRef: GroupRef, publicationId: string): string {
        return childKey(groupRef, 'publication', publicationId);
    }

    workIndexKey(groupRef: GroupRef, workId: string): string {
        return childKey(groupRef, 'work', workId);
    }

    retentionExpireAtTimestamp(): number {
        return this.now() + this.retentionMs;
    }

    private async toLivePublicationEntry(
        entry: RuntimeStateEntry,
        trustedRef?: GroupRef,
        trustedPublicationId?: string,
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublication> | undefined> {
        const decoded = decodeChildKey(entry.key, 'publication');
        assertTrustedSlot(
            decoded,
            trustedRef,
            trustedPublicationId,
            entry.key,
        );
        const value = parseValue(entry);
        try {
            validateRtcTopologyPublication(value, decoded.groupRef);
        } catch (error) {
            throw publicationCorruption(
                entry.key,
                error instanceof Error ? error.message : 'publication value is invalid',
            );
        }
        if (value.publicationId !== decoded.value) {
            throw publicationCorruption(entry.key, 'publication value differs from key');
        }
        const live = await this.toLiveEntryValue<RtcTopologyPublication>(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            entry,
        );
        return live ? { entry: live.entry, value } : undefined;
    }

    private async toLiveWorkClaimEntry(
        entry: RuntimeStateEntry,
        trustedRef?: GroupRef,
        trustedWorkId?: string,
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim> | undefined> {
        const decoded = decodeChildKey(entry.key, 'work');
        assertTrustedSlot(decoded, trustedRef, trustedWorkId, entry.key);
        const value = parseValue(entry);
        try {
            validateWorkClaim(value, decoded.groupRef);
        } catch (error) {
            throw publicationCorruption(
                entry.key,
                error instanceof Error ? error.message : 'work claim is invalid',
            );
        }
        if (value.workId !== decoded.value) {
            throw publicationCorruption(entry.key, 'work claim differs from key');
        }
        const live = await this.toLiveEntryValue<RtcTopologyPublicationWorkClaim>(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            entry,
        );
        return live ? { entry: live.entry, value } : undefined;
    }

    private withRepository(
        repository: RuntimeStateOptimisticTransactionalRepositoryLike,
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.retentionMs,
            this.now,
        );
    }
}

function validateWorkClaim(
    value: unknown,
    expectedRef: GroupRef,
): asserts value is RtcTopologyPublicationWorkClaim {
    if (!isRecord(value)) throw new TypeError('RTC topology work claim is invalid');
    assertExactKeys(value, [
        'kind', 'schemaVersion', 'groupRef', 'workId', 'commandId', 'requestId',
        'commandHash', 'publicationId', 'outcome', 'attemptCount',
        'acceptedCausalRevision', 'acceptedStorageRevision', 'eventId',
        'outboxIds',
    ]);
    validateGroupRef(value.groupRef, expectedRef);
    if (
        value.kind !== 'rtc-topology-execution-receipt' ||
        value.schemaVersion !== 1 || value.outcome !== 'accepted' ||
        typeof value.workId !== 'string' || value.workId.length === 0 ||
        value.commandId !== value.workId || value.requestId !== value.workId ||
        typeof value.commandHash !== 'string' ||
        !/^sha256:[0-9a-f]{64}$/u.test(value.commandHash) ||
        typeof value.publicationId !== 'string' || value.publicationId.length === 0 ||
        !Number.isSafeInteger(value.attemptCount) || Number(value.attemptCount) < 1 ||
        !Number.isSafeInteger(value.acceptedStorageRevision) ||
        Number(value.acceptedStorageRevision) < 0 || value.eventId !== null ||
        !Array.isArray(value.outboxIds) || value.outboxIds.length !== 1 ||
        value.outboxIds[0] !== value.publicationId
    ) {
        throw new TypeError('RTC topology work claim identity is invalid');
    }
    validateCausalRevision(value.acceptedCausalRevision);
}

function validateCausalRevision(
    value: unknown,
): asserts value is GroupStateCausalRevision {
    if (!isRecord(value)) {
        throw new TypeError('RTC topology work claim causal revision is invalid');
    }
    assertExactKeys(value, ['groupRevision', 'presenceRevision']);
    if (
        !Number.isSafeInteger(value.groupRevision) || Number(value.groupRevision) < 0 ||
        !Number.isSafeInteger(value.presenceRevision) ||
        Number(value.presenceRevision) < 0
    ) {
        throw new TypeError('RTC topology work claim causal revision is invalid');
    }
}

function childKey(groupRef: GroupRef, name: string, value: string): string {
    return `${groupStateGroupStorageKey(groupRef)}:${name}=${encodeURIComponent(value)}`;
}

function decodeChildKey(
    storageKey: string,
    name: string,
): Readonly<{ groupRef: GroupRef; value: string }> {
    const parts = storageKey.split(':');
    if (parts.length !== 4) {
        throw publicationCorruption(storageKey, `RTC topology ${name} key has invalid arity`);
    }
    let groupRef: GroupRef;
    try {
        groupRef = decodeGroupStateGroupStorageKey(parts.slice(0, 3).join(':'));
    } catch (error) {
        throw publicationCorruption(
            storageKey,
            error instanceof Error ? error.message : 'RTC topology scope key is invalid',
        );
    }
    const prefix = `${name}=`;
    if (!parts[3]!.startsWith(prefix)) {
        throw publicationCorruption(storageKey, `RTC topology key is missing ${name}`);
    }
    let value: string;
    try {
        value = decodeURIComponent(parts[3]!.slice(prefix.length));
    } catch {
        throw publicationCorruption(storageKey, `RTC topology ${name} encoding is invalid`);
    }
    if (childKey(groupRef, name, value) !== storageKey) {
        throw publicationCorruption(storageKey, `RTC topology ${name} key is not canonical`);
    }
    return { groupRef, value };
}

function assertTrustedSlot(
    decoded: Readonly<{ groupRef: GroupRef; value: string }>,
    trustedRef: GroupRef | undefined,
    trustedValue: string | undefined,
    storageKey: string,
): void {
    if (
        (trustedRef && !sameGroupRef(decoded.groupRef, trustedRef)) ||
        (trustedValue !== undefined && decoded.value !== trustedValue)
    ) {
        throw publicationCorruption(storageKey, 'RTC topology row differs from trusted slot');
    }
}

function validateGroupRef(value: unknown, expected: GroupRef): void {
    if (!isRecord(value)) throw new TypeError('RTC topology groupRef is invalid');
    assertExactKeys(
        value,
        expected.workspaceId === undefined
            ? ['applicationId', 'groupId']
            : ['applicationId', 'workspaceId', 'groupId'],
    );
    if (
        value.applicationId !== expected.applicationId ||
        value.workspaceId !== expected.workspaceId ||
        value.groupId !== expected.groupId
    ) {
        throw new TypeError('RTC topology publication groupRef differs');
    }
}

function parseValue(entry: RuntimeStateEntry): unknown {
    try {
        return JSON.parse(entry.value);
    } catch (error) {
        throw publicationCorruption(
            entry.key,
            error instanceof Error ? error.message : 'RTC topology JSON is invalid',
        );
    }
}

function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC topology publication migration requires optimistic transactions');
    }
    return runtime;
}

async function validateCompletedPublicationMigration(
    transaction: RuntimeStateOptimisticTransactionalRepositoryLike,
    repository: RtcTopologyPublicationRepository,
    publication: RtcTopologyPublication,
    expectedClaim: RtcTopologyPublicationWorkClaim,
    sourceIsCanonical: boolean,
    expectedExpireAtTimestamp: number,
): Promise<void> {
    if (sourceIsCanonical) {
        throw publicationCorruption(
            publication.publicationId,
            'Canonical publication disappeared during migration',
        );
    }
    const destinationPublicationKey = repository.publicationKey(
        publication.groupRef,
        publication.publicationId,
    );
    const destinationClaimKey = repository.workIndexKey(
        publication.groupRef,
        publication.workId,
    );
    const [destinationPublication, destinationClaim, legacyClaim] =
        await Promise.all([
            transaction.findEntry(
                RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                destinationPublicationKey,
            ),
            transaction.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                destinationClaimKey,
            ),
            transaction.findEntry(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                publication.workId,
            ),
        ]);
    if (!destinationPublication || !destinationClaim || legacyClaim) {
        throw publicationCorruption(
            publication.publicationId,
            'Concurrent publication migration did not leave one complete canonical winner',
        );
    }
    if (
        destinationPublication.expireAtTimestamp !== expectedExpireAtTimestamp ||
        destinationClaim.expireAtTimestamp !== expectedExpireAtTimestamp
    ) {
        throw publicationCorruption(
            publication.publicationId,
            'Concurrent publication migration winner physical expiry differs from source',
        );
    }
    if (!readWorkClaimForMigration(destinationClaim, expectedClaim)) {
        throw publicationCorruption(
            destinationClaim.key,
            'Concurrent publication migration left a legacy work claim',
        );
    }
    const destinationValue = readPublicationForMigration(destinationPublication);
    if (
        !rtcTopologySemanticEqual(destinationValue, publication) ||
        !rtcTopologySemanticEqual(parseValue(destinationPublication), publication)
    ) {
        throw publicationCorruption(
            destinationPublication.key,
            'Concurrent publication migration destination differs from source',
        );
    }
}

function readPublicationForMigration(
    entry: RuntimeStateEntry,
): RtcTopologyPublication {
    const raw = parseValue(entry);
    if (
        !isRecord(raw) ||
        typeof raw.publicationId !== 'string' ||
        typeof raw.workId !== 'string' ||
        !isRecord(raw.groupRef)
    ) {
        throw publicationCorruption(entry.key, 'Legacy publication is invalid');
    }
    try {
        return publicationForMigration(raw);
    } catch (error) {
        throw publicationCorruption(
            entry.key,
            error instanceof Error ? error.message : 'Legacy publication is invalid',
        );
    }
}

function readWorkClaimForMigration(
    entry: RuntimeStateEntry,
    expected: RtcTopologyPublicationWorkClaim,
): boolean {
    const raw = parseValue(entry);
    if (typeof raw === 'string') {
        if (raw !== expected.publicationId) {
            throw publicationCorruption(
                entry.key,
                'Legacy work claim differs from publication source',
            );
        }
        return false;
    }
    try {
        validateWorkClaim(raw, expected.groupRef);
        if (
            raw.workId !== expected.workId ||
            raw.publicationId !== expected.publicationId ||
            !rtcTopologySemanticEqual(raw, expected)
        ) {
            throw new TypeError('Canonical work claim differs from legacy source');
        }
        return true;
    } catch (canonicalError) {
        try {
            if (!isRecord(raw)) throw canonicalError;
            assertExactKeys(raw, ['groupRef', 'workId', 'publicationId']);
            validateGroupRef(raw.groupRef, expected.groupRef);
            if (
                raw.workId !== expected.workId ||
                raw.publicationId !== expected.publicationId
            ) throw canonicalError;
            return false;
        } catch (legacyError) {
            const error = legacyError === canonicalError
                ? canonicalError
                : legacyError;
            throw publicationCorruption(
                entry.key,
                error instanceof Error
                    ? error.message
                    : 'Legacy work claim is invalid',
            );
        }
    }
}

function canonicalPublication(
    publication: RtcTopologyPublication,
): RtcTopologyPublication {
    const ref = publication.groupRef;
    return {
        ...publication,
        groupRef: {
            applicationId: ref.applicationId,
            workspaceId: ref.workspaceId,
            groupId: ref.groupId,
        },
    };
}

function publicationForMigration(
    raw: Record<string, unknown>,
): RtcTopologyPublication {
    const hasTarget = Object.hasOwn(raw, 'targetGroupSnapshotVersion');
    const keys = [
        'publicationId',
        'workId',
        'groupRef',
        'sourceGroupStateCausalRevision',
        'overlayVersion',
        ...(hasTarget ? ['targetGroupSnapshotVersion'] : []),
        'recipientSessionIds',
        'message',
        'createdAtEpochMs',
    ];
    assertExactKeys(raw, keys);
    validatePersistedALMessage(raw.message);
    const message = raw.message;
    if (
        message.targets?.mode !== 'broadcast' ||
        message.targets.scope !== 'room' ||
        message.targets.minSnapshotVersion === undefined
    ) {
        throw new TypeError('Legacy RTC topology publication target is invalid');
    }
    let snapshot: unknown;
    try {
        snapshot = JSON.parse(message.payload.resource);
    } catch {
        throw new TypeError('Legacy RTC topology publication snapshot is invalid');
    }
    const groupRef = readMigrationGroupRef(raw.groupRef);
    validateTopologySnapshot(snapshot, groupRef);
    const targetGroupSnapshotVersion: unknown = hasTarget
        ? raw.targetGroupSnapshotVersion
        : message.targets.minSnapshotVersion;
    if (
        !Number.isSafeInteger(targetGroupSnapshotVersion) ||
        Number(targetGroupSnapshotVersion) < 0
    ) {
        throw new TypeError('Legacy RTC topology publication target is invalid');
    }
    if (targetGroupSnapshotVersion !== message.targets.minSnapshotVersion) {
        throw new TypeError('Legacy RTC topology publication target is inconsistent');
    }
    const workId = raw.workId;
    if (typeof workId !== 'string' || workId.length === 0) {
        throw new TypeError('Legacy RTC topology publication work id is invalid');
    }
    const createdAtEpochMs = raw.createdAtEpochMs;
    if (!Number.isSafeInteger(createdAtEpochMs) || Number(createdAtEpochMs) < 0) {
        throw new TypeError('Legacy RTC topology publication created time is invalid');
    }
    const candidate = {
        publicationId: raw.publicationId,
        workId,
        groupRef,
        sourceGroupStateCausalRevision: raw.sourceGroupStateCausalRevision,
        overlayVersion: raw.overlayVersion,
        targetGroupSnapshotVersion,
        recipientSessionIds: raw.recipientSessionIds,
        message: {
            ...message,
            id: {
                ...message.id,
                msgId: toRtcTopologyPublicationMessageId(workId),
                ts: createdAtEpochMs,
            },
            audit: {
                ...message.audit,
                createdTs: createdAtEpochMs,
            },
        },
        createdAtEpochMs,
    };
    validateRtcTopologyPublication(candidate, groupRef);
    return canonicalPublication(candidate);
}

function readMigrationGroupRef(value: unknown): GroupRef {
    if (!isRecord(value)) {
        throw new TypeError('Legacy RTC topology publication groupRef is invalid');
    }
    assertExactKeys(value, ['applicationId', 'workspaceId', 'groupId']);
    if (
        typeof value.applicationId !== 'string' || value.applicationId.length === 0 ||
        typeof value.workspaceId !== 'string' ||
        typeof value.groupId !== 'string' || value.groupId.length === 0
    ) {
        throw new TypeError('Legacy RTC topology publication groupRef is invalid');
    }
    return {
        applicationId: value.applicationId,
        workspaceId: value.workspaceId,
        groupId: value.groupId,
    };
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (!rtcTopologySemanticEqual(Object.keys(value).sort(), [...keys].sort())) {
        throw new TypeError('RTC topology persisted value has invalid keys');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function publicationCorruption(
    storageKey: string,
    message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
    return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}

function compact<T>(values: readonly (T | undefined)[]): readonly T[] {
    return values.filter((value): value is T => value !== undefined);
}
