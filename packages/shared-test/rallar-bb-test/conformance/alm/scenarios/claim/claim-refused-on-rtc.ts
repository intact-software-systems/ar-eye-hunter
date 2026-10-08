import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { toClaimRouteCommands, toClaimSendCommand } from './claim-commands.ts';

/** No server stands on the RTC path to arbitrate a claim; under the fallback strategy the browser routes it to WS. */
const CLAIM_REFUSED_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc'];

/**
 * The sender claims the cell's resource over RTC alone: the RTC origin refuses the exclusive send `unsupported` with no
 * carrier attempt, and neither recipient receives it.
 */
export const claimRefusedOnRtc: AlmConformanceScenarioDefinition = {
    scenarioId: 'claim-refused-on-rtc',
    scenarioKey: 'claim-refused-on-rtc',
    tags: FULL_TAGS,
    carriers: CLAIM_REFUSED_CARRIERS,
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => [
        toClaimSendCommand(sender, NON_EXPIRING_TTL_MS),
        ...toClaimRouteCommands(sender)
    ],
    toRecipientCommands: (recipient) => [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
