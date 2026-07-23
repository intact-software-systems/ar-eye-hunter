import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';
import type { AppAdminInboxService } from '../services/AppAdminInboxService.ts';
import type { AppCrdtInboxService } from '../services/AppCrdtInboxService.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';
import type { RallarSnapshotPresenceClock } from '../snapshot-presence.ts';

export type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';
export type { AppAdminInboxService } from '../services/AppAdminInboxService.ts';
export type { AppCrdtInboxService } from '../services/AppCrdtInboxService.ts';

export type RallarAuthInboxServiceFactory = (
    input: Readonly<{
        inboxQueueReader: InboxQueueReader;
        appInboxResilience: ResilienceDto;
    }>,
) => AppAuthInboxService;

export type RallarCrdtInboxServiceFactory = (
    input: Readonly<{
        inboxQueueReader: InboxQueueReader;
        appInboxResilience: ResilienceDto;
    }>,
) => AppCrdtInboxService;

export type RallarAdminInboxServiceFactory = (
    input: Readonly<{
        inboxQueueReader: InboxQueueReader;
        outboxQueueReader: OutboxQueueReader;
        appInboxResilience: ResilienceDto;
        wakeQueueEngine: () => void;
    }>,
) => AppAdminInboxService;

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
