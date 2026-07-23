import { describe, expect, it } from 'vitest';
import {
    DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS,
    RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS,
} from '@shared/queuebox/ResourceInboxRetryPolicy.ts';
import {
    AdminPruneExpiredWork,
    type AdminPrunePageWork,
} from '@shared-server/rallar-system/admin-operations/AdminPruneExpiredWork.ts';
import {
    createAdminPruneAggregate,
} from '@shared-server/rallar-system/admin-operations/admin-prune-progress.ts';
import { AppAdminInboxService } from '@shared-server/rallar-system/services/AppAdminInboxService.ts';
import { AppCrdtInboxService } from '@shared-server/rallar-system/services/AppCrdtInboxService.ts';

const NOW = 1_700_000_000_000;
const RETRY_LIFETIME = DEFAULT_RESOURCE_INBOX_RETRY_HORIZON_MS +
    RESOURCE_INBOX_RETRY_PROCESSING_MARGIN_MS;

describe('Task 9 correction 4 prune retry lifetime', () => {
    it('uses the shared retry lifetime for initial admin and CRDT admin commands', () => {
        const admin = Function.prototype.toString.call(
            AppAdminInboxService.prototype.pruneExpired,
        );
        const crdtAdmin = Function.prototype.toString.call(
            (AppCrdtInboxService.prototype as unknown as {
                createAdminCommand: () => unknown;
            }).createAdminCommand,
        );

        expect(admin).toMatch(/resourceInboxRetryExpiryAtEpochMs/);
        expect(crdtAdmin).toMatch(/resourceInboxRetryExpiryAtEpochMs/);
        expect(admin).not.toMatch(/\+\s*60_000/);
        expect(crdtAdmin).not.toMatch(/\+\s*60_000/);
    });

    it('gives every successor and pending result a complete 20-attempt retry horizon', () => {
        const service = new AdminPruneExpiredWork({
            database: {} as never,
            repository: {} as never,
            serviceId: 'server-1',
            pageSize: 2,
            now: () => NOW,
            readAuthority: () => Promise.resolve({ allowed: true, code: 'allowed' }),
        });
        const command: AdminPrunePageWork = {
            kind: 'page',
            jobId: 'job-1',
            category: 'runtime-state',
            requestedBy: 'admin-1',
            requestedSessionId: 'session-1',
            capturedAtEpochMs: NOW - 1,
            expireAtEpochMs: NOW + RETRY_LIFETIME,
            pageSize: 2,
            afterCursor: null,
            pageIndex: 0,
            appData: null,
        };
        const aggregate = createAdminPruneAggregate({
            jobId: command.jobId,
            generatedAtEpochMs: command.capturedAtEpochMs,
            expireAtEpochMs: command.expireAtEpochMs,
            serverId: 'server-1',
            requestedBy: command.requestedBy,
            requestedSessionId: command.requestedSessionId,
            categories: [command.category],
            expiredRows: { 'runtime-state': 3 },
        });
        const computed = service.compute(command as never, {
            rowIds: ['1', '2'],
            hasMore: true,
            aggregate,
            expectedAggregate: JSON.stringify(aggregate),
            authority: { allowed: true, code: 'allowed' },
            nowEpochMs: NOW,
        });

        expect(computed.next?.expireAtEpochMs).toBe(NOW + RETRY_LIFETIME);
        expect(Number(computed.aggregateSuccessor.audit.expiryTs.epochMilliseconds))
            .toBe(NOW + RETRY_LIFETIME);
    });
});
