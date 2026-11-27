import { toSendCommand } from '../../alm-conformance-message-commands.ts';
import { FULL_TAGS, type AlmConformanceScenarioDefinition } from '../../alm-conformance-scenario-definition.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';
import { toCallRefusalAssertions } from './call-refusal-commands.ts';

/**
 * C9 at the call: a send to the WS server's peer under a strategy that leads with RTC is refused by the product's typed
 * send before either carrier admits it, since the server is no RTC peer, and the witnessed send returns that issue.
 * A send to the server reaches no room member however it ends, so the receiver holds no window of its own.
 */
export const serverCommandRefusedAtCall: AlmConformanceScenarioDefinition = {
    scenarioId: 'server-command-refused-at-call',
    scenarioKey: 'server-command-refused-at-call',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('server-command-refused-at-call'),
    roles: ['sender', 'receiver'],
    laneFamily: 'addressed',
    toSenderCommands: (sender) => [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { toPeer: 'server', observe: 'call-refused' }
        }),
        ...toCallRefusalAssertions(sender, 'server-peer-unicast')
    ],
    toRecipientCommands: () => []
};
