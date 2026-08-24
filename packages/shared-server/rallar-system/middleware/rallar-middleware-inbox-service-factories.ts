import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import type { AppAdminInboxService } from '../admin-operations/inbox/app-admin-inbox-service.ts';
import type { AppAuthInboxService } from '../auth/inbox/app-auth-inbox-service.ts';
import type { AppCrdtInboxService } from '../crdt/inbox/app-crdt-inbox-service.ts';

export interface RallarAuthInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export type RallarAuthInboxServiceFactory = (
    input: RallarAuthInboxServiceFactoryInput
) => AppAuthInboxService;

export interface RallarCrdtInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export type RallarCrdtInboxServiceFactory = (
    input: RallarCrdtInboxServiceFactoryInput
) => AppCrdtInboxService;

export interface RallarAdminInboxServiceFactoryInput {
    readonly inboxQueueReader: InboxQueueReader;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly appInboxResilience: ResilienceDto;
    readonly wakeQueueEngine: () => void;
}

export type RallarAdminInboxServiceFactory = (
    input: RallarAdminInboxServiceFactoryInput
) => AppAdminInboxService;
