import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import {
  decodeCanonicalGroupPresenceSummaryEntry,
  type GroupPresenceSummaryWorkData,
} from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { NonRetryableException } from '@shared/queuebox/DequeueResourceEntryController.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const MALFORMED_SUMMARY_WORK = 'Presence-summary work payload is malformed';

export function decodeCanonicalGroupPresenceSummaryWork(
  message: ALMessage,
  entry: ResourceEntry,
): GroupPresenceSummaryWorkData {
  try {
    const work = decodeCanonicalGroupPresenceSummaryEntry(entry);
    if (
      entry.resource !== JSON.stringify(message) ||
      entry.status !== EntityStatus.RESERVED ||
      entry.dequeueAudit.startTs === undefined ||
      entry.dequeueAudit.endTs !== undefined ||
      entry.dequeueAudit.nextTs !== undefined ||
      !Number.isSafeInteger(entry.dequeueAudit.attempts) ||
      entry.dequeueAudit.attempts < 1
    ) {
      throw new TypeError('Presence-summary reservation is invalid');
    }

    return work;
  } catch {
    throw new NonRetryableException(MALFORMED_SUMMARY_WORK);
  }
}
