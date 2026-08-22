import type { RallarAiTransportPolicy } from './rallar-ai-types.ts';

export const RALLAR_AI_DEFAULT_TRANSPORT_POLICY: RallarAiTransportPolicy = {
    delivery: 'ephemeral',
    ordering: 'none',
    acknowledgement: 'none',
    conflictPolicy: 'app-defined'
};

export function defineRallarAiTransportPolicy(
    policy: Partial<RallarAiTransportPolicy> = {}
): RallarAiTransportPolicy {
    return {
        ...RALLAR_AI_DEFAULT_TRANSPORT_POLICY,
        ...policy
    };
}
