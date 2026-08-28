export type GroupConnectDenial = 'no-planned-layout' | 'planned-layout-superseded';

/**
 * The two typed `connect` denials (product decision 32): the caller named a
 * planned layout that does not exist or is no longer the current plan, and
 * decides whether to retry against the current identity. Unlike a stale
 * presence disconnect this must never degrade to a silent no-op — the whole
 * fence exists to make that impossible — so it is a thrown conflict carrying
 * its own status and code, the compute-side 409 template
 * (`RtcRttMutationIdempotencyConflictError` precedent), which reaches HTTP
 * untouched.
 */
export class GroupConnectDenialError extends Error {
    readonly status = 409;
    readonly code: `group-connect-${GroupConnectDenial}`;
    readonly denial: GroupConnectDenial;

    constructor(denial: GroupConnectDenial) {
        super(`Group connect was denied: ${denial}`);
        this.name = 'GroupConnectDenialError';
        this.code = `group-connect-${denial}`;
        this.denial = denial;
    }
}
