import type { RallarBlackBoxTestMessagesSendCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceSendAudience } from '../../alm-conformance-receipt-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import {
    ALM_CONFORMANCE_GRANTED_TOPIC_ID,
    toConnectionName,
    toRoomRef,
    toScenarioTypeId
} from '../../alm-conformance-step-identities.ts';
import { SUBSCRIPTION_COMMAND_TIMEOUT_MS } from './topic-subscription-polls.ts';

interface GrantedSendInput {
    readonly step: AlmConformanceStepInput;
    readonly payload: Readonly<Record<string, string>>;
    /** The track the publication rides; absent, it rides none. */
    readonly orderingKey?: string;
    /** Absent, every granted session of the room. */
    readonly audience?: AlmConformanceSendAudience;
}

/**
 * One receipted publication on the granted topic over the cell's carrier. A minted track names its key and no `seq`:
 * the page's outbound allocates the next sequence of its own track. A send to the receiver alone asks it for its own
 * receipt on a notification channel, the channel an addressed send otherwise opens as a command.
 */
export function toGrantedSend(
    { step, payload, orderingKey, audience }: GrantedSendInput
): Omit<RallarBlackBoxTestMessagesSendCommand, 'commandId'> {
    const addressed = audience !== undefined && 'toPeer' in audience;
    return {
        kind: 'messages.send',
        connection: toConnectionName(step),
        carrier: step.input.carrier,
        typeId: toScenarioTypeId(step),
        topicId: ALM_CONFORMANCE_GRANTED_TOPIC_ID,
        roomRef: toRoomRef(step.input.group),
        payload,
        reliability: 'at-least-once',
        ack: addressed ? 'receiver' : 'all-logical-recipients',
        ttlMs: NON_EXPIRING_TTL_MS,
        timeoutMs: SUBSCRIPTION_COMMAND_TIMEOUT_MS,
        ...(orderingKey === undefined ? {} : { orderingKey }),
        ...audience,
        ...(addressed ? { purpose: 'notification' } : {})
    };
}
