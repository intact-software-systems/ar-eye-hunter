import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { RuntimeStateEntryValue } from '../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../runtime-state/RuntimeStateJsonStore.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike,
    RuntimeStateTransactionalRepositoryLike,
    RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import {
    isRuntimeStateConditionalRepositoryLike,
    isRuntimeStateOptimisticTransactionalRepositoryLike,
    isRuntimeStateTransactionalRepositoryLike,
} from '../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError } from '../../runtime-state/optimistic-runtime-state-write.ts';
import {
    decodeGroupStateGroupStorageKey,
    groupStateGroupStorageKey,
} from '../group-state-storage-keys.ts';
import {
    RtcTopologyRepositoryInvariantCorruptionError,
    validateTopologySnapshot,
} from './RtcTopologySnapshotRepository.ts';

export const RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE = 'rtc-topology:publications';
export const RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE =
    'rtc-topology:publication-work-index';
export const DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS = 24 * 60 * 60 * 1_000;

export type RtcTopologyPublication = Readonly<{
    publicationId: string;
    workId: string;
    groupRef: GroupRef;
    sourceGroupStateRevision: number;
    overlayVersion: number;
    recipientSessionIds: readonly string[];
    message: ALMessage;
    createdAtEpochMs: number;
}>;

export type RtcTopologyPublicationWorkClaim = Readonly<{
    groupRef: GroupRef;
    workId: string;
    publicationId: string;
}>;

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
    options: Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
    if (options.oldWritersStopped !== true) {
        throw new Error('RTC topology publication migration requires old writers stopped');
    }
    const runtime = requireOptimisticRuntime(repository.runtimeRepository);
    const publications = await runtime.findAllEntries(
        RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    );
    for (const sourcePublication of publications) {
        const raw = parseValue(sourcePublication) as RtcTopologyPublication;
        if (!isRecord(raw) || typeof raw.publicationId !== 'string' ||
            typeof raw.workId !== 'string' || !isRecord(raw.groupRef)) {
            throw publicationCorruption(sourcePublication.key, 'Legacy publication is invalid');
        }
        const publication = canonicalPublication(raw);
        validatePublication(publication, publication.groupRef);
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
        const sourceClaim = await runtime.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            publication.workId,
        );
        if (!sourceClaim && !sourceIsCanonical) {
            throw publicationCorruption(sourcePublication.key, 'Legacy work claim is missing');
        }
        if (!sourceClaim) continue;
        let claimedPublicationId: unknown;
        try {
            claimedPublicationId = JSON.parse(sourceClaim.value);
        } catch {
            throw publicationCorruption(sourceClaim.key, 'Legacy work claim JSON is invalid');
        }
        if (claimedPublicationId !== publication.publicationId) {
            throw publicationCorruption(sourceClaim.key, 'Legacy work claim differs from publication');
        }
        await runtime.begin(async (transaction) => {
            const migrated = new RtcTopologyPublicationRepository(
                transaction,
                DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
                () => publication.createdAtEpochMs,
            );
            const destinationClaim = await migrated.findWorkClaimEntry(
                publication.groupRef,
                publication.workId,
            );
            if (destinationClaim) {
                const expectedClaim: RtcTopologyPublicationWorkClaim = {
                    groupRef: publication.groupRef,
                    workId: publication.workId,
                    publicationId: publication.publicationId,
                };
                if (JSON.stringify(destinationClaim.value) !== JSON.stringify(expectedClaim)) {
                    throw publicationCorruption(
                        destinationClaim.entry.key,
                        'Canonical work claim differs from legacy source',
                    );
                }
            } else if (!await migrated.insertWorkClaim(
                publication,
                sourceClaim.expireAtTimestamp,
            )) {
                throw new RuntimeStateWriteConflictError();
            }
            const destinationPublication = await migrated.findPublication(
                publication.groupRef,
                publication.publicationId,
            );
            if (destinationPublication) {
                if (JSON.stringify(destinationPublication) !== JSON.stringify(publication)) {
                    throw publicationCorruption(
                        destinationPublicationKey,
                        'Canonical publication differs from legacy source',
                    );
                }
            } else {
                await migrated.insertPublication(
                    publication,
                    sourcePublication.expireAtTimestamp,
                );
            }
            const deletedPublication = sourceIsCanonical
                ? { status: 'applied' as const }
                : await transaction.deleteIfRevision(
                    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
                    sourcePublication.key,
                    sourcePublication.revision,
                );
            const deletedClaim = await transaction.deleteIfRevision(
                RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
                sourceClaim.key,
                sourceClaim.revision,
            );
            if (deletedPublication.status === 'conflict' ||
                deletedClaim.status === 'conflict') {
                throw new RuntimeStateWriteConflictError();
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
                ? await this.findPublication(claim.groupRef, claim.publicationId)
                : undefined;
        }
        const groupRef = groupRefOrWorkId;
        const workId = maybeWorkId!;
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
        return publication;
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
    ): Promise<PutRtcTopologyPublicationResult> {
        validatePublication(publication, publication.groupRef);
        const runtime = requireTransactionalRuntime(this.runtimeRepository);
        const expireAtTimestamp = this.now() + this.retentionMs;
        const inserted = await runtime.begin(async (transaction) => {
            const repository = this.withRepository(transaction);
            const claimed = await repository.insertWorkClaim(
                publication,
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
        return { publication: winner, inserted: false };
    }

    async insertWorkClaim(
        publication: RtcTopologyPublication,
        expireAtTimestamp: number,
    ): Promise<boolean> {
        const claim: RtcTopologyPublicationWorkClaim = {
            groupRef: publication.groupRef,
            workId: publication.workId,
            publicationId: publication.publicationId,
        };
        const result = await this.putValueIfAbsent(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            this.workIndexKey(publication.groupRef, publication.workId),
            claim,
            expireAtTimestamp,
        );
        return result.status === 'applied';
    }

    async insertPublication(
        publication: RtcTopologyPublication,
        expireAtTimestamp: number,
    ): Promise<void> {
        validatePublication(publication, publication.groupRef);
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
        const value = parseValue(entry) as RtcTopologyPublication;
        try {
            validatePublication(value, decoded.groupRef);
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
        const value = parseValue(entry) as RtcTopologyPublicationWorkClaim;
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
        repository: RuntimeStateTransactionalRepositoryLike,
    ): RtcTopologyPublicationRepository {
        return new RtcTopologyPublicationRepository(
            repository,
            this.retentionMs,
            this.now,
        );
    }
}

export function toRtcTopologyPublicationId(input: Readonly<{
    workId: string;
    sourceGroupStateRevision: number;
    overlayVersion: number;
}>): string {
    return [
        input.workId,
        input.sourceGroupStateRevision,
        input.overlayVersion,
    ].join(':');
}

function validatePublication(value: unknown, expectedRef: GroupRef): void {
    if (!isRecord(value)) throw new TypeError('RTC topology publication is invalid');
    assertExactKeys(value, [
        'publicationId',
        'workId',
        'groupRef',
        'sourceGroupStateRevision',
        'overlayVersion',
        'recipientSessionIds',
        'message',
        'createdAtEpochMs',
    ]);
    validateGroupRef(value.groupRef, expectedRef);
    for (const field of ['publicationId', 'workId'] as const) {
        if (typeof value[field] !== 'string' || value[field].length === 0) {
            throw new TypeError(`RTC topology ${field} is invalid`);
        }
    }
    if (value.publicationId !== toRtcTopologyPublicationId({
        workId: value.workId as string,
        sourceGroupStateRevision: value.sourceGroupStateRevision as number,
        overlayVersion: value.overlayVersion as number,
    })) {
        throw new TypeError('RTC topology publication id is not deterministic');
    }
    for (const field of [
        'sourceGroupStateRevision',
        'overlayVersion',
        'createdAtEpochMs',
    ] as const) {
        if (!Number.isSafeInteger(value[field]) || (value[field] as number) < 0) {
            throw new TypeError(`RTC topology ${field} is invalid`);
        }
    }
    if (
        !Array.isArray(value.recipientSessionIds) ||
        !value.recipientSessionIds.every((entry) => typeof entry === 'string') ||
        !isRecord(value.message)
    ) {
        throw new TypeError('RTC topology publication payload is invalid');
    }
    let snapshot: unknown;
    try {
        snapshot = JSON.parse((value.message as ALMessage).payload.resource);
    } catch {
        throw new TypeError('RTC topology publication message snapshot is invalid');
    }
    validateTopologySnapshot(snapshot, expectedRef);
    if (
        (snapshot as RallarOverlayTopologySnapshot).sourceGroupStateRevision !==
            value.sourceGroupStateRevision ||
        (snapshot as RallarOverlayTopologySnapshot).version !== value.overlayVersion ||
        JSON.stringify((snapshot as RallarOverlayTopologySnapshot).activeSessionIds) !==
            JSON.stringify(value.recipientSessionIds)
    ) {
        throw new TypeError('RTC topology publication message identity is invalid');
    }
}

function validateWorkClaim(value: unknown, expectedRef: GroupRef): void {
    if (!isRecord(value)) throw new TypeError('RTC topology work claim is invalid');
    assertExactKeys(value, ['groupRef', 'workId', 'publicationId']);
    validateGroupRef(value.groupRef, expectedRef);
    if (
        typeof value.workId !== 'string' || value.workId.length === 0 ||
        typeof value.publicationId !== 'string' || value.publicationId.length === 0
    ) {
        throw new TypeError('RTC topology work claim identity is invalid');
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

function requireTransactionalRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateTransactionalRepositoryLike {
    if (!isRuntimeStateTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC topology publications require a transactional repository');
    }
    return runtime;
}

function requireOptimisticRuntime(
    runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
    if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
        throw new Error('RTC topology publication migration requires optimistic transactions');
    }
    return runtime;
}

function canonicalPublication(
    publication: RtcTopologyPublication,
): RtcTopologyPublication {
    const ref = publication.groupRef;
    return {
        ...publication,
        groupRef: ref.workspaceId === undefined
            ? { applicationId: ref.applicationId, groupId: ref.groupId }
            : {
                applicationId: ref.applicationId,
                workspaceId: ref.workspaceId,
                groupId: ref.groupId,
            },
    };
}

function sameGroupRef(left: GroupRef, right: GroupRef): boolean {
    return left.applicationId === right.applicationId &&
        left.workspaceId === right.workspaceId &&
        left.groupId === right.groupId;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
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
