import { RuntimeStateWriteConflictError }
  from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import {
  createRtcTopologyExecutionReceipt,
  hashRtcTopologyExecutionCommand,
  RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
  RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
} from './rtc-topology-publication-repository-contracts.ts';
import {
  readPublicationForMigration,
  readWorkClaimForMigration,
  validateCompletedPublicationMigration,
} from './rtc-topology-publication-migration-codec.ts';
import type {
  RtcTopologyPublicationRepository,
} from './rtc-topology-publication-repository.ts';
import {
  parseValue,
  publicationCorruption,
  requireOptimisticRuntime,
} from './rtc-topology-publication-repository-state.ts';

export async function migrateLegacyRtcTopologyPublicationKeys(
  repository: RtcTopologyPublicationRepository,
  options: Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
  if (options.oldWritersStopped !== true) {
    throw new Error('RTC topology publication migration requires old writers stopped');
  }
  const runtime = requireOptimisticRuntime(repository.runtimeRepository);
  const publications = await runtime.findAllEntries(RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE);
  for (const sourcePublication of publications) {
    const publication = readPublicationForMigration(sourcePublication);
    const migrationClaim = createRtcTopologyExecutionReceipt(publication, {
      commandHash: await hashRtcTopologyExecutionCommand(publication),
      attemptCount: 1,
      // Legacy publication claims predate the snapshot CAS receipt. Zero is
      // the explicit migration sentinel; no live revision is fabricated.
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
        await validateCompletedPublicationMigration({
          transaction,
          repository,
          publication,
          expectedClaim: migrationClaim,
          sourceIsCanonical,
          expectedExpireAtTimestamp: sourcePublication.expireAtTimestamp,
        });
        return;
      }
      const currentPublication = readPublicationForMigration(currentSource);
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
        throw publicationCorruption(currentSource.key, 'Publication work claim is missing');
      }
      if (legacyClaim) {
        readWorkClaimForMigration(legacyClaim, migrationClaim);
        if (legacyClaim.expireAtTimestamp !== currentSource.expireAtTimestamp) {
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
        if (inserted.status === 'conflict') throw new RuntimeStateWriteConflictError();
      } else if (!destinationClaimIsCanonical) {
        const updated = await transaction.upsertIfRevision(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          destinationClaimKey,
          JSON.stringify(migrationClaim),
          claimExpiry,
          destinationClaim.revision,
        );
        if (updated.status === 'conflict') throw new RuntimeStateWriteConflictError();
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
        if (inserted.status === 'conflict') throw new RuntimeStateWriteConflictError();
      } else {
        const destinationValue = readPublicationForMigration(destinationPublication);
        if (!rtcTopologySemanticEqual(destinationValue, publication)) {
          throw publicationCorruption(
            destinationPublicationKey,
            'Canonical publication differs from legacy source',
          );
        }
        if (destinationPublication.expireAtTimestamp !== currentSource.expireAtTimestamp) {
          throw publicationCorruption(
            destinationPublication.key,
            'Canonical publication physical expiry differs from legacy source',
          );
        }
        if (!rtcTopologySemanticEqual(parseValue(destinationPublication), publication)) {
          const updated = await transaction.upsertIfRevision(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            destinationPublicationKey,
            JSON.stringify(publication),
            currentSource.expireAtTimestamp,
            destinationPublication.revision,
          );
          if (updated.status === 'conflict') throw new RuntimeStateWriteConflictError();
        }
      }

      if (!sourceIsCanonical) {
        const deleted = await transaction.deleteIfRevision(
          RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
          currentSource.key,
          currentSource.revision,
        );
        if (deleted.status === 'conflict') throw new RuntimeStateWriteConflictError();
      }
      if (legacyClaim) {
        const deleted = await transaction.deleteIfRevision(
          RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
          legacyClaim.key,
          legacyClaim.revision,
        );
        if (deleted.status === 'conflict') throw new RuntimeStateWriteConflictError();
      }
    });
  }
}
