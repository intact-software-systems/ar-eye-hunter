import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import type {
  RuntimeStateEntry,
  RuntimeStateEntryPageOptions,
  RuntimeStateOptimisticTransactionalRepositoryLike,
  RuntimeStateRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
import { RuntimeStateWriteConflictError }
  from '../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RtcTopologyPublication } from '../../rtc-topology-publication-contract.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import { validateRtcTopologyPublication } from '../../rtc-topology-publication-validation.ts';
import { RtcTopologySnapshotRepository } from '../RtcTopologySnapshotRepository.ts';
import {
  createRtcTopologyExecutionReceipt,
  DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
  hashRtcTopologyExecutionCommand,
  type PutRtcTopologyPublicationResult,
  RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
  RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
  type RtcTopologyClaimedPublication,
  RtcTopologyPublicationCollisionError,
  type RtcTopologyExecutionReceiptFacts,
  type RtcTopologyPublicationWorkClaim,
} from './rtc-topology-publication-repository-contracts.ts';
import {
  assertTrustedSlot,
  childKey,
  compact,
  decodeChildKey,
  parseValue,
  publicationCorruption,
  requireOptimisticRuntime,
  validateWorkClaim,
} from './rtc-topology-publication-repository-state.ts';

export class RtcTopologyPublicationRepository extends RuntimeStateJsonStore {
  constructor(
    readonly runtimeRepository: RuntimeStateRepositoryLike,
    private readonly retentionMs: number = DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    super(runtimeRepository);
  }

  async findPublication(
    groupRef: GroupRef,
    publicationId: string,
  ): Promise<RtcTopologyPublication | undefined>;
  async findPublication(publicationId: string): Promise<RtcTopologyPublication | undefined>;
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
  async findPublicationForWork(workId: string): Promise<RtcTopologyPublication | undefined>;
  async findPublicationForWork(
    groupRefOrWorkId: GroupRef | string,
    maybeWorkId?: string,
  ): Promise<RtcTopologyPublication | undefined> {
    if (typeof groupRefOrWorkId === 'string') {
      const claims = await this.listWorkClaimEntries();
      const matches = claims.filter(({ value }) => value.workId === groupRefOrWorkId);
      if (matches.length > 1) {
        throw publicationCorruption(
          groupRefOrWorkId,
          'RTC topology work id resolves multiple scopes',
        );
      }
      const claim = matches[0]?.value;
      return claim
        ? (await this.findClaimedPublicationForWork(claim.groupRef, claim.workId))?.publication
        : undefined;
    }
    const groupRef = groupRefOrWorkId;
    if (maybeWorkId === undefined) throw new TypeError('RTC topology work id is required');
    return (await this.findClaimedPublicationForWork(groupRef, maybeWorkId))?.publication;
  }

  async findClaimedPublicationForWork(
    groupRef: GroupRef,
    workId: string,
  ): Promise<RtcTopologyClaimedPublication | undefined> {
    const claim = await this.findWorkClaimEntry(groupRef, workId);
    if (!claim) return undefined;
    const publication = await this.findPublication(groupRef, claim.value.publicationId);
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
    return compact(await Promise.all(entries.map((entry) => this.toLivePublicationEntry(entry))));
  }

  async listPublicationEntriesPage(
    options: RuntimeStateEntryPageOptions,
  ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublication>[]> {
    const entries = await this.listEntriesPage(
      RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
      '',
      options,
    );
    return compact(await Promise.all(entries.map((entry) => this.toLivePublicationEntry(entry))));
  }

  async listWorkClaimEntries(): Promise<
    readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]
  > {
    const entries = await this.runtimeRepository.findAllEntries(
      RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    );
    return compact(await Promise.all(entries.map((entry) => this.toLiveWorkClaimEntry(entry))));
  }

  async listWorkClaimEntriesPage(
    options: RuntimeStateEntryPageOptions,
  ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]> {
    const entries = await this.listEntriesPage(
      RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
      '',
      options,
    );
    return compact(await Promise.all(entries.map((entry) => this.toLiveWorkClaimEntry(entry))));
  }

  async putOrLoad(
    publication: RtcTopologyPublication,
    receiptFacts: RtcTopologyExecutionReceiptFacts,
  ): Promise<PutRtcTopologyPublicationResult> {
    // Compatibility seam with explicit optimistic first-writer semantics.
    // It never overwrites either immutable row and never retries a conflict.
    validateRtcTopologyPublication(publication, publication.groupRef);
    if (receiptFacts.commandHash !== await hashRtcTopologyExecutionCommand(publication)) {
      throw new TypeError('RTC topology execution receipt command hash is invalid');
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
      const guardedSnapshot = await snapshots.findSnapshotEntry(publication.groupRef);
      if (
        !guardedSnapshot ||
        guardedSnapshot.entry.revision !== receiptFacts.acceptedStorageRevision
      ) {
        throw new RuntimeStateWriteConflictError();
      }
      const guard = await snapshots.commitSnapshotGuard(
        guardedSnapshot.value,
        guardedSnapshot.entry.revision,
      );
      if (guard.status === 'conflict') throw new RuntimeStateWriteConflictError();
      const claimed = await repository.insertWorkClaim(
        createRtcTopologyExecutionReceipt(publication, {
          ...receiptFacts,
          acceptedStorageRevision: guard.storageRevision,
        }),
        expireAtTimestamp,
      );
      if (!claimed) return false;
      await repository.insertPublication(publication, expireAtTimestamp);
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
    assertTrustedSlot({
      decoded,
      trustedRef,
      trustedValue: trustedPublicationId,
      storageKey: entry.key,
    });
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
    assertTrustedSlot({
      decoded,
      trustedRef,
      trustedValue: trustedWorkId,
      storageKey: entry.key,
    });
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
    return new RtcTopologyPublicationRepository(repository, this.retentionMs, this.now);
  }
}
