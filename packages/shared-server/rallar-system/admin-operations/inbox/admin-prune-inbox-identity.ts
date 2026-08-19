import {
  ADMIN_PRUNE_EXPIRED_CATEGORIES,
  type AdminPruneExpiredCategory,
} from '@shared/api/admin-operations-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import type { AdminPruneAppData, AdminPruneCommand } from '../AdminPruneExpiredWork.ts';
import { AppInboxIdempotencyConflictError } from '../../services/AppInboxService.ts';
import { type AppInboxMessageContext, AppInboxType } from '../../services/app-inbox-contracts.ts';
import { toAppInboxQueueKey } from '../../services/app-inbox-queue-key.ts';
import { hashCanonicalCommand } from '../../services/canonical-command-hash.ts';

export const ADMIN_APP_INBOX_TOPIC = 'app-inbox.admin-operations';

export interface AdminPruneIdempotencyIdentityInput {
  readonly requestId: string;
  readonly requestedBy: string;
  readonly requestedSessionId: string;
  readonly categories: readonly AdminPruneExpiredCategory[];
  readonly appData: AdminPruneAppData | null;
  readonly dryRun: boolean;
}

export interface AdminPruneIdempotencyIdentity extends AdminPruneIdempotencyIdentityInput {
  readonly version: 1;
  readonly semanticHash: string;
}

export interface AdminPruneTimingIdentity {
  readonly requestId: string;
  readonly requestedBy: string;
  readonly requestedSessionId: string;
}

export async function createAdminPruneIdempotencyIdentity(
  input: AdminPruneIdempotencyIdentityInput,
): Promise<AdminPruneIdempotencyIdentity> {
  return {
    version: 1,
    ...input,
    semanticHash: await hashCanonicalCommand({
      ...input,
      categories: ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) =>
        input.categories.includes(category),
      ),
    }),
  };
}

export function toAdminPruneQueueKey(identity: AdminPruneIdempotencyIdentityInput): Key {
  return toAppInboxQueueKey({
    topicId: ADMIN_APP_INBOX_TOPIC,
    resourceId: identity.requestId,
    contextId: identity.requestedBy,
  });
}

export function toAdminPruneTimingIdentity(
  identity: AdminPruneTimingIdentity | AdminPruneCommand,
): AdminPruneTimingIdentity {
  return 'jobId' in identity
    ? {
        requestId: identity.jobId,
        requestedBy: identity.requestedBy,
        requestedSessionId: identity.requestedSessionId,
      }
    : identity;
}

export function assertMatchingAdminPruneIdentity(
  identity: AdminPruneIdempotencyIdentity,
  command: AdminPruneCommand,
): void {
  const matches =
    identity.requestId === command.jobId &&
    identity.requestedBy === command.requestedBy &&
    identity.requestedSessionId === command.requestedSessionId &&
    identity.dryRun === command.dryRun &&
    identity.categories.length === command.categories.length &&
    identity.categories.every((category) => command.categories.includes(category)) &&
    JSON.stringify(identity.appData) === JSON.stringify(command.appData);
  if (!matches) {
    throw new AppInboxIdempotencyConflictError(
      identity.requestId,
      command.commandHash,
      identity.semanticHash,
    );
  }
}

export function assertAdminPruneStoredIdentity(
  key: Key,
  enqueue: Readonly<{
    readonly topicId?: string;
    readonly resourceId?: string;
    readonly contextId?: string;
    readonly senderId?: string;
  }>,
  command: AdminPruneCommand,
): void {
  if (
    enqueue.topicId !== key.topicId ||
    enqueue.resourceId !== key.resourceId ||
    enqueue.contextId !== key.contextId ||
    enqueue.senderId !== command.requestedSessionId ||
    command.jobId !== key.resourceId ||
    command.requestedBy !== key.contextId
  ) {
    throw new AppInboxIdempotencyConflictError(
      key.resourceId,
      command.commandHash,
      'invalid-received-command',
    );
  }
}

export function assertAdminPruneQueueIdentity(
  command: AdminPruneCommand,
  context: AppInboxMessageContext,
): void {
  if (
    context.enqueue.type !== AppInboxType.ADMIN_PRUNE_EXPIRED ||
    context.entry.key.topicId !== ADMIN_APP_INBOX_TOPIC ||
    context.entry.key.resourceId !== command.jobId ||
    context.entry.key.contextId !== command.requestedBy ||
    context.enqueue.senderId !== command.requestedSessionId
  ) {
    throw new TypeError('Admin prune AppInbox identity differs from queue key');
  }
}
