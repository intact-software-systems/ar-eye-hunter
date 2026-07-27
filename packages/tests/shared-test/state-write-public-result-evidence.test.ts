import { describe, expect, it } from 'vitest';
import { deriveApiV1StateWriteEvidence } from
    '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';

const command = {
    ri_row_id: 1, ri_resource_id: 'command-1', ri_topic_id: 'app-inbox',
    fk_ext_bank_id: 'scope', ri_status: 'COMPLETED', ri_attempts: 1,
    start_ts: new Date(1), end_ts: new Date(2), next_ts: null,
    result_status: 'COMPLETED', result_resource: '{}', ri_resource: '{}',
};

describe('durable AppInbox public result evidence', () => {
    it('requires the public client response shape without inventing outbox ids', () => {
        const client = {
            ...command,
            ri_resource_id: 'client-command-1',
            ri_resource: JSON.stringify({ payload: {
                typeId: 'CLIENT_INSTANCE_UPSERT', resource: '{"requestId":"client-command-1"}',
            } }),
            result_resource: JSON.stringify({ status: 'ok', result: { right: {
                snapshot: {}, event: null,
            } } }),
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'],
        }, [client])).toMatchObject({
            atomicCompletionFailures: 0, receiptOutboxIdCount: 0,
            appInbox: [{ durableResultValid: true }],
        });
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'],
        }, [{ ...client, result_resource: JSON.stringify({ status: 'ok' }) }]))
            .toMatchObject({ atomicCompletionFailures: 1 });
    });

    it.each([
        ['swapped principal', { principalId: 'principal-2', stateRevision: 4, requestId: 'client-command-1' }],
        ['stale revision', { principalId: 'principal-1', stateRevision: 3, requestId: 'client-command-1' }],
        ['wrong request', { principalId: 'principal-1', stateRevision: 4, requestId: 'other-request' }],
    ])('rejects a %s in a same-shaped client result', (_name, mismatch) => {
        const clientResourceId = 'physical-client-row-1';
        const clientCommandId = 'client-command-1';
        const client = {
            ...command, ri_resource_id: clientResourceId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'CLIENT_INSTANCE_UPSERT', resource: JSON.stringify({ requestId: clientCommandId }),
            } }),
            result_resource: JSON.stringify({ status: 'ok', result: { right: {
                snapshot: { stateRevision: mismatch.stateRevision, principal: {
                    applicationId: 'app-1', workspaceId: 'workspace-1',
                    principalId: mismatch.principalId,
                } },
                event: { eventId: 'event-1', requestId: mismatch.requestId, snapshotVersion: 4 },
            } } }),
        };
        const authoritative = [{
            appInboxResourceId: clientResourceId, valid: true,
            commandType: 'CLIENT_INSTANCE_UPSERT', commandIds: [clientCommandId],
            receipt: {
                appInboxResourceId: clientResourceId, commandId: clientCommandId,
                commandHash: `sha256:${'c'.repeat(64)}`, outcome: 'applied', outboxIds: [],
                identityKind: 'physical-resource-id' as const, requestId: clientCommandId,
                aggregateRef: {
                    applicationId: 'app-1', workspaceId: 'workspace-1', principalId: 'principal-1',
                },
                stateRevision: 4, snapshotVersion: 4, eventId: 'event-1',
            },
        }];
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['CLIENT_INSTANCE_UPSERT'] },
            [client], [], [], undefined, authoritative,
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('rejects a swapped group in a same-shaped group result', () => {
        const resourceId = 'physical-group-row-1';
        const logicalId = 'group-command-1';
        const group = {
            ...command, ri_resource_id: resourceId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'GROUP_UPDATE', resource: JSON.stringify({ commandId: logicalId }),
            } }),
            result_resource: JSON.stringify({ status: 'ok', result: { right: {
                snapshot: { stateRevision: 8, group: {
                    applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-2',
                } },
                event: { eventId: 'group-event-1', requestId: logicalId, snapshotVersion: 8 },
            } } }),
        };
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_UPDATE'] }, [group], [], [], undefined, [{
                appInboxResourceId: resourceId, valid: true,
                commandType: 'GROUP_UPDATE', commandIds: [logicalId],
                receipt: {
                    appInboxResourceId: resourceId, commandId: logicalId,
                    commandHash: `sha256:${'d'.repeat(64)}`, outcome: 'applied', outboxIds: [],
                    identityKind: 'physical-resource-id', requestId: logicalId,
                    aggregateRef: {
                        applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1',
                    },
                    stateRevision: 8, snapshotVersion: 8, eventId: 'group-event-1',
                },
            }],
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('accepts a canonical terminal group denial without inventing a receipt', () => {
        const resourceId = 'physical-denied-group-row';
        const denied = {
            ...command, ri_resource_id: resourceId, ri_status: 'FAILED', result_status: 'FAILED',
            ri_resource: JSON.stringify({ payload: {
                typeId: 'GROUP_MEMBER_UPSERT', resource: '{"commandId":"denied-group-command"}',
            } }),
            result_resource: JSON.stringify({
                type: 'app-inbox-failure', version: 'canonical.v2',
                code: 'group-capacity-denied', status: 409, message: 'Group capacity reached',
                issues: null, denial: null, retry: null,
            }),
        };
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_MEMBER_UPSERT'] },
            [denied], [], [], undefined, [{
                appInboxResourceId: resourceId, valid: true,
                commandType: 'GROUP_MEMBER_UPSERT', commandIds: ['denied-group-command'],
            }],
        )).toMatchObject({
            atomicCompletionFailures: 0, failedAppInboxCount: 1, statusResultFailures: 0,
        });
    });
});
