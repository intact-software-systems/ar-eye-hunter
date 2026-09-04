import { newALRoute, newALUntargetedMessage } from '@shared/al-contracts/al-contract.ts';
import { EnqueuedType } from '@shared/api/api-config.ts';
import { describe, expect, it, vi } from 'vitest';

import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { EffectiveGroupTopologyConfig, StoredGroupTopologyConfig } from '@shared/api/graph-topology-management-types.ts';
import { toCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import { QueueBoxUtilities } from '@shared/services/QueueBoxUtilities.ts';

import type { PersistedAuthSession } from '@shared-server/rallar-system/auth/persistence/persisted-auth-session.ts';

import type { IssuedAuthSession } from '@shared-server/rallar-system/auth/persistence/auth-session-types.ts';

import { authSessionProofSecret } from '@shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts';

import type { GroupStateService } from '@shared-server/rallar-system/group-state/group-state-service-contracts.ts';

import type { GroupStateAuthorityGuard } from '@shared-server/rallar-system/group-state/persistence/group-state-persistence-contracts.ts';

import { AppInboxType, type AppInboxEnqueueInput, type AppInboxMessageContext } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { encodeAppInboxResult } from '@shared-server/rallar-system/app-inbox/app-inbox-registration-codecs.ts';
import {
    computeRtcTopologyOutboxInsert,
    type ComputedRtcTopologyOutbox
} from '@shared-server/rallar-system/topology/mutation/rtc-topology-outbox-entry.ts';

import { createAuthenticatedTopologyEnqueue } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-authority.ts';

import { toTopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-command.ts';

import type { TopologyAppInboxCommand } from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-contracts.ts';
import {
    decodeTopologyAppInboxResult,
    TopologyAppInboxHandler,
    type TopologyAppInboxMutationOwners,
    type TopologyAppInboxResult
} from '@shared-server/rallar-system/topology/inbox/topology-app-inbox-handler.ts';

import { computeTopologyConfigRuntimeWrites } from '@shared-server/rallar-system/topology/config/mutation/compute-topology-config-runtime-writes.ts';
import type { GroupTopologyConfigMutationComputed } from '@shared-server/rallar-system/topology/config/mutation/group-topology-config-mutation-contracts.ts';
import type { GroupTopologyConfigMutationReceipt } from '@shared/api/graph-topology-management-types.ts';

import type { GroupTopologyConfigMutationAttemptRead } from '@shared-server/rallar-system/topology/config/group-topology-config-mutation-service.ts';

import type {
    GroupTopologyReconfigureComputed,
    GroupTopologyReconfigureRead
} from '@shared-server/rallar-system/topology/reconfigure/group-topology-reconfigure-contracts.ts';
import { createTestGroup } from '../../../../create-test-group.ts';

const NOW_EPOCH_MS = 1_000;
const GROUP_REF: GroupRef = {
    applicationId: 'app-1',
    workspaceId: 'workspace-1',
    groupId: 'room-1'
};
const SESSION: IssuedAuthSession = {
    clientId: 'owner',
    username: 'owner',
    sessionId: 'owner-session',
    accessToken: 'owner-token',
    issuedAtEpochMs: 500,
    expiresAtEpochMs: 2_000
};

describe('TopologyAppInboxHandler', () => {
    it('decodes an exact topology reconfigure result', () => {
        const result = {
            status: 'queued',
            groupRef: {
                applicationId: 'app-1',
                workspaceId: 'workspace-1',
                groupId: 'room-1'
            },
            requestId: 'request-1',
            outboxId: 'outbox-1'
        } as const;

        expect(decodeTopologyAppInboxResult(result)).toEqual(result);
        expect(() => decodeTopologyAppInboxResult({ ...result, stale: true })).toThrow(
            'Topology reconfigure AppInbox result fields are invalid'
        );
    });

    it('orders verification and mutation phases before post-commit wake', async () => {
        const phases: string[] = [];
        const context = await topologyContext(phases);
        const computed = configWriteComputed();
        if (computed.result.kind !== 'config') {
            throw new TypeError('Expected topology config mutation result');
        }
        const expected = { receipt: computed.receipt, config: computed.result.config };
        const owners = {
            configMutationService: {
                read: vi.fn(async () => {
                    phases.push('read');
                    return configRead();
                }),
                compute: vi.fn(() => {
                    phases.push('compute');
                    return computed;
                }),
                validate: vi.fn(() => {
                    phases.push('validate');
                }),
                write: vi.fn(async () => {
                    phases.push('write');
                    return computed.receipt;
                }),
                recordCommittedWrite: vi.fn(() => phases.push('observe'))
            },
            reconfigureMutation: unusedReconfigureMutation()
        } satisfies TopologyAppInboxMutationOwners;
        const wakeQueue = vi.fn(() => phases.push('wake'));
        const handler = new TopologyAppInboxHandler({
            groupStateService: sessionReader(phases),
            nowEpochMs: () => NOW_EPOCH_MS,
            wakeQueue,
            transactionWriter: {
                readCompletionFacts: (context) => {
                    phases.push('completion');
                    return { entry: context.entry, completedAtEpochMs: NOW_EPOCH_MS };
                },
                writeComputedMutation: async (_context, computed, write) => {
                    phases.push('transaction');
                    await write({} as PSqlSql);
                    phases.push('commit');
                    return computed.durableResult;
                }
            }
        });
        await expect(handler.processMutation(context, owners)).resolves.toEqual(expected);
        expect(phases).toEqual([
            'verify-authority',
            'completion',
            'read',
            'compute',
            'validate',
            'transaction',
            'write',
            'commit',
            'observe',
            'wake'
        ]);
    });

    it('rejects idempotency conflict before transaction or wake', async () => {
        const phases: string[] = [];
        const context = await topologyContext(phases);
        const unreachableTransaction = (): never => {
            phases.push('transaction');
            throw new Error('Idempotency conflicts must not open a transaction');
        };
        const wakeQueue = () => {
            phases.push('wake');
        };
        const owners = {
            configMutationService: {
                read: vi.fn(async () => configRead()),
                compute: vi.fn(
                    () =>
                        ({
                            outcome: 'idempotency-conflict',
                            existingCommandHash: 'sha256:existing',
                            receivedCommandHash: 'sha256:received'
                        }) as const
                ),
                validate: vi.fn(),
                write: vi.fn(async () => await Promise.reject(new Error('Unexpected config write'))),
                recordCommittedWrite: vi.fn()
            },
            reconfigureMutation: unusedReconfigureMutation()
        } satisfies TopologyAppInboxMutationOwners;
        const handler = new TopologyAppInboxHandler({
            groupStateService: sessionReader(phases),
            nowEpochMs: () => NOW_EPOCH_MS,
            transactionWriter: {
                readCompletionFacts: (messageContext) => {
                    phases.push('completion');
                    return {
                        entry: messageContext.entry,
                        completedAtEpochMs: NOW_EPOCH_MS
                    };
                },
                writeComputedMutation: async () => unreachableTransaction()
            },
            wakeQueue
        });

        await expect(handler.processMutation(context, owners)).rejects.toMatchObject({
            code: 'group-topology-config-idempotency-conflict'
        });
        expect(phases).toEqual(['verify-authority', 'completion']);
    });

    it('keeps reconfigure read-compute-validate-write ordered and wakes after commit', async () => {
        const phases: string[] = [];
        const context = await reconfigureTopologyContext(phases);
        const owners = {
            configMutationService: unusedConfigMutationService(),
            reconfigureMutation: {
                read: vi.fn(async () => {
                    phases.push('read');
                    return reconfigureRead();
                }),
                compute: vi.fn(() => {
                    phases.push('compute');
                    return reconfigureComputed();
                }),
                validate: vi.fn(() => {
                    phases.push('validate');
                }),
                write: vi.fn(async () => {
                    phases.push('write');
                }),
                recordCommittedWrite: vi.fn(() => phases.push('observe'))
            }
        } satisfies TopologyAppInboxMutationOwners;
        const wakeQueue = vi.fn(() => phases.push('wake'));
        const handler = new TopologyAppInboxHandler({
            groupStateService: sessionReader(phases),
            nowEpochMs: () => NOW_EPOCH_MS,
            wakeQueue,
            transactionWriter: {
                readCompletionFacts: (context) => {
                    phases.push('completion');
                    return { entry: context.entry, completedAtEpochMs: NOW_EPOCH_MS };
                },
                writeComputedMutation: async (_context, computed, write) => {
                    phases.push('transaction');
                    await write({} as PSqlSql);
                    phases.push('commit');
                    return computed.durableResult;
                }
            }
        });

        await expect(handler.processMutation(context, owners)).resolves.toMatchObject({
            status: 'queued',
            outboxId: 'reconfigure-outbox'
        });
        expect(phases).toEqual([
            'verify-authority',
            'completion',
            'read',
            'compute',
            'validate',
            'transaction',
            'write',
            'commit',
            'observe',
            'wake'
        ]);
    });
});

async function topologyContext(
    phases: string[]
): Promise<AppInboxMessageContext<TopologyAppInboxResult>> {
    const command = await toTopologyAppInboxCommand({
        actor: { principalId: SESSION.clientId, sessionId: SESSION.sessionId },
        groupRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        },
        requestId: 'handler-request',
        capturedAtEpochMs: NOW_EPOCH_MS,
        payload: { operation: 'putConfig', config: { topologyKind: 'tree' } }
    });
    const enqueue = await createAuthenticatedTopologyEnqueue({
        enqueue: {
            type: AppInboxType.TOPOLOGY_CONFIG_PUT,
            resourceId: command.requestId,
            data: command
        },
        claimedAuthority: SESSION,
        groupStateService: sessionReader(phases, false),
        nowEpochMs: () => NOW_EPOCH_MS
    });
    return createMessageContext(enqueue);
}

async function reconfigureTopologyContext(
    phases: string[]
): Promise<AppInboxMessageContext<TopologyAppInboxResult>> {
    const command = await toTopologyAppInboxCommand({
        actor: { principalId: SESSION.clientId, sessionId: SESSION.sessionId },
        groupRef: {
            applicationId: 'app-1',
            workspaceId: 'workspace-1',
            groupId: 'room-1'
        },
        requestId: 'handler-request',
        capturedAtEpochMs: NOW_EPOCH_MS,
        payload: { operation: 'reconfigureTopology', requestOptions: {}, publish: true }
    });
    const enqueue = await createAuthenticatedTopologyEnqueue({
        enqueue: {
            type: AppInboxType.TOPOLOGY_RECONFIGURE,
            resourceId: command.requestId,
            data: command
        },
        claimedAuthority: SESSION,
        groupStateService: sessionReader(phases, false),
        nowEpochMs: () => NOW_EPOCH_MS
    });
    return createMessageContext(enqueue);
}

function sessionReader(
    phases: string[],
    recordRead = true
): Pick<GroupStateService, 'readIssuedAuthSession'> {
    return {
        readIssuedAuthSession: async () => {
            if (recordRead) {
                phases.push('verify-authority');
            }
            return await persistedSession();
        }
    };
}

function createMessageContext(
    enqueue: AppInboxEnqueueInput
): AppInboxMessageContext<TopologyAppInboxResult> {
    const wireEnqueue = enqueue;
    const message = newALUntargetedMessage(
        'topology-handler-test',
        newALRoute(
            wireEnqueue.topicId ?? 'app-inbox.group-state',
            wireEnqueue.contextId ?? 'topology-handler-context',
            requireResourceId(wireEnqueue.resourceId)
        ),
        wireEnqueue.type,
        wireEnqueue
    );
    const entry = QueueBoxUtilities.toResourceEntryFromMsg(message, EnqueuedType.APP_INBOX);
    return {
        enqueue: wireEnqueue,
        message,
        encodeResult: (result) => encodeAppInboxResult(result, 'Topology handler test result'),
        entry: {
            ...entry,
            status: EntityStatus.RESERVED,
            dequeueAudit: { ...entry.dequeueAudit, attempts: 7 }
        }
    };
}

function requireResourceId(value: string | undefined): string {
    if (!value) {
        throw new TypeError('Topology AppInbox test resourceId is required');
    }
    return value;
}

async function persistedSession(): Promise<PersistedAuthSession> {
    return {
        clientId: SESSION.clientId,
        username: SESSION.username,
        sessionId: SESSION.sessionId,
        accessTokenDigest: await authSessionProofSecret(SESSION),
        issuedAtEpochMs: SESSION.issuedAtEpochMs,
        expiresAtEpochMs: SESSION.expiresAtEpochMs
    };
}

function configRead(): GroupTopologyConfigMutationAttemptRead {
    return {
        state: {
            config: null,
            override: null,
            configGeneration: null,
            overrideGeneration: null,
            invariantGeneration: null,
            idempotency: null,
            groupSnapshot: groupSnapshot(),
            groupAuthorityGuard: groupAuthorityGuard()
        },
        policyNowEpochMs: NOW_EPOCH_MS,
        isPlatformAdmin: false,
        serverDefaults: {}
    };
}

function configWriteComputed(): Extract<GroupTopologyConfigMutationComputed, { outcome: 'write'; }> {
    const config = storedConfig();
    const receipt = configReceipt();
    const computed = {
        outcome: 'write',
        groupAuthorityGuard: groupAuthorityGuard(),
        guard: {
            target: 'config',
            operation: 'insert',
            expectedRevision: null,
            value: config
        },
        invariantGenerationGuard: {
            expectedRevision: null,
            value: { groupRef: GROUP_REF, version: 1 }
        },
        generationGuard: {
            expectedRevision: null,
            value: { groupRef: GROUP_REF, target: 'config', version: 1 }
        },
        receipt,
        idempotency: null,
        outboxWrite: computeRtcTopologyOutboxInsert(
            topologyOutbox('handler-request:config-outbox')
        ),
        result: { kind: 'config', config }
    } satisfies Omit<Extract<GroupTopologyConfigMutationComputed, { outcome: 'write'; }>, 'runtimeWrites'>;
    return { ...computed, runtimeWrites: computeTopologyConfigRuntimeWrites(computed) };
}

function reconfigureRead(): GroupTopologyReconfigureRead {
    const effective = effectiveTopologyConfig();
    return {
        authority: {
            group: groupSnapshot(),
            config: {
                serverDefaults: effective,
                durable: null,
                temporary: null,
                requestOptions: null,
                effective
            },
            kindHysteresisWidths: { meshExitWidth: 1, treeExitWidth: 1 },
            rttReportingDegreeLimit: effective.degreeLimit,
            rttMeasurements: [],
            replanning: 'auto',
            nowEpochMs: NOW_EPOCH_MS
        },
        authorityGuard: groupAuthorityGuard(),
        actorIsPlatformAdmin: false
    };
}

function reconfigureComputed(): GroupTopologyReconfigureComputed {
    const outbox = topologyOutbox('reconfigure-outbox');
    const authorityGuard = groupAuthorityGuard();
    return {
        ...outbox,
        authorityGuard,
        authorityWrite: {
            namespace: 'groups',
            key: authorityGuard.entry.key,
            value: authorityGuard.entry.value,
            expireAtIsoTimestamp: new Date(
                authorityGuard.entry.expireAtTimestamp
            ).toISOString(),
            expectedRevision: authorityGuard.entry.revision,
            expectedResultRevision: authorityGuard.entry.revision + 1
        },
        outboxWrite: computeRtcTopologyOutboxInsert(outbox)
    };
}

function unusedConfigMutationService(): TopologyAppInboxMutationOwners['configMutationService'] {
    return {
        read: async () => await Promise.reject(new Error('Unexpected config read')),
        compute: () => {
            throw new Error('Unexpected config compute');
        },
        validate: () => {
            throw new Error('Unexpected config validation');
        },
        write: async () => await Promise.reject(new Error('Unexpected config write')),
        recordCommittedWrite: () => undefined
    };
}

function unusedReconfigureMutation(): TopologyAppInboxMutationOwners['reconfigureMutation'] {
    return {
        read: async () => await Promise.reject(new Error('Unexpected reconfigure read')),
        compute: () => {
            throw new Error('Unexpected reconfigure compute');
        },
        validate: () => {
            throw new Error('Unexpected reconfigure validation');
        },
        write: async () => await Promise.reject(new Error('Unexpected reconfigure write')),
        recordCommittedWrite: () => undefined
    };
}

function topologyOutbox(resourceId: string): ComputedRtcTopologyOutbox {
    return {
        commandId: 'handler-request',
        aggregateRef: GROUP_REF,
        acceptedCausalRevision: { groupRevision: 1, presenceRevision: 0 },
        groupSnapshot: groupSnapshot(),
        effectKind: 'rtc-topology-recompute',
        payloadKind: 'group-revision',
        origin: 'automatic',
        createdAtEpochMs: NOW_EPOCH_MS,
        expireAtEpochMs: 2_000,
        senderId: 'owner',
        resourceId,
        requestOptions: toCanonicalGroupTopologyConfigPatch({ topologyKind: 'tree' }),
        publish: true
    };
}

function configReceipt(): GroupTopologyConfigMutationReceipt {
    return {
        commandId: 'handler-request',
        requestId: 'handler-request',
        commandHash: `sha256:${'a'.repeat(64)}`,
        operation: 'putConfig',
        outcome: 'applied',
        attemptCount: 7,
        groupRef: GROUP_REF,
        target: 'config',
        acceptedVersion: 1,
        acceptedStorageRevision: 0,
        acceptedCreatedAtEpochMs: NOW_EPOCH_MS,
        acceptedUpdatedAtEpochMs: NOW_EPOCH_MS,
        acceptedExpiresAtEpochMs: null,
        acceptedConfig: effectiveTopologyConfig(),
        acceptedCausalRevision: {
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0
        },
        eventId: null,
        outboxIds: ['handler-request:config-outbox']
    };
}

function storedConfig(): StoredGroupTopologyConfig {
    return {
        groupRef: GROUP_REF,
        config: effectiveTopologyConfig(),
        version: 1,
        createdAtEpochMs: NOW_EPOCH_MS,
        updatedAtEpochMs: NOW_EPOCH_MS,
        updatedByPrincipalId: 'owner',
        requestId: 'handler-request'
    };
}

function effectiveTopologyConfig(): EffectiveGroupTopologyConfig {
    return {
        topologyKind: 'tree',
        degreeLimit: 5,
        treeMinSize: 5,
        meshMinSize: 16,
        meshParamK: 2
    };
}

function groupAuthorityGuard(): GroupStateAuthorityGuard {
    return {
        groupRef: GROUP_REF,
        entry: {
            key: 'group:room-1',
            value: JSON.stringify(groupSnapshot()),
            expireAtTimestamp: 2_000,
            updatedTimestamp: '1970-01-01T00:00:01.000Z',
            revision: 0
        },
        causalGroupRevision: 1
    };
}

function groupSnapshot(): GroupSnapshot {
    return {
        causalRevision: { groupRevision: 1, presenceRevision: 0 },
        group: createTestGroup({
            ...GROUP_REF,
            ownerPrincipalId: 'owner',
            snapshotVersion: 1,
            metadataVersion: 1,
            rosterVersion: 1,
            presenceVersion: 0
        }),
        members: [],
        activeSessions: [],
        memberCount: 0,
        onlineMemberCount: 0
    };
}
