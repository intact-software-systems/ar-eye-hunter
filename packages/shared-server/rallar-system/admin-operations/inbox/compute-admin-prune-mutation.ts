import type { AdminPruneExpiredCategory } from '@shared/api/admin-operations-types.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { toPgTimestamp, toSystemDate } from '../../../queuebox/postgres/resource-inbox-row-codec.ts';

import {
    computeAppInboxCompletion,
    validateAppInboxCompletionFacts,
    type AppInboxCompletionComputed,
    type AppInboxCompletionFacts
} from '../../app-inbox/handler/app-inbox-completion-computation.ts';
import { validateAppInboxComputedProjection } from '../../app-inbox/handler/app-inbox-computed-validation.ts';
import {
    computeAppOutboxInsert,
    type AppOutboxInsert
} from '../../app-outbox/app-outbox-insert.ts';
import { toAdminPruneOutbox } from '../prune/admin-prune-page-codec.ts';
import { createAdminPruneAggregate, toAdminPruneAggregateEntry } from '../prune/admin-prune-progress.ts';
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

export interface AdminPruneComputed {
    readonly result: AdminPruneEnqueueResult;
    readonly outboxWrites: readonly AppOutboxInsert[];
    readonly aggregateWrite: AdminPruneAggregateWrite | null;
    readonly completion: AppInboxCompletionComputed<AdminPruneEnqueueResult>;
}

export interface AdminPruneAggregateWrite {
    readonly resourceId: string;
    readonly topicId: string;
    readonly resource: string;
    readonly typeId: string;
    readonly status: ResourceEntry['status'];
    readonly contextId: string;
    readonly systemDate: string;
    readonly createdBy: string;
    readonly createdAt: string;
    readonly expiresAt: string;
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
    try {
        const expected = computeAdminPruneMutation(read);
        const projectionIssues = validateAppInboxComputedProjection(expected, computed, 'computed');
        issues.push(...projectionIssues.map((issue) => ({
            code: 'admin-prune-computed-value-invalid',
            message: issue.message,
            status: 500
        })));
        if (projectionIssues.length > 0) {
            return issues;
        }
        issues.push(
            ...validateAppInboxCompletionFacts({
                ...read.completionFacts,
                status: EntityStatus.COMPLETED
            }).map((issue) => ({
                code: 'admin-prune-completion-invalid',
                message: issue.message,
                status: 500
            }))
        );
    }
    catch (caught) {
        issues.push({
            code: 'admin-prune-computed-value-invalid',
            message: caught instanceof Error ? caught.message : String(caught),
            status: 500
        });
    }
    return issues;
}

function computeInitialAdminPrunePages(command: AdminPruneCommand, serviceId: string): readonly AppOutboxInsert[] {
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
    return {
        resourceId: entry.key.resourceId,
        topicId: entry.key.topicId,
        resource: entry.resource,
        typeId: entry.typeId,
        status: entry.status,
        contextId: entry.key.contextId,
        systemDate: toSystemDate(entry),
        createdBy: entry.audit.createdBy,
        createdAt: toPgTimestamp(entry.audit.createdTs),
        expiresAt: toPgTimestamp(entry.audit.expiryTs)
    };
}

