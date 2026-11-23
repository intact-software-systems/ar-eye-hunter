import { toALOutboundReceiptClasses } from '../outbound/control/to-al-outbound-receipt-classes.ts';
import { isALOutboundReceiptComplete } from '../outbound/transition-al-outbound-pending-ack.ts';

import type { ALReceiptRecordConfirmation, ALReceiptRecordHead } from './al-receipt-record-rows.ts';

export interface ALReceiptRecordTally {
    readonly confirmedRecipientPeerIds: readonly string[];
    readonly outsideAudienceRecipientPeerIds: readonly string[];
    readonly complete: boolean;
}

export function computeALReceiptRecordTally(
    head: ALReceiptRecordHead,
    confirmations: readonly ALReceiptRecordConfirmation[]
): ALReceiptRecordTally {
    if (head.phase !== 'open') {
        return {
            confirmedRecipientPeerIds: head.confirmedRecipientPeerIds,
            outsideAudienceRecipientPeerIds: head.outsideAudienceRecipientPeerIds,
            complete: head.phase === 'complete'
        };
    }
    const beforeDeadline = confirmations.filter(({ countedAtEpochMs }) => countedAtEpochMs < head.opening.deadlineAtMs);
    const toRecipientPeerIds = (kind: ALReceiptRecordConfirmation['kind']) =>
        beforeDeadline.filter((confirmation) => confirmation.kind === kind).map(({ recipientPeerId }) =>
            recipientPeerId
        );
    const receipt = {
        expectedPeerIds: [...new Set(head.opening.expectedRecipientPeerIds)],
        ackedPeerIds: toRecipientPeerIds('confirmed'),
        outsideAudiencePeerIds: toRecipientPeerIds('outside')
    };
    const classes = toALOutboundReceiptClasses(receipt);
    return {
        confirmedRecipientPeerIds: classes.confirmedPeerIds,
        outsideAudienceRecipientPeerIds: classes.outsideAudiencePeerIds,
        complete: isALOutboundReceiptComplete(receipt)
    };
}
