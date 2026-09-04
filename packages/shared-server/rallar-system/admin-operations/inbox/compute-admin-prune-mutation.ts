import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    toPgTimestamp,
    toSystemDate
} from '../../../queuebox/postgres/resource-inbox-row-codec.ts';
import {
    computeAppInboxCompletion,
    validateAppInboxCompletion,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import { toAdminPruneOutbox } from '../prune/admin-prune-page-codec.ts';
import {
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry,
    toAdminPruneAggregateKey
} from '../prune/admin-prune-progress.ts';
import type { AdminPruneCommand } from './admin-prune-command-codec.ts';
import type { AdminPruneEnqueueResult } from './admin-prune-inbox-codec.ts';
import type { AdminPruneValidationIssue } from './admin-prune-inbox-validation.ts';
import type { AdminPruneAuthority } from './app-admin-inbox-service.ts';

export interface AdminPruneRead {
    readonly command: AdminPruneCommand;
    readonly expiredRows: Readonly<Record<AdminPruneExpiredCategory, number>>;
    readonly authority: AdminPruneAuthority;
    readonly nowEpochMs: number;
    readonly serviceId: string;
    readonly completionFacts: AppInboxCompletionFacts;
}

export interface AdminPruneAggregateWrite {
    readonly entry: Readonly<ResourceEntry>;
    readonly systemDate: string;
    readonly createdAt: string;
    readonly expiresAt: string;
}

export interface AdminPruneComputed {
    readonly result: AdminPruneEnqueueResult;
    readonly outboxWrites: readonly AppOutboxInsert[];
    readonly aggregateWrite: AdminPruneAggregateWrite | null;
    readonly completion: AppInboxCompletionComputed<AdminPruneEnqueueResult>;
}

export function computeAdminPruneMutation(read: AdminPruneRead): AdminPruneComputed {
    const command = read.command;
    const result: AdminPruneEnqueueResult = {
        generatedAtEpochMs: command.capturedAtEpochMs,
        serverId: read.serviceId,
        warnings: [],
        operation: 'maintenance.prune-expired',
        status: command.dryRun ? 'dry-run' : 'queued',
        changed: false,
        jobId: command.jobId,
        results: command.categories.map((category) => ({
            category,
            expiredRows: read.expiredRows[category],
            deletedRows: 0,
            dryRun: command.dryRun
        }))
    };
    return {
        result,
        outboxWrites: computeInitialAdminPrunePages(command, read.serviceId),
        aggregateWrite: command.dryRun
            ? null
            : computeAdminPruneAggregateWrite(toAdminPruneAggregateEntry(createAdminPruneAggregate({
                jobId: command.jobId,
                generatedAtEpochMs: command.capturedAtEpochMs,
                expireAtEpochMs: command.expireAtEpochMs,
                serverId: read.serviceId,
                requestedBy: command.requestedBy,
                requestedSessionId: command.requestedSessionId,
                categories: command.categories,
                expiredRows: read.expiredRows
            }))),
        completion: computeAppInboxCompletion({
            ...read.completionFacts,
            durableResult: result,
            status: EntityStatus.COMPLETED
        })
    };
}

export function validateAdminPruneMutation(
    read: AdminPruneRead,
    computed: AdminPruneComputed
): readonly AdminPruneValidationIssue[] {
    const issues: AdminPruneValidationIssue[] = [];
    if (!read.authority.allowed || read.command.expireAtEpochMs <= read.nowEpochMs) {
        issues.push({
            code: 'admin-prune-authority-denied',
            message: 'Admin prune current authority is denied',
            status: 403
        });
    }
    if (
        computed.result.jobId !== read.command.jobId ||
        computed.result.serverId !== read.serviceId ||
        computed.result.status !== (read.command.dryRun ? 'dry-run' : 'queued')
    ) {
        issues.push({
            code: 'admin-prune-computed-identity-invalid',
            message: 'Admin prune computed identity differs from its read facts',
            status: 400
        });
    }
    if (computed.outboxWrites.length !== (read.command.dryRun ? 0 : read.command.categories.length)) {
        issues.push({
            code: 'admin-prune-computed-category-count-invalid',
            message: 'Admin prune computed category count is invalid',
            status: 400
        });
    }
    if (!hasExpectedAggregateWrite(read, computed.aggregateWrite)) {
        issues.push({
            code: 'admin-prune-aggregate-presence-invalid',
            message: 'Admin prune aggregate write differs from its command',
            status: 400
        });
    }
    issues.push(
        ...validateAppInboxCompletion(
            {
                ...read.completionFacts,
                durableResult: computed.result,
                status: EntityStatus.COMPLETED
            },
            computed.completion
        ).map((issue) => ({
            code: 'admin-prune-completion-invalid',
            message: issue.message,
            status: 500
        }))
    );
    return issues;
}

function computeInitialAdminPrunePages(
    command: AdminPruneCommand,
    serviceId: string
): readonly AppOutboxInsert[] {
    if (command.dryRun) {
        return [];
    }
    return command.categories.map((category) =>
        computeAppOutboxInsert(toAdminPruneOutbox({
            kind: 'page',
            jobId: command.jobId,
            category,
            requestedBy: command.requestedBy,
            requestedSessionId: command.requestedSessionId,
            capturedAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: command.expireAtEpochMs,
            pageSize: command.pageSize,
            afterCursor: null,
            pageIndex: 0,
            appData: category === 'app-data' ? command.appData : null
        }, serviceId))
    );
}

function computeAdminPruneAggregateWrite(entry: ResourceEntry): AdminPruneAggregateWrite {
    const snapshot: Readonly<ResourceEntry> = {
        ...entry,
        key: { ...entry.key },
        audit: { ...entry.audit },
        dequeueAudit: { ...entry.dequeueAudit }
    };
    return {
        entry: snapshot,
        systemDate: toSystemDate(snapshot),
        createdAt: toPgTimestamp(snapshot.audit.createdTs),
        expiresAt: toPgTimestamp(snapshot.audit.expiryTs)
    };
}

function hasExpectedAggregateWrite(
    read: AdminPruneRead,
    aggregateWrite: AdminPruneAggregateWrite | null
): boolean {
    if (read.command.dryRun) {
        return aggregateWrite === null;
    }
    if (aggregateWrite === null) {
        return false;
    }
    const expectedKey = toAdminPruneAggregateKey(read.command.jobId);
    return aggregateWrite.entry.key.topicId === expectedKey.topicId &&
        aggregateWrite.entry.key.resourceId === expectedKey.resourceId &&
        aggregateWrite.entry.key.contextId === expectedKey.contextId;
}
