import type { GroupCausalRevisionOrder } from '../group-client-views.ts';
import { compareOverlayTopologyCausalTuple, type RallarOverlayTopologySnapshot } from '../overlay-topology.ts';

/**
 * A layout is named by identity, never by a bare version (product decision
 * 29): the planner reuses a version for the removed tombstone and causal
 * revisions can be incomparable, so the tuple plus `state` is the only safe
 * predicate.
 */
export type GroupLayoutIdentity = Readonly<{
    groupRevision: number;
    presenceRevision: number;
    version: number;
    state: RallarOverlayTopologySnapshot['state'];
}>;

export function toGroupLayoutIdentity(
    snapshot: Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version' | 'state'>
): GroupLayoutIdentity {
    return {
        groupRevision: snapshot.sourceGroupStateCausalRevision.groupRevision,
        presenceRevision: snapshot.sourceGroupStateCausalRevision.presenceRevision,
        version: snapshot.version,
        state: snapshot.state
    };
}

export function isSameGroupLayoutIdentity(left: GroupLayoutIdentity, right: GroupLayoutIdentity): boolean {
    return (
        left.groupRevision === right.groupRevision &&
        left.presenceRevision === right.presenceRevision &&
        left.version === right.version &&
        left.state === right.state
    );
}

export type GroupLayoutRole =
    | 'accepted'
    | 'planned'
    | 'superseded'
    | 'incomparable';

export interface ResolveGroupLayoutRoleInput {
    readonly publication: GroupLayoutIdentity;
    /** `undefined` while no layout has ever been accepted. */
    readonly accepted: GroupLayoutIdentity | undefined;
}

/**
 * Classify a publication against the accepted layout identity the group
 * snapshot names. Newer publications are `planned` candidates, older ones are
 * dropped as `superseded`, and `incomparable` is explicit rather than folded
 * into either (product decision 29). At an equal tuple the `state` decides: a
 * removed tombstone is the newer fact for that exact layout — it is the
 * teardown signal — while an active copy arriving after the tombstone is
 * stale.
 */
export function resolveGroupLayoutRole(input: ResolveGroupLayoutRoleInput): GroupLayoutRole {
    if (input.accepted === undefined) {
        return 'planned';
    }
    const order = compareLayoutIdentityTuple(input.publication, input.accepted);
    if (order === 'dominates') {
        return 'planned';
    }
    if (order === 'dominated') {
        return 'superseded';
    }
    if (order === 'incomparable') {
        return 'incomparable';
    }
    if (input.publication.state === input.accepted.state) {
        return 'accepted';
    }
    return input.publication.state === 'removed' ? 'planned' : 'superseded';
}

function compareLayoutIdentityTuple(
    left: GroupLayoutIdentity,
    right: GroupLayoutIdentity
): GroupCausalRevisionOrder {
    return compareOverlayTopologyCausalTuple(toCausalTupleComparand(left), toCausalTupleComparand(right));
}

function toCausalTupleComparand(
    identity: GroupLayoutIdentity
): Pick<RallarOverlayTopologySnapshot, 'sourceGroupStateCausalRevision' | 'version'> {
    return {
        sourceGroupStateCausalRevision: {
            groupRevision: identity.groupRevision,
            presenceRevision: identity.presenceRevision
        },
        version: identity.version
    };
}
