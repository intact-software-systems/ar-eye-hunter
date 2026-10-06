/**
 * `recipient-b` is the second, distinguishable recipient of a three-agent scenario. `successor` is a second page
 * in the sender's own browser context: the same storage and auth session under an agent of its own.
 */
export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b', 'successor'] as const;

export type AlmConformanceRole = typeof ALM_CONFORMANCE_ROLES[number];

/** An origin and two distinguishable recipients: every `three-agent` scenario declares these roles. */
export const ALM_CONFORMANCE_THREE_AGENT_ROLES: readonly AlmConformanceRole[] = ['sender', 'receiver', 'recipient-b'];

export function isAlmConformanceRole(value: string): value is AlmConformanceRole {
    return (ALM_CONFORMANCE_ROLES as readonly string[]).includes(value);
}
