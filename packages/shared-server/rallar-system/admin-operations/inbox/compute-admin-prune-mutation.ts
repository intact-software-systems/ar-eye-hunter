import { Temporal } from '@js-temporal/polyfill';

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
import {
    validateComputedData,
    validateComputedProjection
} from '../../validation/computed-data-validation.ts';
import { toAdminPruneOutbox } from '../prune/admin-prune-page-codec.ts';
import {
    createAdminPruneAggregate,
    toAdminPruneAggregateEntry
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
    readonly replaceExpiredAt: string;
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
            : computeAdminPruneAggregateWrite(
                toAdminPruneAggregateEntry(createAdminPruneAggregate({
                    jobId: command.jobId,
                    generatedAtEpochMs: command.capturedAtEpochMs,
                    expireAtEpochMs: command.expireAtEpochMs,
                    serverId: read.serviceId,
                    requestedBy: command.requestedBy,
                    requestedSessionId: command.requestedSessionId,
                    categories: command.categories,
                    expiredRows: read.expiredRows
                })),
                read.nowEpochMs
            ),
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
    const expected = computeAdminPruneMutation(read);
    const dataIssues = validateComputedData(computed, 'computed');
    if (dataIssues.length > 0) {
        return dataIssues.map((issue) => ({
            code: 'admin-prune-computed-persistence-invalid',
            message: issue.message,
            status: 400
        }));
    }
    if (!read.authority.allowed || read.command.expireAtEpochMs <= read.nowEpochMs) {
        issues.push({
            code: 'admin-prune-authority-denied',
            message: 'Admin prune current authority is denied',
            status: 403
        });
    }
    issues.push(
        ...validateComputedProjection(expected.result, computed.result, 'computed.result').map((issue) => ({
            code: 'admin-prune-computed-identity-invalid',
            message: issue.message,
            status: 400
        }))
    );
    issues.push(
        ...validateComputedProjection(
            {
                outboxWrites: expected.outboxWrites,
                aggregateWrite: expected.aggregateWrite
            },
            {
                outboxWrites: computed.outboxWrites,
                aggregateWrite: computed.aggregateWrite
            },
            'computed.persistence'
        ).map((issue) => ({
            code: 'admin-prune-computed-persistence-invalid',
            message: issue.message,
            status: 400
        }))
    );
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

function computeAdminPruneAggregateWrite(
    entry: ResourceEntry,
    replaceExpiredAtEpochMs: number
): AdminPruneAggregateWrite {
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
        expiresAt: toPgTimestamp(snapshot.audit.expiryTs),
        replaceExpiredAt: toPgTimestamp(Temporal.Instant.fromEpochMilliseconds(replaceExpiredAtEpochMs))
    };
}
