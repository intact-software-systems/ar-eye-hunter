import { AL_VOLATILE_SESSION_MAX_AGE_MS } from '@shared/alm/volatile-budget/al-volatile-session-budget.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS } from '../../alm-conformance-budgets.ts';
import { ALM_CONFORMANCE_CARRIERS } from '../../alm-conformance-carriers.ts';
import { toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { toBoundRefusalCommands, toLimitRefusalFacts } from './volatile-bound-commands.ts';

/** A second past the age bound: the send's deadline lies further from now than the session may retain it. */
const BEYOND_AGE_TTL_MS = AL_VOLATILE_SESSION_MAX_AGE_MS + 1_000;

/**
 * D179: under the session's own constants, a send whose deadline lies beyond the age bound ends `rejected` with
 * `refused`/`capacity`, limit `age` and no carrier attempt, and the receiver never receives it. The bound is the
 * constant, so the sender keeps its connection.
 */
export const capacityAge: AlmConformanceScenarioDefinition = {
    scenarioId: 'capacity-age',
    scenarioKey: 'capacity-age',
    tags: FULL_TAGS,
    carriers: ALM_CONFORMANCE_CARRIERS,
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: (sender) => [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier, index: 1 },
            delivery: {
                ack: 'receiver',
                ttlMs: BEYOND_AGE_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        ...toBoundRefusalCommands(sender, 1, toLimitRefusalFacts('age'))
    ],
    toRecipientCommands: (receiver) => [toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true })]
};
