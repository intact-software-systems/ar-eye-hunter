import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import { toConfirmedCueWait } from '../topic-subscription/topic-subscription-publications.ts';
import {
    toGrantedRtcOwnerCommands,
    toRtcArrivalWait,
    type GrantedRtcMemberGrant
} from './granted-rtc-commands.ts';

/** Recipient-b may receive the granted topic, which only its own election makes it do. */
export const RECIPIENT_B_SUBSCRIBES: GrantedRtcMemberGrant = {
    grantee: 'recipient-b',
    publish: false,
    subscribe: true
};

/**
 * The owner grants the room, hears the publication over RTC and holds its election until the sender's loop says one
 * copy confirmed, so no attempt finds it gone from the audience.
 */
export function toConfirmingOwnerCommands(
    owner: AlmConformanceStepInput,
    memberGrants: readonly GrantedRtcMemberGrant[]
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner, memberGrants),
        toRtcArrivalWait(owner),
        toConfirmedCueWait(owner, 'publication'),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}
