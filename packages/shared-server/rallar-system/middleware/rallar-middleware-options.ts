import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { ClientSnapshot } from '@shared/api/client-types.ts';
import type { ResilienceDto } from '@shared/queuebox/DequeueResourceEntryController.ts';
import type { InboxQueueReader } from '@shared/services/InboxQueueReader.ts';
import type { OutboxQueueReader } from '@shared/services/OutboxQueueReader.ts';

import type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';
import type { AppAdminInboxService } from '../services/AppAdminInboxService.ts';
import type { AppCrdtInboxService } from '../crdt/inbox/app-crdt-inbox-service.ts';
import type { RallarSnapshotPresenceClock } from '../snapshot-presence.ts';

export type { AppAuthInboxService } from '../services/AppAuthInboxService.ts';
export type { AppAdminInboxService } from '../services/AppAdminInboxService.ts';
export type { AppCrdtInboxService } from '../crdt/inbox/app-crdt-inbox-service.ts';

export interface RallarAuthInboxServiceFactoryInput {
  readonly inboxQueueReader: InboxQueueReader;
  readonly appInboxResilience: ResilienceDto;
  readonly wakeQueueEngine: () => void;
}

export type RallarAuthInboxServiceFactory = (
  input: RallarAuthInboxServiceFactoryInput,
) => AppAuthInboxService;

export interface RallarCrdtInboxServiceFactoryInput {
  readonly inboxQueueReader: InboxQueueReader;
  readonly outboxQueueReader: OutboxQueueReader;
  readonly appInboxResilience: ResilienceDto;
  readonly wakeQueueEngine: () => void;
}

export type RallarCrdtInboxServiceFactory = (
  input: RallarCrdtInboxServiceFactoryInput,
) => AppCrdtInboxService;

export interface RallarAdminInboxServiceFactoryInput {
  readonly inboxQueueReader: InboxQueueReader;
  readonly outboxQueueReader: OutboxQueueReader;
  readonly appInboxResilience: ResilienceDto;
  readonly wakeQueueEngine: () => void;
}

export type RallarAdminInboxServiceFactory = (
  input: RallarAdminInboxServiceFactoryInput,
) => AppAdminInboxService;

export interface RallarCrdtPrincipalSnapshotRef {
  readonly applicationId: string;
  readonly workspaceId?: string;
  readonly principalId: string;
}

export interface RallarGroupSnapshotResolverOptions {
  readonly findClientSnapshotByRef?: (
    ref: RallarCrdtPrincipalSnapshotRef,
    message: ALMessage,
  ) => ClientSnapshot | undefined;
  readonly findGroupSnapshotByRef?: (
    ref: GroupRef,
    message: ALMessage,
  ) => GroupSnapshot | undefined;
  readonly findGroupSnapshotById?: (groupId: string) => GroupSnapshot | undefined;
  readonly resolveGroupRef?: (groupId: string, message: ALMessage) => GroupRef | undefined;
  readonly now?: RallarSnapshotPresenceClock;
}
