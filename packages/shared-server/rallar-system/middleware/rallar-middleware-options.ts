import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';
import type { RallarSnapshotPresenceClock } from '../snapshot-presence.ts';

export type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';

export type RallarAuthInboxServiceFactory = (
    input: Readonly<{
        inboxQueueReader: InboxQueueReader;
        appInboxResilience: ResilienceDto;
    }>,
) => AppAuthInboxService;

export type RallarGroupSnapshotResolverOptions = Readonly<{
    findGroupSnapshotByRef?: (
        ref: GroupRef,
        message: ALMessage,
    ) => GroupSnapshot | undefined;
    findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
    resolveGroupRef?: (
        groupId: string,
        message: ALMessage,
    ) => GroupRef | undefined;
    now?: RallarSnapshotPresenceClock;
}>;
