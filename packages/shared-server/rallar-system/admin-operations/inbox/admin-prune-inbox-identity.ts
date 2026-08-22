import { ADMIN_PRUNE_EXPIRED_CATEGORIES, type AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

import { AppInboxType, type AppInboxMessageContext } from '../../services/app-inbox-contracts.ts';
import { toStrictAppInboxQueueKey } from '../../services/app-inbox-queue-key.ts';
import { AppInboxIdempotencyConflictError } from '../../services/AppInboxService.ts';
import { hashCanonicalCommand } from '../../services/canonical-command-hash.ts';
import type { AdminPruneAppData, AdminPruneCommand } from './admin-prune-command-codec.ts';

export const ADMIN_APP_INBOX_TOPIC = AppInboxType.ADMIN_PRUNE_EXPIRED;
export const LEGACY_ADMIN_APP_INBOX_TOPIC = 'app-inbox.admin-operations';

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
    readonly contextId: string;
    readonly jobId: string;
    readonly semanticHash: string;
}

export interface AdminPruneTimingIdentity {
    readonly requestId: string;
    readonly requestedBy: string;
    readonly requestedSessionId: string;
}

export async function createAdminPruneIdempotencyIdentity(
    input: AdminPruneIdempotencyIdentityInput
): Promise<AdminPruneIdempotencyIdentity> {
    const categories = ADMIN_PRUNE_EXPIRED_CATEGORIES.filter((category) => input.categories.includes(category));
    const key = toStrictAppInboxQueueKey({
        topicId: ADMIN_APP_INBOX_TOPIC,
        resourceId: input.requestId,
        contextId: toAdminPruneContextId(input.requestedBy, input.appData)
    });
    return {
        version: 1,
        ...input,
        contextId: key.contextId,
        jobId: await toAdminPruneJobId(key),
        semanticHash: await hashCanonicalCommand({
            version: 1,
            categories,
            appData: input.appData,
            dryRun: input.dryRun
        })
    };
}

export function toAdminPruneQueueKey(identity: AdminPruneIdempotencyIdentityInput): Key {
    return toStrictAppInboxQueueKey({
        topicId: ADMIN_APP_INBOX_TOPIC,
        resourceId: identity.requestId,
        contextId: 'contextId' in identity && typeof identity.contextId === 'string'
            ? identity.contextId
            : toAdminPruneContextId(identity.requestedBy, identity.appData)
    });
}

export function toAdminPruneTimingIdentity(
    identity: AdminPruneTimingIdentity | AdminPruneCommand
): AdminPruneTimingIdentity {
    return 'jobId' in identity
        ? {
            requestId: identity.jobId,
            requestedBy: identity.requestedBy,
            requestedSessionId: identity.requestedSessionId
        }
        : identity;
}

export function assertMatchingAdminPruneIdentity(
    identity: AdminPruneIdempotencyIdentity,
    command: AdminPruneCommand
): void {
    const matches = identity.jobId === command.jobId &&
        identity.requestedBy === command.requestedBy &&
        identity.dryRun === command.dryRun &&
        identity.categories.length === command.categories.length &&
        identity.categories.every((category) => command.categories.includes(category)) &&
        JSON.stringify(identity.appData) === JSON.stringify(command.appData);
    if (!matches) {
        throw new AppInboxIdempotencyConflictError(
            identity.requestId,
            command.commandHash,
            identity.semanticHash
        );
    }
}

export async function assertAdminPruneStoredIdentity(
    key: Key,
    enqueue: Readonly<{
        readonly topicId?: string;
        readonly resourceId?: string;
        readonly contextId?: string;
        readonly senderId?: string;
    }>,
    command: AdminPruneCommand
): Promise<void> {
    if (
        enqueue.topicId !== key.topicId ||
        enqueue.resourceId !== key.resourceId ||
        enqueue.contextId !== key.contextId ||
        enqueue.senderId !== command.requestedSessionId ||
        command.jobId !== (await toAdminPruneJobId(key))
    ) {
        throw new AppInboxIdempotencyConflictError(
            key.resourceId,
            command.commandHash,
            'invalid-received-command'
        );
    }
}

export async function assertAdminPruneQueueIdentity(
    command: AdminPruneCommand,
    context: AppInboxMessageContext
): Promise<void> {
    const strictContextId = toStrictAppInboxQueueKey({
        topicId: ADMIN_APP_INBOX_TOPIC,
        resourceId: context.entry.key.resourceId,
        contextId: toAdminPruneContextId(command.requestedBy, command.appData)
    }).contextId;
    const strictIdentity = command.jobId === (await toAdminPruneJobId(context.entry.key)) &&
        context.entry.key.contextId === strictContextId;
    const legacyIdentity = command.jobId === context.entry.key.resourceId &&
        command.requestedBy === context.entry.key.contextId;
    if (
        context.enqueue.type !== AppInboxType.ADMIN_PRUNE_EXPIRED ||
        !(
            (context.entry.key.topicId === ADMIN_APP_INBOX_TOPIC && strictIdentity) ||
            (context.entry.key.topicId === LEGACY_ADMIN_APP_INBOX_TOPIC && legacyIdentity)
        ) ||
        context.enqueue.senderId !== command.requestedSessionId
    ) {
        throw new TypeError('Admin prune AppInbox identity differs from queue key');
    }
}

export function toAdminPruneContextId(
    requestedBy: string,
    appData: AdminPruneAppData | null
): string {
    return [
        ['caller', requestedBy],
        ['app-data-namespace', appData?.namespace ?? ''],
        ['app-data-store', appData?.storeName ?? '']
    ]
        .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
        .join(':');
}

export async function toAdminPruneJobId(key: Key): Promise<string> {
    const digest = await hashCanonicalCommand({
        domain: 'admin-prune-job.v1',
        topicId: key.topicId,
        contextId: key.contextId,
        resourceId: key.resourceId
    });
    return `admin-prune:${digest.slice('sha256:'.length)}`;
}
