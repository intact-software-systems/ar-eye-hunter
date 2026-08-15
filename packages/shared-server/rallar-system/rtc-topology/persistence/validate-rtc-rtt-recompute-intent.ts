import type { RttMeasurementInfo } from '@shared/api/api-config.ts';
import type { GroupSnapshot } from '@shared/api/group-types.ts';
// prettier-ignore
import * as snapshotValidation
    from '../../group-state/snapshot/validate-persisted-group-snapshot.ts';
import {
  toRtcRttMutationReceiptId,
  toRtcRttRecomputeOutboxId,
} from '../mutation/rtc-rtt-mutation-identifiers.ts';
import {
  assertExactRtcRttPersistedKeys,
  assertNonEmptyRtcRttString,
  assertRtcRttSafeInteger,
  readRtcRttPersistedRecord,
  validateRtcRttCommandHash,
  validateRtcRttFamilyExpiry,
} from './rtc-rtt-persistence-validation-primitives.ts';
import { validateRtcRttMeasurement } from './rtc-rtt-persistence-validation.ts';

type RtcRttRecomputeIntentContract = Readonly<{
  outboxId: string;
  receiptId: string;
  groupSnapshot: GroupSnapshot;
  rtt: RttMeasurementInfo;
  createdAtEpochMs: number;
  commandHash: string;
  senderId: string;
  delivery:
    Readonly<{ state: 'pending' }> | Readonly<{ state: 'delivered'; deliveredAtEpochMs: number }>;
}>;

export function validateRtcRttRecomputeIntent(
  value: unknown,
  physicalExpiry?: number,
): asserts value is RtcRttRecomputeIntentContract {
  const intent = readRtcRttPersistedRecord(value, 'RTC RTT recompute intent');
  assertExactRtcRttPersistedKeys(intent, [
    'outboxId',
    'receiptId',
    'groupSnapshot',
    'rtt',
    'createdAtEpochMs',
    'commandHash',
    'senderId',
    'delivery',
  ]);
  assertNonEmptyRtcRttString(intent.outboxId, 'recompute outbox id');
  assertNonEmptyRtcRttString(intent.receiptId, 'recompute receipt id');
  assertRtcRttSafeInteger(intent.createdAtEpochMs, 0, 'recompute creation time');
  validateRtcRttCommandHash(intent.commandHash);
  assertNonEmptyRtcRttString(intent.senderId, 'recompute sender id');
  snapshotValidation.validatePersistedGroupSnapshot(intent.groupSnapshot);
  validateRtcRttMeasurement(intent.rtt);
  const group = intent.groupSnapshot as GroupSnapshot;
  const rtt = intent.rtt as RttMeasurementInfo;
  const receiptId = toRtcRttMutationReceiptId(rtt);
  if (
    intent.receiptId !== receiptId ||
    intent.outboxId !==
      toRtcRttRecomputeOutboxId(receiptId, group.group, intent.commandHash as string)
  ) {
    throw new TypeError('RTC RTT recompute intent identity is invalid');
  }
  const delivery = readRtcRttPersistedRecord(intent.delivery, 'RTC RTT recompute delivery');
  if (delivery.state === 'pending') {
    assertExactRtcRttPersistedKeys(delivery, ['state']);
  } else if (delivery.state === 'delivered') {
    assertExactRtcRttPersistedKeys(delivery, ['state', 'deliveredAtEpochMs']);
    assertRtcRttSafeInteger(
      delivery.deliveredAtEpochMs,
      intent.createdAtEpochMs as number,
      'recompute delivered time',
    );
    if (physicalExpiry !== undefined && (delivery.deliveredAtEpochMs as number) > physicalExpiry) {
      throw new TypeError('RTC RTT recompute delivered time is invalid');
    }
  } else {
    throw new TypeError('RTC RTT recompute delivery state is invalid');
  }
  if (physicalExpiry !== undefined) {
    validateRtcRttFamilyExpiry(
      intent.createdAtEpochMs as number,
      physicalExpiry,
      'recompute intent',
    );
  }
}
