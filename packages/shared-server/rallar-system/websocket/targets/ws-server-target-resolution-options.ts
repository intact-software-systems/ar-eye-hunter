import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';

import type { RallarSnapshotPresenceClock } from '../../presence/snapshot-presence.ts';

export interface RallarCrdtPrincipalSnapshotRef {
    readonly applicationId: string;
    readonly workspaceId?: string;
    readonly principalId: string;
}

export interface WsServerTargetResolutionOptions {
    readonly findClientSnapshotByRef?: (
        ref: RallarCrdtPrincipalSnapshotRef,
        message: ALMessage
    ) => ClientSnapshot | undefined;
    readonly findGroupSnapshotByRef?: (
        ref: GroupRef,
        message: ALMessage
    ) => GroupSnapshot | undefined;
    readonly now?: RallarSnapshotPresenceClock;
}
