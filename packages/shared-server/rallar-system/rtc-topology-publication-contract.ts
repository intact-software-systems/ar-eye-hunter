import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef } from '@shared/api/group-types.ts';

export type RtcTopologyPublication = Readonly<{
    publicationId: string;
    workId: string;
    groupRef: GroupRef;
    sourceGroupStateRevision: number;
    overlayVersion: number;
    targetGroupSnapshotVersion: number;
    recipientSessionIds: readonly string[];
    message: ALMessage;
    createdAtEpochMs: number;
}>;
