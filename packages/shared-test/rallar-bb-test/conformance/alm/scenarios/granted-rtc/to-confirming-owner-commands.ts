import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toUnsubscribeCommands } from '../topic-subscription/topic-subscription-commands.ts';
import { toConfirmedCueWait } from '../topic-subscription/topic-subscription-publications.ts';
import { toGrantedRtcOwnerCommands, toRtcArrivalWait } from './granted-rtc-commands.ts';

/**
 * The owner hears the publication over RTC and holds its election until the sender's loop says one copy confirmed, so
 * no attempt finds it gone from the audience.
 */
export function toConfirmingOwnerCommands(owner: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toGrantedRtcOwnerCommands(owner),
        toRtcArrivalWait(owner),
        toConfirmedCueWait(owner, 'publication'),
        ...toUnsubscribeCommands(owner, 'receiver')
    ];
}
