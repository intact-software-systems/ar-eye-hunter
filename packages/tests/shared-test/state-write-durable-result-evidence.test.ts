import { describe, expect, it } from 'vitest';
import { deriveApiV1StateWriteEvidence } from
    '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';

const commandId = 'topology-command-1';
const effectId = `${commandId}:rtc-topology-recompute:1`;
const commandHash = `sha256:${'a'.repeat(64)}`;
const topologyGroupRef = {
    applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1',
};
const acceptedConfig = {
    topologyKind: 'tree', degreeLimit: 2, treeMinSize: 5, meshMinSize: 16, meshParamK: 2,
};
const topologyReceipt = {
    commandId, requestId: commandId, commandHash, operation: 'putConfig', outcome: 'applied',
    attemptCount: 1, groupRef: topologyGroupRef, target: 'config', acceptedVersion: 1,
    acceptedStorageRevision: 0, acceptedCreatedAtEpochMs: 10, acceptedUpdatedAtEpochMs: 11,
    acceptedExpiresAtEpochMs: null, acceptedConfig, acceptedCausalRevision: null,
    eventId: null, outboxId: effectId, outboxIds: [effectId],
};
const topologyConfig = {
    groupRef: topologyGroupRef, config: acceptedConfig, version: 1,
    createdAtEpochMs: 10, updatedAtEpochMs: 11,
    updatedByPrincipalId: 'principal-1', requestId: commandId,
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
        config: topologyConfig,
    }),
    ri_resource: JSON.stringify({ payload: {
        typeId: 'TOPOLOGY_CONFIG_PUT',
        resource: JSON.stringify({ requestId: commandId }),
    } }),
};
const effect = {
    ri_resource_id: 'physical-queue-key-1',
    ri_topic_id: 'app-outbox.rtc-topology',
    ri_type_id: 'APP_OUTBOX',
    ri_status: 'NEW',
    ri_resource: JSON.stringify({
        id: { msgId: effectId },
    }),
};
const spec = {
    match: 'scope',
    commandTypes: ['TOPOLOGY_CONFIG_PUT'],
    expectedEffectsByCommandType: {
        TOPOLOGY_CONFIG_PUT: ['rtc-topology-recompute'],
    },
};

describe('durable AppInbox result evidence', () => {
    it.each([
        ['unknown', 'UNKNOWN', { garbage: true }],
        ['empty unknown', 'UNKNOWN', {}],
        ['auth agent ticket', 'AUTH_AGENT_SESSION_TICKET_CONSUME', { garbage: true }],
        ['admin prune', 'ADMIN_PRUNE_EXPIRED', { garbage: true }],
        ['CRDT append', 'CRDT_UPDATE_APPEND', { garbage: true }],
        ['RTC RTT', 'RTC_RTT_SUBMIT', { garbage: true }],
    ])('fails closed for a completed %s result', (_name, commandType, result) => {
        const candidate = {
            ...command,
            ri_resource: JSON.stringify({ payload: {
                typeId: commandType,
                resource: JSON.stringify({ requestId: commandId }),
            } }),
            result_resource: JSON.stringify(result),
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: [commandType],
        }, [candidate])).toMatchObject({
            atomicCompletionFailures: 1,
            statusResultFailures: 1,
            appInbox: [{ durableResultValid: false }],
        });
    });

    it('accepts an exact persisted receipt and ResourceInbox effect identity', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect])).toMatchObject({
            atomicCompletionFailures: 0,
            receiptOutboxIds: [effectId],
            resourceOutbox: [{ resourceId: 'physical-queue-key-1', outboxId: effectId }],
            appInbox: [{ durableResultValid: true, receipt: {
                commandId, identityKind: 'logical-msg-id',
            } }],
        });
    });

    it('accepts a physical queue-key receipt without conflating it with logical msgId', () => {
        const presenceCommandId = 'presence-command-1';
        const physicalEffectId = 'presence-effect-physical-1';
        const presence = {
            ...command,
            ri_resource_id: presenceCommandId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'GROUP_PRESENCE_CONNECT',
                resource: JSON.stringify({ commandId: presenceCommandId }),
            } }),
            result_resource: JSON.stringify({
                commandId: presenceCommandId, outcome: 'applied', attemptCount: 1,
                outboxIds: [physicalEffectId],
            }),
        };
        const presenceEffect = {
            ...effect,
            ri_resource_id: physicalEffectId,
            ri_topic_id: 'app-outbox.group-presence-summary',
            ri_resource: JSON.stringify({ id: {
                msgId: `${presenceCommandId}:group-presence-summary:1`,
            } }),
        };
        expect(deriveApiV1StateWriteEvidence({
            match: 'scope', commandTypes: ['GROUP_PRESENCE_CONNECT'],
            expectedEffectsByCommandType: {
                GROUP_PRESENCE_CONNECT: ['group-presence-summary'],
            },
        }, [presence], [presenceEffect])).toMatchObject({
            atomicCompletionFailures: 0,
            appInbox: [{ receipt: { identityKind: 'physical-resource-id' } }],
            resourceOutbox: [{
                resourceId: physicalEffectId,
                outboxId: `${presenceCommandId}:group-presence-summary:1`,
            }],
        });
    });

    it.each([
        ['missing', null],
        ['malformed', '{'],
        ['wrong command', JSON.stringify({ receipt: {
            commandId: 'invented-command', outcome: 'applied', attemptCount: 1,
            outboxIds: [effectId],
        } })],
        ['duplicate effect identity', JSON.stringify({ receipt: {
            commandId, outcome: 'applied', attemptCount: 1,
            outboxIds: [effectId, effectId],
        } })],
    ])('rejects a %s durable result', (_name, resultResource) => {
        expect(deriveApiV1StateWriteEvidence(
            spec,
            [{ ...command, result_resource: resultResource }],
            [effect],
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('rejects a receipt whose exact effect identity is absent or unexpected', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [{
            ...effect,
            ri_resource: JSON.stringify({
                id: { msgId: `${commandId}:rtc-topology-recompute:different-effect` },
            }),
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId],
        });
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect, {
            ...effect,
            ri_resource_id: 'unexpected-effect',
        }])).toMatchObject({
            atomicCompletionFailures: 1,
            finalEffectFailures: [commandId],
        });
    });

    it('cross-checks an embedded receipt with authoritative persisted receipt truth', () => {
        const authoritative = [{
            appInboxResourceId: commandId,
            valid: true,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [commandId],
            receipt: {
                appInboxResourceId: commandId,
                commandId,
                commandHash,
                outcome: 'applied',
                outboxIds: [effectId],
                identityKind: 'logical-msg-id' as const,
                topology: {
                    operation: 'putConfig', target: 'config', groupRef: topologyGroupRef,
                    acceptedVersion: 1, acceptedStorageRevision: 0,
                    acceptedCreatedAtEpochMs: 10, acceptedUpdatedAtEpochMs: 11,
                    acceptedExpiresAtEpochMs: null, acceptedConfig,
                },
            },
        }];
        const valid = deriveApiV1StateWriteEvidence(
            spec, [command], [effect], [], undefined, authoritative,
        );
        expect(valid).toMatchObject({ atomicCompletionFailures: 0 });

        const tampered = [{
            ...authoritative[0],
            receipt: { ...authoritative[0].receipt, outboxIds: ['invented-authoritative-id'] },
        }];
        expect(deriveApiV1StateWriteEvidence(
            spec, [command], [effect], [], undefined, tampered,
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });

        const extraReceiptKey = {
            ...command,
            result_resource: JSON.stringify({
                receipt: {
                    ...JSON.parse(command.result_resource).receipt,
                    inventedIdentity: 'must-not-be-trusted',
                },
            }),
        };
        expect(deriveApiV1StateWriteEvidence(
            spec, [extraReceiptKey], [effect], [], undefined, authoritative,
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('requires the exact topology reconfigure result and command scope', () => {
        const resourceId = 'physical-topology-reconfigure-row';
        const requestId = 'topology-reconfigure-request';
        const groupRef = {
            applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1',
        };
        const topology = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'TOPOLOGY_RECONFIGURE', resource: JSON.stringify({ requestId }),
            } }),
            result_resource: JSON.stringify({
                status: 'queued', groupRef, requestId, outboxId: 'topology-outbox-1',
            }),
        };
        const authoritative = [{
            appInboxResourceId: resourceId,
            valid: true,
            commandType: 'TOPOLOGY_RECONFIGURE',
            commandIds: [requestId],
            commandScope: groupRef,
        }];
        const topologySpec = { match: 'scope', commandTypes: ['TOPOLOGY_RECONFIGURE'] };
        expect(deriveApiV1StateWriteEvidence(
            topologySpec, [topology], [], [], undefined, authoritative,
        )).toMatchObject({ atomicCompletionFailures: 0 });
        expect(deriveApiV1StateWriteEvidence(
            topologySpec,
            [{ ...topology, result_resource: JSON.stringify({
                status: 'queued', groupRef: { ...groupRef, groupId: 'swapped-group' },
                requestId, outboxId: 'topology-outbox-1', inventedIdentity: true,
            }) }],
            [], [], undefined, authoritative,
        )).toMatchObject({ atomicCompletionFailures: 1, statusResultFailures: 1 });
    });

    it('validates group session cleanup as its exact inactive result, not a receipt', () => {
        const resourceId = 'group-presence-session-cleanup:session-1:generation-1';
        const cleanup = {
            ...command,
            ri_resource_id: resourceId,
            ri_resource: JSON.stringify({ payload: {
                typeId: 'GROUP_PRESENCE_SESSION_CLEANUP', resource: '{}',
            } }),
            result_resource: JSON.stringify({
                status: 'inactive', sessionId: 'session-1', generationId: 'generation-1',
                affectedGroups: 2,
            }),
        };
        const cleanupEvidence = [{
            appInboxResourceId: resourceId,
            valid: true,
            commandType: 'GROUP_PRESENCE_SESSION_CLEANUP',
            commandIds: ['session-1', 'generation-1'],
        }];
        expect(deriveApiV1StateWriteEvidence(
            { match: 'scope', commandTypes: ['GROUP_PRESENCE_SESSION_CLEANUP'] },
            [cleanup], [], [], undefined, cleanupEvidence,
        )).toMatchObject({ atomicCompletionFailures: 0 });
    });

    it('keeps a physical AppInbox key distinct from logical command and receipt identity', () => {
        const physicalResourceId = 'physical-topology-row-1';
        const physicalCommand = { ...command, ri_resource_id: physicalResourceId };
        const authoritative = [{
            appInboxResourceId: physicalResourceId,
            valid: true,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [commandId],
            receipt: {
                appInboxResourceId: physicalResourceId,
                commandId,
                commandHash,
                outcome: 'applied',
                outboxIds: [effectId],
                identityKind: 'logical-msg-id' as const,
                topology: {
                    operation: 'putConfig', target: 'config', groupRef: topologyGroupRef,
                    acceptedVersion: 1, acceptedStorageRevision: 0,
                    acceptedCreatedAtEpochMs: 10, acceptedUpdatedAtEpochMs: 11,
                    acceptedExpiresAtEpochMs: null, acceptedConfig,
                },
            },
        }];
        expect(deriveApiV1StateWriteEvidence(
            spec, [physicalCommand], [effect], [], undefined, authoritative,
        )).toMatchObject({
            atomicCompletionFailures: 0,
            appInbox: [{ resourceId: physicalResourceId, commandIds: [commandId] }],
        });
    });

    it('rejects a production command decoder failure before trusting its result', () => {
        expect(deriveApiV1StateWriteEvidence(spec, [command], [effect], [], undefined, [{
            appInboxResourceId: commandId,
            valid: false,
            commandType: 'TOPOLOGY_CONFIG_PUT',
            commandIds: [],
            failure: 'topology command scope differs from queue identity',
        }])).toMatchObject({ statusResultFailures: 1 });
    });

});
