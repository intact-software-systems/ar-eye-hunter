import type { ALDeliveryLifecycle } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { MatchDelivery } from '../arena-connection-contracts.ts';

export function toMatchDelivery(output: MatchDelivery['output'], lifecycle: ALDeliveryLifecycle): MatchDelivery {
    return {
        output,
        state: lifecycle.state,
        receiptMode: lifecycle.evidence.receiptMode,
        expectedRecipientPeerIds: lifecycle.evidence.expectedRecipientPeerIds,
        confirmedRecipientPeerIds: lifecycle.evidence.confirmedRecipientPeerIds,
        reason: lifecycle.evidence.reason
    };
}
