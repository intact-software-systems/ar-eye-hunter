import { NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { toVerdictCommands } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toAlmCarrierOutcomeFacts } from '../../carrier-matrix/to-alm-carrier-outcome-facts.ts';
import { toClaimSendCommand } from './claim-commands.ts';

/**
 * The sender claims the cell's resource over RTC alone, where no server stands on the path to arbitrate a claim: the
 * RTC origin refuses the exclusive send `unsupported` with no carrier attempt, and neither recipient receives it.
 */
export const claimRefusedOnRtc: AlmConformanceScenarioDefinition = {
    scenarioId: 'claim-refused-on-rtc',
    scenarioKey: 'claim-refused-on-rtc',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('claim-refused-on-rtc'),
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: (sender) => [
        toClaimSendCommand(sender, NON_EXPIRING_TTL_MS),
        ...toVerdictCommands(
            sender,
            'rejected',
            toAlmCarrierOutcomeFacts(ALM_CARRIER_MATRIX['exclusive-claim'].cells.rtc.outcome)
        )
    ],
    toRecipientCommands: (recipient) => [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};
