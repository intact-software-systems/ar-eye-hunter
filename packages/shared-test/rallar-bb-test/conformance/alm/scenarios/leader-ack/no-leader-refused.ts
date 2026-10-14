import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toAudienceSendCommand } from '../../alm-conformance-receipt-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import {
    toDirectorResignCommand,
    toLeaderActivityWait,
    toNoLeaderVerdictCommands
} from './leader-ack-commands.ts';

/** The refusal is no fallback trigger (D165): the fallback carrier's rtc leg refuses as `rtc` does. */
const NO_LEADER_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc'];

/**
 * The receiver resigns any appointment of its own session; once the sender's own snapshot reads no active director,
 * the sender's room send asks for the leader. It ends rejected, refused `no-leader`, and neither recipient receives
 * it.
 */
export const noLeaderRefused: AlmConformanceScenarioDefinition = {
    scenarioId: 'no-leader-refused',
    scenarioKey: 'no-leader-refused',
    tags: FULL_TAGS,
    carriers: NO_LEADER_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => [
        toLeaderActivityWait(sender, false),
        toAudienceSendCommand({ sender, ttlMs: NON_EXPIRING_TTL_MS, ack: 'group-leader' }),
        ...toNoLeaderVerdictCommands(sender)
    ],
    toRecipientCommands: (recipient) => [
        ...(recipient.role === 'receiver' ? [toDirectorResignCommand(recipient)] : []),
        toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })
    ]
};
