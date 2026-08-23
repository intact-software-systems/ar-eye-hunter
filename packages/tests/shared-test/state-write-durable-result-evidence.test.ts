import type { AdminPruneCommand } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-command-codec.ts';
import type { AdminPruneEnqueueResult } from '@shared-server/rallar-system/admin-operations/inbox/admin-prune-inbox-codec.ts';
import { toAdminPruneOutbox } from '@shared-server/rallar-system/admin-operations/prune/admin-prune-page-codec.ts';
import { deriveApiV1StateWriteEvidence } from '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import type {
    AuthoritativeReceiptEvidence,
    PersistedCommandEvidence
} from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts';
import type { RallarCrdtJsonValue } from '@shared/crdt/mod.ts';
import { describe, expect, it } from 'vitest';

const commandId = 'topology-command-1';
const effectId = `${commandId}:rtc-topology-recompute:group-revision:group=1;presence=0`;
const commandHash = `sha256:${'a'.repeat(64)}`;
const topologyGroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'group-1'
};
const acceptedConfig = {
    topologyKind: 'tree',
    degreeLimit: 2,
    treeMinSize: 5,
    meshMinSize: 16,
    meshParamK: 2
};
const topologyReceipt = {
    commandId,
    requestId: commandId,
    commandHash,
    operation: 'putConfig',
    outcome: 'applied',
    attemptCount: 1,
    groupRef: topologyGroupRef,
    target: 'config',
    acceptedVersion: 1,
    acceptedStorageRevision: 0,
    acceptedCreatedAtEpochMs: 10,
    acceptedUpdatedAtEpochMs: 11,
    acceptedExpiresAtEpochMs: null,
    acceptedConfig,
    acceptedCausalRevision: {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        snapshotVersion: 1,
        metadataVersion: 1,
        rosterVersion: 1,
        presenceVersion: 0
    },
    eventId: null,
    outboxIds: [effectId]
};
const topologyConfig = {
    groupRef: topologyGroupRef,
    config: acceptedConfig,
    version: 1,
    createdAtEpochMs: 10,
    updatedAtEpochMs: 11,
    updatedByPrincipalId: 'principal-1',
    requestId: commandId
};
const command = {
    ri_row_id: 1,
    ri_resource_id: commandId,
    ri_topic_id: 'app-inbox.group-topology',
    fk_ext_bank_id: 'scope',
    ri_status: 'COMPLETED',
    ri_attempts: 1,
    start_ts: new Date(1),
    end_ts: new Date(2),
    next_ts: null,
    result_status: 'COMPLETED',
    result_resource: JSON.stringify({
        receipt: topologyReceipt,
        config: topologyConfig
    }),
    ri_resource: JSON.stringify({
        payload: {
            typeId: 'TOPOLOGY_CONFIG_PUT',
            resource: JSON.stringify({ requestId: commandId })
        }
    })
};
const effect = {
    ri_resource_id: 'physical-queue-key-1',
    ri_topic_id: 'app-outbox.rtc-topology',
    fk_ext_bank_id: 'scope',
    ri_type_id: 'APP_OUTBOX',
    ri_status: 'NEW',
    ri_resource: JSON.stringify({
        id: { msgId: effectId }
    })
};
const spec = {
    match: 'scope',
    commandTypes: ['TOPOLOGY_CONFIG_PUT'],
    expectedEffectsByCommandType: {
        TOPOLOGY_CONFIG_PUT: ['rtc-topology-recompute']
    }
};

describe('durable AppInbox result evidence', () => {
    it.each([
        ['unknown', 'UNKNOWN', { garbage: true }],
        ['empty unknown', 'UNKNOWN', {}],
        ['auth agent ticket', 'AUTH_AGENT_SESSION_TICKET_CONSUME', { garbage: true }],
        ['admin prune', 'ADMIN_PRUNE_EXPIRED', { garbage: true }],
        ['CRDT append', 'CRDT_UPDATE_APPEND', { garbage: true }],
        ['RTC RTT', 'RTC_RTT_SUBMIT', { garbage: true }]
    ])('fails closed for a completed %s result', (_name, commandType, result) => {
        const candidate = {
            ...command,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: commandType,
                    resource: JSON.stringify({ requestId: commandId })
                }
            }),
            result_resource: JSON.stringify(result)
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope',
            commandTypes: [commandType]
        }, [candidate])).toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1,
            appInbox: [{ durableResultValid: false }]
        });
    });

    it('accepts an exact persisted receipt and ResourceInbox effect identity', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect])).toMatchObject({
            atomicCompletionFailures: 0,
            receiptOutboxIds: [effectId],
            resourceOutbox: [{ resourceId: 'physical-queue-key-1', outboxId: effectId }],
            appInbox: [{
                durableResultValid: true,
                receipt: {
                    commandId,
                    identityKind: 'logical-msg-id'
                }
            }]
        });
    });

    it('accepts a physical queue-key receipt without conflating it with logical msgId', () => {
        const presenceCommandId = 'presence-command-1';
        const physicalEffectId = 'presence-effect-physical-1';
        const presence = {
            ...command,
            ri_resource_id: presenceCommandId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_PRESENCE_CONNECT',
                    resource: JSON.stringify({ commandId: presenceCommandId })
                }
            }),
            result_resource: JSON.stringify({
                commandId: presenceCommandId,
                requestId: presenceCommandId,
                commandHash,
                aggregateRef: topologyGroupRef,
                outcome: 'applied',
                attemptCount: 1,
                acceptedStorageRevision: 1,
                snapshotVersion: 1,
                causalRevision: { groupRevision: 1, presenceRevision: 1 },
                eventId: null,
                outboxIds: [physicalEffectId],
                joinCode: null,
                joinCodeExpiresAtEpochMs: null,
                rejection: null
            })
        };
        const presenceEffect = {
            ...effect,
            ri_resource_id: physicalEffectId,
            ri_topic_id: 'app-outbox.group-presence-summary',
            ri_resource: JSON.stringify({
                id: {
                    msgId: `${presenceCommandId}:group-presence-summary:1`
                }
            })
        };
        expect(deriveApiV1StateWriteEvidence(
            {
                match: 'scope',
                commandTypes: ['GROUP_PRESENCE_CONNECT'],
                expectedEffectsByCommandType: {
                    GROUP_PRESENCE_CONNECT: ['group-presence-summary']
                }
            },
            [presence],
            [presenceEffect]
        )).toMatchObject({
            atomicCompletionFailures: 0,
            appInbox: [{ receipt: { identityKind: 'physical-resource-id' } }],
            resourceOutbox: [{
                resourceId: physicalEffectId,
                outboxId: `${presenceCommandId}:group-presence-summary:1`
            }]
        });
    });

    it.each([
        ['missing', null],
        ['malformed', '{'],
        [
            'wrong command',
            JSON.stringify({
                receipt: {
                    commandId: 'invented-command',
                    outcome: 'applied',
                    attemptCount: 1,
                    outboxIds: [effectId]
                }
            })
        ],
        [
            'duplicate effect identity',
            JSON.stringify({
                receipt: {
                    commandId,
                    outcome: 'applied',
                    attemptCount: 1,
                    outboxIds: [effectId, effectId]
                }
            })
        ]
    ])('rejects a %s durable result', (_name, resultResource) => {
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [{ ...command, result_resource: resultResource }],
            [effect]
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('rejects a receipt whose exact effect identity is absent or unexpected', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [{
            ...effect,
            ri_resource: JSON.stringify({
                id: { msgId: `${commandId}:rtc-topology-recompute:different-effect` }
            })
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId]
        });
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect, {
            ...effect,
            ri_resource_id: 'unexpected-effect'
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId]
        });
    });

    it('cross-checks an embedded receipt with authoritative persisted receipt truth', () => {
        const receipt: AuthoritativeReceiptEvidence = {
            appInboxResourceId: commandId,
            commandId,
            commandHash,
            outcome: 'applied',
            outboxIds: [effectId],
            identityKind: 'logical-msg-id',
            topology: {
                operation: 'putConfig',
                target: 'config',
                groupRef: topologyGroupRef,
                acceptedVersion: 1,
                acceptedStorageRevision: 0,
                acceptedCreatedAtEpochMs: 10,
                acceptedUpdatedAtEpochMs: 11,
                acceptedExpiresAtEpochMs: null,
                acceptedConfig
            }
        };
        const authoritative: readonly PersistedCommandEvidence[] = [{
            appInboxResourceId: commandId,
            appInboxTopicId: command.ri_topic_id,
            appInboxContextId: command.fk_ext_bank_id,
            valid: true,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [commandId],
            receipt
        }];
        const valid = deriveApiV1StateWriteEvidence(
            spec,
            [command],
            [effect],
            [],
            undefined,
            authoritative
        );
        expect(valid).toMatchObject({ atomicCompletionFailures: 0 });

        const tampered: readonly PersistedCommandEvidence[] = [{
            ...authoritative[0],
            receipt: { ...receipt, outboxIds: ['invented-authoritative-id'] }
        }];
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [command],
            [effect],
            [],
            undefined,
            tampered
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });

        const extraReceiptKey = {
            ...command,
            result_resource: JSON.stringify({
                receipt: {
                    ...JSON.parse(command.result_resource).receipt,
                    inventedIdentity: 'must-not-be-trusted'
                }
            })
        };
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [extraReceiptKey],
            [effect],
            [],
            undefined,
            authoritative
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('requires the exact topology reconfigure result and command scope', () => {
        const resourceId = 'physical-topology-reconfigure-row';
        const requestId = 'topology-reconfigure-request';
        const groupRef = {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'group-1'
        };
        const topology = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'TOPOLOGY_RECONFIGURE',
                    resource: JSON.stringify({ requestId })
                }
            }),
            result_resource: JSON.stringify({
                status: 'queued',
                groupRef,
                requestId,
                outboxId: 'topology-outbox-1'
            })
        };
        const authoritative = [{
            appInboxResourceId: resourceId,
            appInboxTopicId: topology.ri_topic_id,
            appInboxContextId: topology.fk_ext_bank_id,
            valid: true,
            commandType: 'TOPOLOGY_RECONFIGURE',
            commandIds: [requestId],
            commandScope: groupRef
        }];
        const topologySpec = { match: 'scope', commandTypes: ['TOPOLOGY_RECONFIGURE'] };
        expect(deriveApiV1StateWriteEvidence(
            topologySpec,
            [topology],
            [],
            [],
            undefined,
            authoritative
        )).toMatchObject({ atomicCompletionFailures: 0 });
        expect(deriveApiV1StateWriteEvidence(
            topologySpec,
            [{
                ...topology,
                result_resource: JSON.stringify({
                    status: 'queued',
                    groupRef: { ...groupRef, groupId: 'swapped-group' },
                    requestId,
                    outboxId: 'topology-outbox-1',
                    inventedIdentity: true
                })
            }],
            [],
            [],
            undefined,
            authoritative
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('validates group session cleanup as its exact inactive result, not a receipt', () => {
        const resourceId = 'group-presence-session-cleanup:session-1:generation-1';
        const cleanup = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: 'GROUP_PRESENCE_SESSION_CLEANUP',
                    resource: '{}'
                }
            }),
            result_resource: JSON.stringify({
                status: 'inactive',
                sessionId: 'session-1',
                generationId: 'generation-1',
                affectedGroups: 2
            })
        };
        const cleanupEvidence = [{
            appInboxResourceId: resourceId,
            appInboxTopicId: cleanup.ri_topic_id,
            appInboxContextId: cleanup.fk_ext_bank_id,
            valid: true,
            commandType: 'GROUP_PRESENCE_SESSION_CLEANUP',
            commandIds: ['session-1', 'generation-1']
        }];
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_PRESENCE_SESSION_CLEANUP'] },
            [cleanup],
            [],
            [],
            undefined,
            cleanupEvidence
        )).toMatchObject({ atomicCompletionFailures: 0 });
    });

    it('keeps a physical AppInbox key distinct from logical command and receipt identity', () => {
        const physicalResourceId = 'physical-topology-row-1';
        const physicalCommand = { ...command, ri_resource_id: physicalResourceId };
        const authoritative: readonly PersistedCommandEvidence[] = [{
            appInboxResourceId: physicalResourceId,
            appInboxTopicId: physicalCommand.ri_topic_id,
            appInboxContextId: physicalCommand.fk_ext_bank_id,
            valid: true,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [commandId],
            receipt: {
                appInboxResourceId: physicalResourceId,
                commandId,
                commandHash,
                outcome: 'applied',
                outboxIds: [effectId],
                identityKind: 'logical-msg-id',
                topology: {
                    operation: 'putConfig',
                    target: 'config',
                    groupRef: topologyGroupRef,
                    acceptedVersion: 1,
                    acceptedStorageRevision: 0,
                    acceptedCreatedAtEpochMs: 10,
                    acceptedUpdatedAtEpochMs: 11,
                    acceptedExpiresAtEpochMs: null,
                    acceptedConfig
                }
            }
        }];
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [physicalCommand],
            [effect],
            [],
            undefined,
            authoritative
        )).toMatchObject({
            atomicCompletionFailures: 0,
            appInbox: [{ resourceId: physicalResourceId, commandIds: [commandId] }]
        });
    });

    it('rejects a production command decoder failure before trusting its result', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect], [], undefined, [{
            appInboxResourceId: commandId,
            appInboxTopicId: command.ri_topic_id,
            appInboxContextId: command.fk_ext_bank_id,
            valid: false,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [],
            failure: 'topology command scope differs from queue identity'
        }])).toMatchObject({ statusResultFailures: 1 });
    });

    it('pairs command evidence by physical row when scoped commands share a request id', () => {
        const sharedRequestId = 'shared-admin-request-id';
        const adminRow = (rowId: number, contextId: string, jobId: string) => ({
            ...command,
            ri_row_id: rowId,
            ri_resource_id: sharedRequestId,
            ri_topic_id: 'ADMIN_PRUNE_EXPIRED',
            fk_ext_bank_id: contextId,
            ri_resource: JSON.stringify({ payload: { typeId: 'ADMIN_PRUNE_EXPIRED' } }),
            result_resource: JSON.stringify({
                generatedAtEpochMs: rowId,
                serverId: `server-${rowId}`,
                warnings: [],
                operation: 'maintenance.prune-expired',
                status: 'queued',
                changed: false,
                jobId,
                results: [{
                    category: 'runtime-state',
                    expiredRows: 0,
                    deletedRows: 0,
                    dryRun: false
                }]
            })
        });
        const adminCommand = (jobId: string, capturedAtEpochMs: number): AdminPruneCommand => ({
            version: 1,
            jobId,
            commandHash: `${jobId}:hash`,
            requestedBy: 'admin',
            requestedSessionId: 'session',
            capturedAtEpochMs,
            expireAtEpochMs: capturedAtEpochMs + 60_000,
            dryRun: false,
            categories: ['runtime-state'],
            appData: null,
            pageSize: 100
        });
        const commandEvidence = (
            contextId: string,
            jobId: string,
            capturedAtEpochMs: number
        ): PersistedCommandEvidence => ({
            appInboxResourceId: sharedRequestId,
            appInboxTopicId: 'ADMIN_PRUNE_EXPIRED',
            appInboxContextId: contextId,
            valid: true,
            commandType: 'ADMIN_PRUNE_EXPIRED',
            commandIds: [jobId],
            adminPruneCommand: adminCommand(jobId, capturedAtEpochMs)
        });
        const page = (jobId: string, capturedAtEpochMs: number) => {
            const entry = toAdminPruneOutbox({
                kind: 'page',
                jobId,
                category: 'runtime-state',
                requestedBy: 'admin',
                requestedSessionId: 'session',
                capturedAtEpochMs,
                expireAtEpochMs: capturedAtEpochMs + 60_000,
                pageSize: 100,
                afterCursor: null,
                pageIndex: 0,
                appData: null
            }, 'server');
            return {
                ri_resource_id: entry.key.resourceId,
                ri_topic_id: entry.key.topicId,
                fk_ext_bank_id: entry.key.contextId,
                ri_type_id: entry.typeId,
                ri_status: 'COMPLETED',
                ri_resource: entry.resource
            };
        };

        expect(deriveApiV1StateWriteEvidence(
            {
                match: sharedRequestId,
                commandTypes: ['ADMIN_PRUNE_EXPIRED'],
                expectedEffectsByCommandType: { ADMIN_PRUNE_EXPIRED: ['admin-prune-page'] }
            },
            [adminRow(1, 'caller=admin', 'admin-job-1'), adminRow(2, 'caller=bob', 'admin-job-2')],
            [page('admin-job-1', 1), page('admin-job-2', 2)],
            [],
            undefined,
            [
                commandEvidence('caller=admin', 'admin-job-1', 1),
                commandEvidence('caller=bob', 'admin-job-2', 2)
            ]
        )).toMatchObject({
            matchedAppInboxCount: 2,
            atomicCompletionFailures: 0,
            statusResultFailures: 0,
            resourceOutboxCount: 2,
            appInbox: [
                { contextId: 'caller=admin', commandIds: ['admin-job-1'], durableResultValid: true },
                { contextId: 'caller=bob', commandIds: ['admin-job-2'], durableResultValid: true }
            ]
        });
    });

    it.each<readonly [string, (result: AdminPruneEnqueueResult) => RallarCrdtJsonValue]>([
        ['an arbitrary category', (result) => ({
            ...result,
            results: [{ ...result.results[0]!, category: 'arbitrary' }]
        })],
        ['duplicate categories', (result) => ({
            ...result,
            results: [result.results[0]!, result.results[0]!]
        })],
        ['no categories', (result) => ({ ...result, results: [] })],
        ['a negative count', (result) => ({
            ...result,
            results: [{ ...result.results[0]!, expiredRows: -1 }]
        })],
        ['more deletions than expirations', (result) => ({
            ...result,
            changed: true,
            results: [{ ...result.results[0]!, expiredRows: 1, deletedRows: 2 }]
        })],
        ['an inconsistent changed flag', (result) => ({ ...result, changed: true })],
        ['an inconsistent status', (result) => ({ ...result, status: 'completed' })],
        ['an inconsistent dry-run flag', (result) => ({
            ...result,
            results: [{ ...result.results[0]!, dryRun: true }]
        })],
        ['another capture time', (result) => ({
            ...result,
            generatedAtEpochMs: result.generatedAtEpochMs + 1
        })],
        ['another command category', (result) => ({
            ...result,
            results: [{ ...result.results[0]!, category: 'resource-inbox' }]
        })]
    ])('rejects an admin durable result containing %s', (_name, mutate) => {
        const jobId = 'strict-admin-result-job';
        const adminPruneCommand: AdminPruneCommand = {
            version: 1,
            jobId,
            commandHash: 'strict-admin-command-hash',
            requestedBy: 'admin',
            requestedSessionId: 'session',
            capturedAtEpochMs: 10,
            expireAtEpochMs: 60_010,
            dryRun: false,
            categories: ['runtime-state'],
            appData: null,
            pageSize: 100
        };
        const result: AdminPruneEnqueueResult = {
            generatedAtEpochMs: adminPruneCommand.capturedAtEpochMs,
            serverId: 'server',
            warnings: [],
            operation: 'maintenance.prune-expired',
            status: 'queued',
            changed: false,
            jobId,
            results: [{ category: 'runtime-state', expiredRows: 1, deletedRows: 0, dryRun: false }]
        };
        const candidate = {
            ...command,
            ri_resource_id: 'strict-admin-request',
            ri_topic_id: 'ADMIN_PRUNE_EXPIRED',
            fk_ext_bank_id: 'strict-admin-context',
            ri_resource: JSON.stringify({ payload: { typeId: 'ADMIN_PRUNE_EXPIRED' } }),
            result_resource: JSON.stringify(mutate(result))
        };
        const evidence: PersistedCommandEvidence = {
            appInboxResourceId: candidate.ri_resource_id,
            appInboxTopicId: candidate.ri_topic_id,
            appInboxContextId: candidate.fk_ext_bank_id,
            valid: true,
            commandType: 'ADMIN_PRUNE_EXPIRED',
            commandIds: [jobId],
            adminPruneCommand
        };

        expect(deriveApiV1StateWriteEvidence(
            { match: jobId, commandTypes: ['ADMIN_PRUNE_EXPIRED'] },
            [candidate],
            [],
            [],
            undefined,
            [evidence]
        )).toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1,
            appInbox: [{ durableResultValid: false }]
        });
    });
});
