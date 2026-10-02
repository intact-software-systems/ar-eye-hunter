/**
 * `recipient-b` is the second, distinguishable recipient of a three-agent scenario. `successor` is a second page
 * in the sender's own browser context: the same storage and auth session under an agent of its own.
 */
export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b', 'successor'] as const;

export type AlmConformanceRole = typeof ALM_CONFORMANCE_ROLES[number];

export function isAlmConformanceRole(value: string): value is AlmConformanceRole {
    return (ALM_CONFORMANCE_ROLES as readonly string[]).includes(value);
}
