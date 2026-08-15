import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type {
  RuntimeStateRepositoryLike,
  RuntimeStateOptimisticTransactionalRepositoryLike,
} from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { isRuntimeStateOptimisticTransactionalRepositoryLike }
    from '../../../runtime-state/RuntimeStateRepository.ts';
// prettier-ignore
import { RuntimeStateWriteConflictError }
    from '../../../runtime-state/optimistic-runtime-state-write.ts';
import { RtcTopologyRepositoryInvariantCorruptionError } from '../../rtc-topology-errors.ts';
import { rtcTopologySemanticEqual } from '../../rtc-topology-semantic-equality.ts';
import { validateRtcRttMeasurement } from './rtc-rtt-persistence-validation.ts';
import { RtcRttRepository } from './rtc-rtt-repository.ts';
import { RTC_RTT_LATEST_NAMESPACE } from './rtc-rtt-runtime-namespaces.ts';
import { sortRtcRttSessionPair, toRtcRttMeasurementStorageKey } from './rtc-rtt-storage-keys.ts';

export async function migrateLegacyRtcRttMeasurementKeys(
  repository: RtcRttRepository,
  options: Readonly<{ oldWritersStopped: true }>,
): Promise<void> {
  if (options.oldWritersStopped !== true) {
    throw new Error('RTC RTT migration requires old writers stopped');
  }
  const runtime = requireOptimisticRuntime(repository.runtimeRepository);
  const entries = await runtime.findAllEntries(RTC_RTT_LATEST_NAMESPACE);
  for (const source of entries) {
    const value = parseMeasurement(source.key, source.value);
    const destinationKey = toRtcRttMeasurementStorageKey(value.sessionIdFrom, value.sessionIdTo);
    if (source.key === destinationKey) continue;
    assertLegacyMeasurementKey(source.key, value);
    await runtime.begin(async (transaction) => {
      const migrated = new RtcRttRepository(transaction, {
        now: () => 0,
      });
      const destination = await migrated.findMeasurement(value.sessionIdFrom, value.sessionIdTo);
      if (destination) {
        if (!rtcTopologySemanticEqual(destination, value)) {
          throw corruption(destinationKey, 'Canonical RTC RTT value differs from legacy source');
        }
      } else {
        const inserted = await transaction.insertIfAbsent(
          RTC_RTT_LATEST_NAMESPACE,
          destinationKey,
          JSON.stringify(value),
          source.expireAtTimestamp,
        );
        if (inserted.status === 'conflict') {
          throw new RuntimeStateWriteConflictError();
        }
      }
      const deleted = await transaction.deleteIfRevision(
        RTC_RTT_LATEST_NAMESPACE,
        source.key,
        source.revision,
      );
      if (deleted.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
      }
    });
  }
}

function parseMeasurement(storageKey: string, serializedValue: string): RttMeasurementInfo {
  try {
    const value = JSON.parse(serializedValue);
    validateRtcRttMeasurement(value);
    return value;
  } catch (error) {
    throw corruption(
      storageKey,
      error instanceof Error ? error.message : 'RTC RTT value is invalid',
    );
  }
}

function assertLegacyMeasurementKey(storageKey: string, value: RttMeasurementInfo): void {
  const [from, to] = sortRtcRttSessionPair(value.sessionIdFrom, value.sessionIdTo);
  const expectedLegacyKey = `pair=${encodeURIComponent(`${from}::${to}`)}`;
  if (storageKey !== expectedLegacyKey) {
    throw corruption(storageKey, 'Legacy RTC RTT key differs from value');
  }
}

function requireOptimisticRuntime(
  runtime: RuntimeStateRepositoryLike,
): RuntimeStateOptimisticTransactionalRepositoryLike {
  if (!isRuntimeStateOptimisticTransactionalRepositoryLike(runtime)) {
    throw new Error('RTC RTT migration requires optimistic transactions');
  }
  return runtime;
}

function corruption(
  storageKey: string,
  message: string,
): RtcTopologyRepositoryInvariantCorruptionError {
  return new RtcTopologyRepositoryInvariantCorruptionError(storageKey, message);
}
