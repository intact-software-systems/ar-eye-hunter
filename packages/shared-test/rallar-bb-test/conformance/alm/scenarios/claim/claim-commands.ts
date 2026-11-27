import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import {
    toVerdictCommands,
    type AlmConformanceVerdictFact
} from '../../alm-conformance-message-commands.ts';
import { toAudienceSendCommand, type AlmConformanceSendClaim } from '../../alm-conformance-receipt-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toConnectionName, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { ALM_CARRIER_MATRIX } from '../../carrier-matrix/alm-carrier-matrix.ts';
import { toAlmCarrierOutcomeFacts } from '../../carrier-matrix/to-alm-carrier-outcome-facts.ts';

/**
 * Only the WS server arbitrates a claim, so a claim's one attempt is the WS one wherever a claim is sent at all. The
 * fallback strategy routes an exclusive send there at once, which is the matrix cell these facts are read from; under
 * `ws` there is no other carrier.
 */
export const CLAIM_WS_ROUTE_FACTS: readonly AlmConformanceVerdictFact[] = toAlmCarrierOutcomeFacts(
    ALM_CARRIER_MATRIX['exclusive-claim'].cells['rtc-with-ws-fallback'].outcome
);

/**
 * The trusted server NACKs a claim another session holds after the frame left, which settles the send's one attempt:
 * the WS one, with no hand-over.
 */
const HELD_BY_OTHER_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['relay-rejected', 'failure.kind', 'equals', 'relay-rejected'],
    ['trusted-server', 'failure.rejection.relay', 'equals', 'trusted-server'],
    ['held-by-other', 'failure.rejection.reason', 'equals', 'held-by-other'],
    ...CLAIM_WS_ROUTE_FACTS
];

/** The cell's carrier names the resource, so no cell claims a key another carrier's cell may still hold. */
export function toClaim(step: AlmConformanceStepInput): AlmConformanceSendClaim {
    return { ownership: 'exclusive', resourceId: `claim-${step.input.carrier}-${step.scenarioKey}` };
}

/** The step's own page claims the cell's resource with a room send every other session confirms. */
export function toClaimSendCommand(step: AlmConformanceStepInput, ttlMs: number): RallarBlackBoxTestCommand {
    return toAudienceSendCommand({ sender: step, ttlMs, ack: 'all-logical-recipients', claim: toClaim(step) });
}

/** The claim send ends rejected: the trusted server NACKed it `held-by-other` and nobody receives it. */
export function toHeldByOtherVerdictCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return toVerdictCommands(step, 'rejected', HELD_BY_OTHER_FACTS);
}

/**
 * The step's own page holds `windowMs` before it claims, reading that no second copy of its cell arrives meanwhile:
 * the one it has received is the earlier claim, whose lifetime the window outlasts.
 */
export function toClaimExpiryWait(step: AlmConformanceStepInput, windowMs: number): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.received',
        commandId: toCommandId(step, 'await-claim-expiry'),
        connection: toConnectionName(step),
        typeId: toScenarioTypeId(step),
        count: 2,
        absent: true,
        windowMs,
        timeoutMs: windowMs + RESPONSE_MARGIN_MS
    };
}
