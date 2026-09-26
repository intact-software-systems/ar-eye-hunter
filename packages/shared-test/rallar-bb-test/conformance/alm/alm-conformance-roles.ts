/** `recipient-b` is the second, distinguishable recipient of a three-agent scenario (D45). */
export const ALM_CONFORMANCE_ROLES = ['sender', 'receiver', 'recipient-b'] as const;

export type AlmConformanceRole = typeof ALM_CONFORMANCE_ROLES[number];

export function isAlmConformanceRole(value: string): value is AlmConformanceRole {
    return (ALM_CONFORMANCE_ROLES as readonly string[]).includes(value);
}
