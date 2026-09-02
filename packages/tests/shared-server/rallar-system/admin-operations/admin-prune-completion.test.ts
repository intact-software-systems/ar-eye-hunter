import { Temporal } from '@js-temporal/polyfill';
import { describe, expect, it } from 'vitest';

import { createAdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import { computeAdminPruneMutation, validateAdminPruneMutation } from '@shared-server/rallar-system/admin-operations/inbox/compute-admin-prune-mutation.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

describe('admin prune completion candidate', () => {
    it('computes pages, aggregate, durable result and completion from the same read', async () => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);

        expect(computed.result).toMatchObject({ status: 'queued', serverId: 'admin-server', jobId: 'prune-job' });
        expect(computed.outboxWrites).toEqual([
            expect.objectContaining({
                entry: expect.objectContaining({ typeId: 'APP_OUTBOX' }),
                systemDate: expect.any(String),
                createdAt: expect.any(String),
                expiresAt: expect.any(String)
            })
        ]);
        expect(computed.aggregateWrite).toEqual(
            expect.objectContaining({
                resource: expect.any(String),
                systemDate: expect.any(String),
                createdAt: expect.any(String),
                expiresAt: expect.any(String)
            })
        );
        expect(computed.completion.durableResult).toBe(computed.result);
        expect(computed.completion.reservationFinish.completedAt).toEqual(new Date(1_010));
        expect(validateAdminPruneMutation(read, computed)).toEqual([]);
    });

    it('checks original authority, page contents and completion without repairing tampered data', async () => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);
        const changed = {
            ...computed,
            outboxWrites: [{
                ...computed.outboxWrites[0],
                entry: { ...computed.outboxWrites[0].entry, resource: '{}' }
            }]
        };

        expect(validateAdminPruneMutation(read, changed).length).toBeGreaterThan(0);
        expect(changed.outboxWrites[0].entry.resource).toBe('{}');
        expect(validateAdminPruneMutation({ ...read, authority: { allowed: false, code: 'denied' } }, computed)).toContainEqual(
            expect.objectContaining({ code: 'admin-prune-authority-denied', status: 403 })
        );
        expect(
            validateAdminPruneMutation(read, {
                ...computed,
                completion: { ...computed.completion, encodedResult: null }
            }).length
        ).toBeGreaterThan(0);
    });

    it('returns an issue for unusable completion facts without repairing or replacing them', async () => {
        const original = await createRead();
        const computed = computeAdminPruneMutation(original);
        const read = { ...original, completionFacts: { ...original.completionFacts, completedAtEpochMs: NaN } };

        expect(validateAdminPruneMutation(read, computed)).toEqual([
            expect.objectContaining({ code: 'admin-prune-computed-value-invalid', status: 500 })
        ]);
        expect(Number.isNaN(read.completionFacts.completedAtEpochMs)).toBe(true);
        expect(computed.completion.reservationFinish.completedAt).toEqual(new Date(1_010));
        expect(computed.outboxWrites).toHaveLength(1);
    });

    it('rejects hidden missing page writes without invoking a serialization callback', async () => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);
        let callbackCalls = 0;
        const outboxWrites = Object.assign([], {
            toJSON: () => {
                callbackCalls += 1;
                return computed.outboxWrites;
            }
        });

        const issues = validateAdminPruneMutation(read, { ...computed, outboxWrites });

        expect.soft(callbackCalls).toBe(0);
        expect.soft(issues.length).toBeGreaterThan(0);
        expect(outboxWrites).toHaveLength(0);
    });

    it.each(['candidate', 'outboxWrites', 'completion'] as const)('rejects a %s Proxy without invoking its traps', async (placement) => {
        const read = await createRead();
        const computed = computeAdminPruneMutation(read);
        let trapCalls = 0;
        const inspect = (): never => {
            trapCalls += 1;
            throw new Error('Candidate inspection must not invoke Proxy traps');
        };
        const traps = { get: inspect, getPrototypeOf: inspect, ownKeys: inspect, getOwnPropertyDescriptor: inspect };
        const candidate = placement === 'candidate'
            ? new Proxy(computed, traps)
            : { ...computed, [placement]: new Proxy(computed[placement], traps) };

        expect(validateAdminPruneMutation(read, candidate).length).toBeGreaterThan(0);
        expect(trapCalls).toBe(0);
    });
});

async function createRead() {
    const command = await createAdminPruneCommand({
        jobId: 'prune-job',
        requestedBy: 'admin',
        requestedSessionId: 'session',
        capturedAtEpochMs: 1_000,
        expireAtEpochMs: 100_000,
        dryRun: false,
        categories: ['runtime-state'],
        appData: null,
        pageSize: 25
    });
    const entry: ResourceEntry = {
        key: { topicId: 'ADMIN_PRUNE_EXPIRED', resourceId: 'prune-job', contextId: 'admin' },
        resource: '{}',
        typeId: 'APP_INBOX',
        status: EntityStatus.RESERVED,
        audit: {
            date: Temporal.PlainTime.from('12:00:00'),
            createdBy: 'admin-server',
            createdTs: Temporal.PlainDateTime.from('2026-08-07T12:00:00'),
            expiryTs: Temporal.Instant.from('2026-08-07T13:00:00Z')
        },
        dequeueAudit: { attempts: 1 }
    };
    return {
        command,
        expiredRows: { 'runtime-state': 3, 'resource-inbox': 0, 'resource-inbox-results': 0, 'app-data': 0 },
        authority: { allowed: true, code: 'allowed' },
        nowEpochMs: 1_005,
        serviceId: 'admin-server',
        completionFacts: { entry, completedAtEpochMs: 1_010 }
    };
}
