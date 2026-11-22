import { AL_MESSAGE_RESOURCE_LIMITS } from '../../al-contracts/al-message-resource-limits.ts';
import { DEFAULT_AL_EPHEMERAL_TTL_MS } from '../ALStoreRetention.ts';
import { computeALReceiptRetentionExpiryMs } from '../delivery/compute-al-receipt-retention-expiry-ms.ts';

import type { ALReceiptRecordOpening } from './al-receipt-record-rows.ts';

export const AL_RECEIPT_RECORD_WINDOW_MS = DEFAULT_AL_EPHEMERAL_TTL_MS;

export type ALReceiptRecordOpeningIssueCode =
    | 'empty-audience'
    | 'audience-over-limit'
    | 'receipt-expired'
    | 'deadline-beyond-window';

export interface ALReceiptRecordOpeningIssue {
    readonly code: ALReceiptRecordOpeningIssueCode;
    readonly message: string;
}

export function validateALReceiptRecordOpening(
    opening: ALReceiptRecordOpening,
    nowMs: number
): readonly ALReceiptRecordOpeningIssue[] {
    const issues: ALReceiptRecordOpeningIssue[] = [];
    const audienceSize = opening.expectedRecipientPeerIds.length;
    if (audienceSize === 0) {
        issues.push({ code: 'empty-audience', message: 'AL receipt record opens with no recipient to confirm it' });
    }
    if (audienceSize > AL_MESSAGE_RESOURCE_LIMITS.collectionEntries) {
        issues.push({
            code: 'audience-over-limit',
            message: 'AL receipt record audience exceeds the message collection limit'
        });
    }
    if (computeALReceiptRetentionExpiryMs(opening.deadlineAtMs) <= nowMs) {
        issues.push({ code: 'receipt-expired', message: 'AL receipt record opens after its receipt has expired' });
    }
    if (opening.deadlineAtMs > nowMs + AL_RECEIPT_RECORD_WINDOW_MS) {
        issues.push({
            code: 'deadline-beyond-window',
            message: 'AL receipt record deadline lies beyond the record window'
        });
    }
    return issues;
}
