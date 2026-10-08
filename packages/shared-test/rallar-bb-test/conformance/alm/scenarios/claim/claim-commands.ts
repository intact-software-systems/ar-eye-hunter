import type { RallarBlackBoxTestCommand } from '../../../../rallar-black-box-test-contracts.ts';

import { RESPONSE_MARGIN_MS } from '../../alm-conformance-budgets.ts';
import type { AlmConformanceCarrier } from '../../alm-conformance-carriers.ts';
import { toVerdictCommands, type AlmConformanceVerdictFact } from '../../alm-conformance-message-commands.ts';
import { toAudienceSendCommand, type AlmConformanceSendClaim } from '../../alm-conformance-receipt-commands.ts';
import type { AlmConformanceStepInput } from '../../alm-conformance-scenario-definition.ts';
import { toCommandId, toConnectionName, toScenarioTypeId } from '../../alm-conformance-step-identities.ts';
import { RTC_REFUSAL_FACTS, WS_ROUTE_FACTS } from '../audiences/world-routing.ts';

/** Only the WS server arbitrates a claim; a strategy that allows WS routes an exclusive send there at once. */
export const CLAIM_WS_ROUTE_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc-with-ws-fallback'];

/** The trusted server NACKs a claim another session holds after the frame left, which settles the send's one attempt. */
const HELD_BY_OTHER_FACTS: readonly AlmConformanceVerdictFact[] = [
    ['relay-rejected', 'failure.kind', 'equals', 'relay-rejected'],
    ['trusted-server', 'failure.rejection.relay', 'equals', 'trusted-server'],
    ['held-by-other', 'failure.rejection.reason', 'equals', 'held-by-other'],
    ['one-attempt', 'attempts', 'equals', 1]
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

/** An exclusive send takes the route a world send takes: WS at once where the strategy allows it, refused on RTC. */
export function toClaimRouteCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return step.input.carrier === 'rtc'
        ? toVerdictCommands(step, 'rejected', RTC_REFUSAL_FACTS)
        : toVerdictCommands(step, 'acknowledged', WS_ROUTE_FACTS);
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
