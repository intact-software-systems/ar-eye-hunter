import type { GroupTopologyConfigPatch } from '@shared/api/graph-topology-management-types.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

import type { AppOutboxInsert } from '../../app-outbox/app-outbox-insert.ts';
import type * as persistence from '../../group-state/persistence/group-state-persistence-contracts.ts';
import type { ComputedRtcTopologyOutbox } from '../mutation/rtc-topology-outbox-entry.ts';
import type { GroupTopologyPlanningAuthority } from '../planning/group-topology-planning-authority.ts';

export interface GroupTopologyReconfigureCommand {
    readonly groupRef: GroupRef;
    readonly commandId: string;
    readonly actorPrincipalId: string;
    readonly capturedAtEpochMs: number;
    readonly requestOptions: GroupTopologyConfigPatch;
    readonly publish: boolean;
}

export interface GroupTopologyReconfigureRead {
    readonly authority: GroupTopologyPlanningAuthority;
    readonly authorityGuard: persistence.GroupStateAuthorityGuard;
    readonly actorIsPlatformAdmin: boolean;
}

export interface GroupTopologyReconfigureValidationIssue {
    readonly code: string;
    readonly path: readonly (string | number)[];
    readonly message: string;
    readonly cause: Error;
}

export interface GroupTopologyReconfigureAuthorityWrite {
    readonly namespace: string;
    readonly key: string;
    readonly value: string;
    readonly expireAtIsoTimestamp: string;
    readonly expectedRevision: number;
    readonly expectedResultRevision: number;
}

export type GroupTopologyReconfigureComputed =
    & ComputedRtcTopologyOutbox
    & Readonly<{
        authorityGuard: persistence.GroupStateAuthorityGuard;
        authorityWrite: GroupTopologyReconfigureAuthorityWrite;
        outboxWrite: AppOutboxInsert;
    }>;
