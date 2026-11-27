import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';

import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { NON_EXPIRING_SEND_TIMEOUT_MS, NON_EXPIRING_TTL_MS } from '../../alm-conformance-budgets.ts';
import { toControlAdmissionWait } from '../../alm-conformance-diagnostic-waits.ts';
import { toObserveCommand, toResultAssertion, toSendCommand } from '../../alm-conformance-message-commands.ts';
import { toReceivedCommand } from '../../alm-conformance-receiver-commands.ts';
import { ALM_CONFORMANCE_THREE_AGENT_ROLES } from '../../alm-conformance-roles.ts';
import {
    FULL_TAGS,
    type AlmConformanceScenarioDefinition,
    type AlmConformanceStepInput
} from '../../alm-conformance-scenario-definition.ts';
import { toSelfMembershipCommand } from '../../alm-conformance-session-commands.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { resolveAlmCarrierMatrixCellCarriers } from '../../carrier-matrix/resolve-alm-carrier-matrix-cell-carriers.ts';

/** Who refuses the left sender's send where the cell runs, and why, as the matrix states it. */
const FENCED_REFUSAL = ALM_CARRIER_MATRIX['left-sender-send'].cells.ws.outcome;

/**
 * The sender leaves the group, then sends to the room. The WS server, at or beyond the send's roster, finds the
 * sender no longer an active member: it refuses the send and NACKs it `membership-fenced`, and the sender's handle
 * settles rejected by the trusted server for that reason. Neither recipient receives it.
 */
export const fencedRejection: AlmConformanceScenarioDefinition = {
    scenarioId: 'fenced-rejection',
    scenarioKey: 'fenced-rejection',
    tags: FULL_TAGS,
    carriers: resolveAlmCarrierMatrixCellCarriers('fenced-rejection'),
    roles: ALM_CONFORMANCE_THREE_AGENT_ROLES,
    laneFamily: 'three-agent',
    toSenderCommands: toFencedRejectionSenderCommands,
    toRecipientCommands: (recipient) => [toReceivedCommand({ ...recipient, index: 1, count: 1, absent: true })]
};

/**
 * The NACK may settle the handle before an admission read could see it accepted, so the cell reads no admission
 * state: the committed NACK, then the rejected handle and its typed reason.
 */
function toFencedRejectionSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const rejection = [
        ['failure.kind', 'relay-rejected'],
        ['relayRejection.relay', FENCED_REFUSAL.by],
        ['relayRejection.reason', FENCED_REFUSAL.reason]
    ] as const;
    return [
        toSelfMembershipCommand(sender, 'left'),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioKey, carrier: sender.input.carrier },
            delivery: {
                ack: 'receiver',
                reliability: 'at-least-once',
                ttlMs: NON_EXPIRING_TTL_MS,
                commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
            }
        }),
        toControlAdmissionWait({
            step: { ...sender, index: 1 },
            name: 'fenced-nack',
            controlTypeId: AL_CONTROL_NACK_TYPE_ID,
            outcome: 'committed'
        }),
        toObserveCommand({ ...sender, index: 1, state: 'rejected' }),
        ...rejection.map(([field, expected]) =>
            toResultAssertion({
                step: sender,
                name: `assert-${expected}-1`,
                resultName: 'observe-rejected-1',
                field,
                operator: 'equals',
                expected
            })
        )
    ];
}
