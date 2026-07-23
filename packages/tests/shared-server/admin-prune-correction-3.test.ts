import { describe, expect, it } from 'vitest';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import {
    createAdminPruneCommand,
    decodeAdminPruneCommand,
    decodeAdminPruneWork,
    toAdminPruneOutbox,
    type AdminPrunePageWork,
} from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import {
    createAdminPruneAggregate,
    decodeAdminPruneAggregate,
} from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';

describe('Task 9 correction 3 prune invariants', () => {
    it('rejects command expiry at or before its immutable capture cutoff', async () => {
        const command = await createAdminPruneCommand({
            jobId: 'job-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            capturedAtEpochMs: 1_000,
            expireAtEpochMs: 2_000,
            dryRun: false,
            categories: ['runtime-state'],
            appData: null,
            pageSize: 100,
        });

        expect(() => decodeAdminPruneCommand({
            ...command,
            expireAtEpochMs: command.capturedAtEpochMs,
        })).toThrow(/expiry|capture/i);
    });

    it('rejects page zero with a cursor and later pages without one', () => {
        expect(() => decodeAdminPruneWork(reserved(page({
            pageIndex: 0,
            afterCursor: 'forged-cursor',
        })))).toThrow(/cursor|page/i);
        expect(() => decodeAdminPruneWork(reserved(page({
            pageIndex: 1,
            afterCursor: null,
        })))).toThrow(/cursor|page/i);
    });

    it('rejects app-data details on other categories and missing details on app-data', () => {
        expect(() => decodeAdminPruneWork(reserved(page({
            category: 'runtime-state',
            appData: { namespace: 'app-1', storeName: null },
        })))).toThrow(/app-data|category/i);
        expect(() => decodeAdminPruneWork(reserved(page({
            category: 'app-data',
            appData: null,
        })))).toThrow(/app-data|category/i);
    });

    it('rejects aggregate deletion beyond captured expiry statistics', () => {
        const aggregate = createAdminPruneAggregate({
            jobId: 'job-1',
            generatedAtEpochMs: 1_000,
            expireAtEpochMs: 2_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            categories: ['runtime-state'],
            expiredRows: { 'runtime-state': 1 },
        });

        expect(() => decodeAdminPruneAggregate({
            ...aggregate,
            revision: 1,
            status: 'completed',
            changed: true,
            completedCategories: ['runtime-state'],
            results: [{
                category: 'runtime-state',
                expiredRows: 1,
                deletedRows: 2,
                dryRun: false,
            }],
        })).toThrow(/deleted|expired/i);
    });

    it('rejects empty completed aggregates and expiry before generation', () => {
        const empty = {
            version: 1,
            revision: 0,
            jobId: 'job-1',
            generatedAtEpochMs: 1_000,
            expireAtEpochMs: 2_000,
            serverId: 'server-1',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            operation: 'maintenance.prune-expired',
            status: 'completed',
            changed: false,
            warnings: [],
            completedCategories: [],
            results: [],
        };
        expect(() => decodeAdminPruneAggregate(empty)).toThrow(/empty|result|category/i);
        expect(() => decodeAdminPruneAggregate({
            ...empty,
            status: 'pending',
            expireAtEpochMs: 1_000,
            results: [{
                category: 'runtime-state',
                expiredRows: 0,
                deletedRows: 0,
                dryRun: false,
            }],
        })).toThrow(/expiry|generation/i);
    });
});

function page(overrides: Partial<AdminPrunePageWork> = {}): AdminPrunePageWork {
    return {
        kind: 'page',
        jobId: 'job-1',
        category: 'runtime-state',
        requestedBy: 'admin-1',
        requestedSessionId: 'session-1',
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        pageSize: 100,
        afterCursor: null,
        pageIndex: 0,
        appData: null,
        ...overrides,
    };
}

function reserved(work: AdminPrunePageWork): ResourceEntry {
    const entry = toAdminPruneOutbox(work, 'server-1');
    const message = JSON.parse(entry.resource);
    message.payload.resource = JSON.stringify(work);
    return {
        ...entry,
        resource: JSON.stringify(message),
        status: EntityStatus.RESERVED,
        dequeueAudit: { attempts: 1 },
    };
}
