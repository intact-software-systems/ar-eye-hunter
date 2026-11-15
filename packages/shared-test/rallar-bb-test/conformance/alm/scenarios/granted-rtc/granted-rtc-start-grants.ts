import type { AlmConformanceStartGrant } from '../../alm-conformance-scenario-definition.ts';

/** The receiver listens and the sender publishes: the permissions most granted cells start from. */
export const LISTENER_AND_PUBLISHER_START_GRANTS: readonly AlmConformanceStartGrant[] = [
    { grantee: 'receiver', publish: false, subscribe: true },
    { grantee: 'sender', publish: true, subscribe: false }
];

/** The path cells start from the same, with recipient-b, a leaf or the middle of the path, holding `publish` alone. */
export const PATH_START_GRANTS: readonly AlmConformanceStartGrant[] = [
    ...LISTENER_AND_PUBLISHER_START_GRANTS,
    { grantee: 'recipient-b', publish: true, subscribe: false }
];
