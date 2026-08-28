import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef, GroupSnapshot, GroupStateCausalRevision } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';

export type GroupTopologyPublisher = (
    message: ALMessage,
    snapshot: RallarOverlayTopologySnapshot
) => number | Promise<number>;

export type GroupTopologyGroupSnapshotReader = (
    ref: GroupRef,
    options?: Readonly<{
        minSnapshotVersion?: number;
        minCausalRevision?: GroupStateCausalRevision;
    }>
) => GroupSnapshot | undefined | Promise<GroupSnapshot | undefined>;

export interface ReconfigureGroupTopologyInput {
    readonly groupRef: GroupRef;
    readonly groupSnapshot?: GroupSnapshot;
    readonly requestOptions?: GroupTopologyConfigPatch;
    readonly publish?: boolean;
    readonly publisher?: GroupTopologyPublisher;
}

/**
 * The stage-keyed planning gate's outcome (plan slice 4b): `planned` carries
 * the candidate to commit and publish — a removal tombstone is a planned
 * publication too — while `frozen` carries the stored layout the stage
 * refuses to replace, and nothing may be written or published for it.
 */
export type ReconcileGroupTopologyResult =
    | Readonly<{
        action: 'planned';
        snapshot: RallarOverlayTopologySnapshot;
        previous: RallarOverlayTopologySnapshot | null;
        changed: boolean;
    }>
    | Readonly<{
        action: 'frozen';
        current: RallarOverlayTopologySnapshot;
    }>;
