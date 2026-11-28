import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { toResultAssertion } from '../../alm-conformance-message-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import {
    toAlmCallRefusalFacts,
    type AlmCarrierCallRefusal
} from '../../carrier-matrix/to-alm-call-refusal-facts.ts';

/** A capability whose cells state, on some carrier, that the product refuses its send at the call. */
type AlmCallRefusalCapabilityId = 'server-peer-unicast';

/**
 * One assertion per fact on the refusal the witnessed first send (`send-1`) returned, read from the cell of
 * `capabilityId` over the carrier the sender runs on.
 */
export function toCallRefusalAssertions(
    sender: AlmConformanceStepInput,
    capabilityId: AlmCallRefusalCapabilityId
): readonly RallarBlackBoxTestCommand[] {
    return toAlmCallRefusalFacts(resolveCallRefusal(sender, capabilityId)).map(([name, field, operator, expected]) =>
        toResultAssertion({
            step: sender,
            name: `assert-${name}-1`,
            resultName: 'send-1',
            field,
            operator,
            expected
        })
    );
}

/** A scenario runs only over the carriers whose cell names it, so a cell that states anything else is a wrong matrix. */
function resolveCallRefusal(
    sender: AlmConformanceStepInput,
    capabilityId: AlmCallRefusalCapabilityId
): AlmCarrierCallRefusal {
    const { carrier } = sender.input;
    const { outcome } = ALM_CARRIER_MATRIX[capabilityId].cells[carrier];
    if (outcome.kind !== 'refused' || outcome.by !== 'call') {
        throw new TypeError(`${sender.scenarioKey} runs over ${carrier}, where ${capabilityId} is no call refusal.`);
    }
    return outcome;
}
