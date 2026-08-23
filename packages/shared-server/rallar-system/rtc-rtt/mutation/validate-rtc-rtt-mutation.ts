import { compareRtcTopologyIdentifiers } from '../../topology/persistence/rtc-topology-identifiers.ts';
import { rtcTopologySemanticEqual } from '../../topology/persistence/rtc-topology-semantic-equal.ts';
import { RTC_RTT_MUTATION_RETENTION_MS } from '../persistence/rtc-rtt-persistence-validation.ts';
import { computeRtcRttMutation } from './compute-rtc-rtt-mutation.ts';
import type {
    RtcRttMutationCommand,
    RtcRttMutationComputed,
    RtcRttMutationFacts,
    RtcRttMutationRead
} from './rtc-rtt-mutation-contracts.ts';
import { validateRtcRttWriteCandidate } from './validate-rtc-rtt-write-candidate.ts';

export function validateRtcRttMutation(
    input: Readonly<{
        command: RtcRttMutationCommand;
        read: RtcRttMutationRead;
        facts: RtcRttMutationFacts;
        computed: RtcRttMutationComputed;
    }>
): void {
    const recomputed = computeRtcRttMutation(input);
    if (!rtcTopologySemanticEqual(recomputed, input.computed)) {
        throw new TypeError('RTC RTT mutation differs from canonical computation');
    }
    if (input.computed.outcome === 'write') {
        validateRtcRttWriteCandidate(
            input.computed,
            input.computed.receipt.acceptedAtEpochMs + RTC_RTT_MUTATION_RETENTION_MS
        );
        const endpointIds = input.computed.endpointGuards.map((guard) => guard.endpointId);
        if (
            !rtcTopologySemanticEqual(endpointIds, [...endpointIds].sort(compareRtcTopologyIdentifiers))
        ) {
            throw new TypeError('RTC RTT endpoint guards are not in lexical order');
        }
    }
}
