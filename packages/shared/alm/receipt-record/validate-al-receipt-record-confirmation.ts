import type { ALReceiptRecordRef } from './al-receipt-record-keys.ts';
import type { ALReceiptRecordHead } from './al-receipt-record-rows.ts';

export interface ALReceiptRecordConfirmationDto extends ALReceiptRecordRef {
    readonly recipientPeerId: string;
    readonly kind: 'confirmed' | 'outside';
}

export type ALReceiptRecordConfirmationIssueCode = 'head-ended' | 'outside-frozen-audience' | 'deadline-expired';

export interface ALReceiptRecordConfirmationIssue {
    readonly code: ALReceiptRecordConfirmationIssueCode;
    readonly message: string;
}

export function validateALReceiptRecordConfirmation(
    head: ALReceiptRecordHead,
    confirmation: ALReceiptRecordConfirmationDto,
    nowMs: number
): readonly ALReceiptRecordConfirmationIssue[] {
    const issues: ALReceiptRecordConfirmationIssue[] = [];
    if (head.phase !== 'open') {
        issues.push({ code: 'head-ended', message: 'AL acknowledgement names a receipt that has already ended' });
    }
    if (!head.opening.expectedRecipientPeerIds.includes(confirmation.recipientPeerId)) {
        issues.push({
            code: 'outside-frozen-audience',
            message: 'AL acknowledgement confirms no recipient of the frozen audience'
        });
    }
    if (head.phase === 'open' && head.opening.deadlineAtMs <= nowMs) {
        issues.push({ code: 'deadline-expired', message: 'AL acknowledgement arrived after its receipt deadline' });
    }
    return issues;
}
