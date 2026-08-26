import { describe, expect, it, vi } from 'vitest';
import { compareStateWriteArtifacts, validateStateWriteArtifact } from '../../../../../scripts/perf/compare-api-v1-state-write-results.mjs';

import { AppInboxType } from '@shared-server/rallar-system/app-inbox/app-inbox-contracts.ts';
import { mutationDescriptor, toDescriptorCommand } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationDescriptorTargetIdentity } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import { toScopedGroupMutationCommandId } from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import { decodeJsonWireValue, hashMutationCommand } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import {
    readScopedGroupCommandIdentity,
    readValidatedGroupReceiptIdentity,
    type ScopedGroupCommandExpectation
} from '../../../../../scripts/perf/api-v1-state-write-group-receipt-evidence.ts';
import {
    computeProductionOutboxEvidence,
    computeProductionOutboxExpectations,
    createProductionOutboxRepository,
    readAllCommandIds,
    readCanonicalEffectCommandId,
    readResourceEffectKind
} from '../../../../../scripts/perf/api-v1-state-write-outbox-evidence.ts';
import { classifyBenchmarkSql } from '../../../../../scripts/perf/create-instrumented-state-write-sql.ts';
import {
    readStateWriteAppInboxIdentity,
    toStateWriteAppInboxExpectations
} from '../../../../../scripts/perf/state-write/api-v1-state-write-app-inbox-evidence.ts';
import { STATE_WRITE_REASONS } from '../../../../../scripts/perf/state-write/api-v1-state-write-regression-reasons.ts';

import { parseBenchmarkOptions } from '../../../../../scripts/perf/state-write/api-v1-state-write-benchmark-options.ts';
import {
    createDefaultStateWritePerformanceArtifact,
    refreshStateWritePerformanceWorkload,
    swapCompleteDurableResults,
    type StateWriteAppInboxEvidenceEntry,
    type StateWriteDurableEvidence,
    type StateWritePerformanceArtifact,
    type StateWritePerformanceSample
} from './test-support/state-write-performance-artifact-fixture.ts';
import { binding, type StateWritePresenceDurableResult, type StateWriteTopologyDurableResult } from './test-support/state-write-performance-result-fixture.ts';

describe('API-v1 state-write final durable evidence', { timeout: 30_000 }, () => {
    it('reads a scoped group command only from its exact actor, workspace, group, topic, and context', async () => {
        const requestId = 'state-write:config:7';
        const actorPrincipalId = 'client-7';
        const groupRef = {
            applicationId: 'state-write-run-uncontended-measured-0',
            workspaceId: 'state-write-workspace-with-a-benchmark-length-identity',
            groupId: 'group-2'
        };
        const topicId = AppInboxType.GROUP_UPDATE;
        const logicalContextId = [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId]
            .map(encodeURIComponent)
            .join(':');
        const physicalKey = toAppQueueKey({
            resourceId: requestId,
            topicId,
            contextId: logicalContextId
        });
        const descriptor = mutationDescriptor({
            operation: 'updateGroup',
            scope: {
                applicationId: groupRef.applicationId,
                workspaceId: groupRef.workspaceId
            },
            groupId: groupRef.groupId,
            request: {
                metadata: { benchmarkConfigSource: requestId },
                actorPrincipalId,
                requestId
            }
        });
        const commandId = await toScopedGroupMutationCommandId(descriptor, actorPrincipalId);
        const semanticCommand = toDescriptorCommand(descriptor, () => requestId);
        const commandHash = await hashMutationCommand(decodeJsonWireValue(semanticCommand));
        const command = {
            ...semanticCommand,
            commandId
        };
        const resource = JSON.stringify({
            payload: {
                typeId: topicId,
                resource: JSON.stringify({
                    type: topicId,
                    topicId,
                    resourceId: requestId,
                    contextId: logicalContextId,
                    authority: {
                        authorityProof: {
                            version: 1,
                            principalId: actorPrincipalId,
                            sessionId: 'client-session-7',
                            sessionIssuedAtEpochMs: 1,
                            sessionExpiresAtEpochMs: 2,
                            commandMac: 'mac'
                        },
                        descriptor,
                        command,
                        facts: { commandHash },
                        causalToken: 'causal-token',
                        queueResourceId: 'g-queue-resource'
                    }
                })
            }
        });
        const row = {
            ri_resource_id: physicalKey.resourceId,
            ri_topic_id: physicalKey.topicId,
            fk_ext_bank_id: physicalKey.contextId,
            ri_resource: resource
        };
        const expectation: ScopedGroupCommandExpectation = {
            requestId,
            topicId,
            logicalContextId,
            groupRef,
            actorPrincipalId
        };

        await expect(readScopedGroupCommandIdentity(row, expectation)).resolves.toEqual({
            requestId,
            commandId,
            commandHash
        });
        await expect(readScopedGroupCommandIdentity(row, {
            ...expectation,
            groupRef: { ...groupRef, workspaceId: 'wrong-workspace' }
        })).resolves.toBeUndefined();
        await expect(readScopedGroupCommandIdentity(row, {
            ...expectation,
            actorPrincipalId: 'wrong-actor'
        })).resolves.toBeUndefined();

        const changedHashResource = JSON.parse(resource);
        changedHashResource.payload.resource = JSON.stringify({
            ...JSON.parse(changedHashResource.payload.resource),
            authority: {
                ...JSON.parse(changedHashResource.payload.resource).authority,
                facts: { commandHash: `sha256:${'f'.repeat(64)}` }
            }
        });
        await expect(readScopedGroupCommandIdentity({
            ...row,
            ri_resource: JSON.stringify(changedHashResource)
        }, expectation)).resolves.toBeUndefined();

        const wrongTopicId = AppInboxType.GROUP_MEMBER_UPSERT;
        const wrongTopicKey = toAppQueueKey({
            resourceId: requestId,
            topicId: wrongTopicId,
            contextId: logicalContextId
        });
        await expect(readScopedGroupCommandIdentity({
            ...row,
            ri_resource_id: wrongTopicKey.resourceId,
            ri_topic_id: wrongTopicKey.topicId,
            fk_ext_bank_id: wrongTopicKey.contextId,
            ri_resource: resource.replaceAll(topicId, wrongTopicId)
        }, {
            ...expectation,
            topicId: wrongTopicId
        })).resolves.toBeUndefined();

        const scopedCommand = { requestId, commandId, commandHash };
        const record = groupIdempotencyRecord(scopedCommand, groupRef);
        expect(readValidatedGroupReceiptIdentity({
            value: record,
            ref: groupRef,
            scopedCommand
        })).toEqual(record);
        expect(readValidatedGroupReceiptIdentity({
            value: {
                ...record,
                commandHash: `sha256:${'e'.repeat(64)}`,
                receipt: {
                    ...record.receipt,
                    commandHash: `sha256:${'e'.repeat(64)}`
                }
            },
            ref: groupRef,
            scopedCommand
        })).toBeUndefined();
    });

    it('uses production presence target identities when validating a scoped group command', async () => {
        const requestId = 'state-write:presence-connect:8';
        const actorPrincipalId = 'client-8';
        const sessionId = 'state-write:client-8:session-8';
        const groupRef = {
            applicationId: 'state-write-run-uncontended-measured-0',
            workspaceId: 'state-write-workspace-with-a-benchmark-length-identity',
            groupId: 'group-8'
        };
        const topicId = AppInboxType.GROUP_PRESENCE_CONNECT;
        const logicalContextId = [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId]
            .map(encodeURIComponent)
            .join(':');
        const descriptor = mutationDescriptor({
            operation: 'connectPresence',
            scope: { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupId: groupRef.groupId,
            request: {
                principalId: actorPrincipalId,
                generationId: `${sessionId}:generation-1`,
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 61_000,
                actorPrincipalId,
                actorSessionId: sessionId,
                requestId
            },
            targetPrincipalId: actorPrincipalId,
            sessionId
        });
        const commandId = await toScopedGroupMutationCommandId(descriptor, actorPrincipalId);
        const semanticCommand = toDescriptorCommand(descriptor, () => requestId);
        const commandHash = await hashMutationCommand(decodeJsonWireValue(semanticCommand));
        const command = { ...semanticCommand, commandId };
        const physicalKey = toAppQueueKey({ topicId, resourceId: requestId, contextId: logicalContextId });
        const row = {
            ri_resource_id: physicalKey.resourceId,
            ri_topic_id: physicalKey.topicId,
            fk_ext_bank_id: physicalKey.contextId,
            ri_resource: JSON.stringify({
                payload: {
                    typeId: topicId,
                    resource: JSON.stringify({
                        type: topicId,
                        topicId,
                        resourceId: requestId,
                        contextId: logicalContextId,
                        authority: {
                            authorityProof: {
                                version: 1,
                                principalId: actorPrincipalId,
                                sessionId,
                                sessionIssuedAtEpochMs: 1,
                                sessionExpiresAtEpochMs: 2,
                                commandMac: 'mac'
                            },
                            descriptor,
                            command,
                            facts: { commandHash },
                            causalToken: 'causal-token',
                            queueResourceId: 'g-queue-resource'
                        }
                    })
                }
            })
        };

        await expect(readScopedGroupCommandIdentity(row, {
            requestId,
            topicId,
            logicalContextId,
            groupRef,
            actorPrincipalId
        })).resolves.toEqual({ requestId, commandId, commandHash });
    });

    it('links an AppInbox attempt only through its exact production physical tuple', () => {
        const scope = {
            applicationId: 'state-write-run-uncontended-measured-0',
            workspaceId: 'state-write-workspace-with-a-benchmark-length-identity'
        };
        const command = {
            kind: 'profile-instance',
            commandId: `${scope.applicationId}:profile-instance:7`
        } as const;
        const expectation = toStateWriteAppInboxExpectations([command], scope, 5)
            .find((candidate) => candidate.operationId === 'profile');
        if (!expectation) {
            throw new Error('Expected profile AppInbox fixture');
        }
        const resource = queueResource(
            {
                type: expectation.topicId,
                topicId: expectation.topicId,
                resourceId: expectation.logicalResourceId,
                contextId: expectation.logicalContextId,
                data: { request: { requestId: expectation.logicalResourceId } }
            },
            undefined,
            {
                ...expectation.physicalKey,
                payloadTypeId: expectation.topicId
            }
        );
        const row = {
            ri_resource_id: expectation.physicalKey.resourceId,
            ri_topic_id: expectation.physicalKey.topicId,
            fk_ext_bank_id: expectation.physicalKey.contextId,
            ri_resource: resource
        };

        expect(readStateWriteAppInboxIdentity(row, expectation)).toEqual({
            commandId: command.commandId,
            operationId: 'profile',
            commandType: expectation.topicId
        });
        expect(readStateWriteAppInboxIdentity({
            ...row,
            fk_ext_bank_id: toAppQueueKey({
                ...expectation.physicalKey,
                contextId: `${expectation.logicalContextId}:wrong`
            }).contextId
        }, expectation)).toBeUndefined();
        expect(readStateWriteAppInboxIdentity({
            ...row,
            ri_resource_id: toAppQueueKey({
                ...expectation.physicalKey,
                resourceId: `${expectation.logicalResourceId}-wrong`
            }).resourceId
        }, expectation)).toBeUndefined();
    });

    it.each(['joinGroup', 'acceptGroupInvite'] as const)(
        'keeps the descriptor target empty for %s after resolving its command principal',
        (operation) => {
            const actorPrincipalId = 'client-admission';
            const descriptor = mutationDescriptor({
                operation,
                scope: { applicationId: 'app', workspaceId: 'workspace' },
                groupId: 'group',
                request: {
                    actorPrincipalId,
                    actorSessionId: 'session',
                    requestId: `request-${operation}`
                }
            });
            const command = toDescriptorCommand(descriptor, () => `command-${operation}`);
            if (command.operation !== operation) {
                throw new Error(`Expected ${operation} command`);
            }
            expect(command.targetPrincipalId).toBe(actorPrincipalId);
            expect(toGroupMutationDescriptorTargetIdentity(command)).toEqual({
                targetPrincipalId: null,
                sessionId: null
            });
        }
    );

    it('matches benchmark-length outbox identities produced by the production queue constructor', async () => {
        const command = {
            kind: 'membership',
            commandId: 'state-write:membership:7',
            stackIndex: 0,
            latencyMs: 1,
            status: 'accepted'
        } as const;
        const aggregateRef = {
            applicationId: 'state-write-run-uncontended-measured-0',
            workspaceId: 'state-write-workspace-with-a-benchmark-length-identity',
            groupId: 'group-7'
        };
        const scopedCommandId = `group-app-inbox:${'a'.repeat(64)}`;
        const entry = computeGroupPresenceSummaryEntry({
            effectKind: 'group-presence-summary',
            aggregateRef,
            commandId: scopedCommandId,
            createdAtEpochMs: 1_000,
            expireAtEpochMs: 100_000,
            acceptedCausalRevision: { groupRevision: 4, presenceRevision: 3 },
            event: {
                ...aggregateRef,
                eventId: 'summary-event',
                eventType: 'session-connected',
                snapshotVersion: 4,
                causalRevision: { groupRevision: 4, presenceRevision: 3 },
                occurredAtEpochMs: 1_000,
                actor: { kind: 'service', serviceId: 'summary-handler' },
                reason: null,
                traceId: null,
                requestId: command.commandId,
                payload: {}
            }
        }, 'summary-handler');
        const receipt = {
            commandId: command.commandId,
            receiptIds: [scopedCommandId],
            outboxIds: [entry.key.resourceId],
            identityKind: 'physical-resource-id' as const,
            resultBindings: [{
                operationId: 'command',
                receiptId: scopedCommandId,
                requestId: command.commandId,
                commandHash: `sha256:${'b'.repeat(64)}`,
                outcome: 'applied',
                attemptCount: 1,
                outboxIds: [entry.key.resourceId],
                aggregateRef,
                stateRevision: null,
                causalRevision: { groupRevision: 4, presenceRevision: 3 },
                snapshotVersion: 4,
                acceptedVersion: null,
                operation: null,
                target: null,
                acceptedStorageRevision: null,
                acceptedCreatedAtEpochMs: null,
                acceptedUpdatedAtEpochMs: null,
                acceptedExpiresAtEpochMs: null,
                acceptedConfig: null,
                acceptedCausalRevision: null,
                eventId: 'summary-event'
            }]
        };
        const [expectation] = computeProductionOutboxExpectations([command], [receipt]);
        if (!expectation) {
            throw new Error('Expected group-presence-summary outbox fixture');
        }
        const row = {
            ri_resource_id: entry.key.resourceId,
            ri_topic_id: entry.key.topicId,
            fk_ext_bank_id: entry.key.contextId,
            ri_type_id: entry.typeId,
            ri_resource: entry.resource
        };
        const repository = createProductionOutboxRepository(vi.fn(async () => [row]) as never);

        expect(expectation.physicalKey).toEqual(entry.key);
        expect(expectation.logicalContextId.length).toBeGreaterThan(entry.key.contextId.length);
        await expect(repository.find(expectation)).resolves.toMatchObject({
            record: {
                resourceId: entry.key.resourceId,
                outboxId: expect.stringContaining(':group-presence-summary:'),
                canonicalCommandId: scopedCommandId
            }
        });
    });

    it('selects outbox evidence by the exact tuple and rejects an ambiguous duplicate', async () => {
        const command = {
            kind: 'topology-source',
            commandId: 'topology-command',
            stackIndex: 0,
            latencyMs: 1,
            status: 'accepted'
        } as const;
        const topologyBinding = binding(command, 'command');
        const receipt = {
            commandId: command.commandId,
            receiptIds: [command.commandId],
            outboxIds: topologyBinding.outboxIds,
            identityKind: 'logical-msg-id' as const,
            resultBindings: [topologyBinding]
        };
        const [expectation] = computeProductionOutboxExpectations([command], [receipt]);
        if (!expectation) {
            throw new Error('Expected topology outbox fixture');
        }
        const exactRow = {
            ri_resource_id: expectation.physicalKey.resourceId,
            ri_topic_id: expectation.physicalKey.topicId,
            fk_ext_bank_id: expectation.physicalKey.contextId,
            ri_type_id: expectation.typeId,
            ri_resource: queueResource(
                {
                    type: expectation.payloadTypeId,
                    topicId: expectation.physicalKey.topicId,
                    resourceId: expectation.effectId,
                    contextId: expectation.logicalContextId,
                    senderId: 'server-1',
                    data: {}
                },
                expectation.effectId,
                {
                    resourceId: expectation.physicalKey.resourceId,
                    topicId: expectation.physicalKey.topicId,
                    contextId: expectation.physicalKey.contextId,
                    payloadTypeId: expectation.payloadTypeId
                }
            )
        };
        const wrongTopicRow = {
            ...exactRow,
            ri_topic_id: 'wrong-topic'
        };
        const rows = [wrongTopicRow, exactRow];
        const sql = vi.fn(async () => rows);
        const repository = createProductionOutboxRepository(sql as never);

        await expect(repository.find(expectation)).resolves.toMatchObject({
            record: {
                resourceId: expectation.physicalKey.resourceId,
                outboxId: expectation.effectId,
                topicId: expectation.physicalKey.topicId
            }
        });

        rows.push({ ...exactRow });
        await expect(repository.find(expectation)).rejects.toThrow(
            'Receipt resolves to ambiguous exact ResourceInbox effects'
        );
    });

    it('accepts a complete AppInbox/ResourceInbox artifact for both comparison roles', () => {
        const candidate = createDefaultStateWritePerformanceArtifact();
        const sample = artifactSample(candidate);
        expect(candidate.measurement.counterSources.outbox).toBe('resource_inbox');
        expect(candidate.measurement.counterSources.attempts).toBe(
            'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation'
        );
        expect(sample.durableEvidence.intermediateMutationIntents).toEqual([]);
        expect(sample.correctness.atomicCompletionFailures).toBe(0);
        expect(candidate).not.toHaveProperty('features');
        expect(validateStateWriteArtifact(candidate)).toEqual([]);
    });

    it('accepts scoped physical group receipt identities distinct from public request IDs', () => {
        const candidate = createDefaultStateWritePerformanceArtifact();
        const sample = artifactSample(candidate);
        const command = sample.commands.find((entry) => entry.kind === 'membership');
        if (!command) {
            throw new Error('Expected membership command fixture');
        }
        const receipt = sample.durableEvidence.receipts.find(
            (entry) => entry.commandId === command.commandId
        );
        if (!receipt) {
            throw new Error('Expected membership receipt fixture');
        }
        const binding = receipt.resultBindings[0];

        expect(binding.receiptId).toMatch(/^group-app-inbox:[0-9a-f]{64}$/);
        expect(binding.receiptId).not.toBe(command.commandId);
        expect(binding.requestId).toBe(command.commandId);
        expect(validateStateWriteArtifact(candidate)).toEqual([]);
    });

    it('tolerates equal throughput between baseline and candidate', () => {
        expect(
            compareStateWriteArtifacts(
                createDefaultStateWritePerformanceArtifact(),
                createDefaultStateWritePerformanceArtifact()
            )
        ).toEqual([]);
    });

    it('tolerates throughput variance within 5% and rejects beyond it', () => {
        const withinTolerance = createDefaultStateWritePerformanceArtifact();
        setThroughputAdverseRatio(withinTolerance, 0.04);
        expect(
            compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), withinTolerance)
        ).toEqual([]);

        const beyondTolerance = createDefaultStateWritePerformanceArtifact();
        setThroughputAdverseRatio(beyondTolerance, 0.06);
        expect(
            compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), beyondTolerance)
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining('shared throughput regressed by more than 5%'),
                expect.stringContaining('hot throughput regressed by more than 5%')
            ])
        );
    });

    it('rejects intermediate intents and service-local attempt evidence', () => {
        const candidate = createDefaultStateWritePerformanceArtifact();
        const sample = candidate.workloads[0].samples[0];
        sample.durableEvidence.intermediateMutationIntents.push({ intentId: 'forbidden' });
        sample.attemptObservations[0].source = 'group-state-service.mutation.conflict';
        expectStateWriteArtifactIssues(
            candidate,
            'intermediateMutationIntents must be exactly empty',
            'production ResourceInbox release telemetry'
        );
    });

    it('rejects missing same-observation completion components', () => {
        for (
            const mutate of [
                (sample: StateWritePerformanceSample) => sample.durableEvidence.appInbox.shift(),
                (sample: StateWritePerformanceSample) => sample.durableEvidence.receipts.shift(),
                (sample: StateWritePerformanceSample) => sample.durableEvidence.resourceOutbox.shift()
            ]
        ) {
            const candidate = createDefaultStateWritePerformanceArtifact();
            mutate(artifactSample(candidate));
            refreshStateWritePerformanceWorkload(candidate.workloads[0]);
            expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
        }
    });

    it('rejects malformed retry delay, due age, lane, and transaction evidence', () => {
        for (const field of ['retryDelayMs', 'dueAgeMs', 'transactionDurationMs'] as const) {
            const candidate = createDefaultStateWritePerformanceArtifact();
            durableEvidence(candidate).appInbox[0][field] = -1;
            expectStateWriteArtifactIssues(candidate, 'appInbox[0] is malformed');
        }
        const lane = createDefaultStateWritePerformanceArtifact();
        durableEvidence(lane).appInbox[0].selectedLane = 'unknown';
        expect(validateStateWriteArtifact(lane)).not.toEqual([]);
    });

    it('rejects invented retry history and zero-delay nonterminal conflicts', () => {
        const invented = createDefaultStateWritePerformanceArtifact();
        const inventedSample = artifactSample(invented);
        inventedSample.attemptObservations.splice(1, 0, {
            ...inventedSample.attemptObservations[0],
            attempt: 2
        });
        expectStateWriteArtifactIssues(invented, 'must reconcile exactly to durable AppInbox attempts');
        const zeroDelay = createDefaultStateWritePerformanceArtifact();
        const sample = artifactSample(zeroDelay);
        const first = sample.attemptObservations[0];
        first.outcome = 'conflicted';
        first.terminal = false;
        first.retryDelayMs = 0;
        sample.attemptObservations.splice(1, 0, {
            ...first,
            attempt: 2,
            outcome: 'accepted',
            terminal: true
        });
        sample.durableEvidence.appInbox[0].attempts = 2;
        expectStateWriteArtifactIssues(zeroDelay, 'nonterminal retryDelayMs must be positive');
    });

    it('distinguishes typed transient retries from optimistic conflicts', () => {
        const candidate = createDefaultStateWritePerformanceArtifact();
        const sample = artifactSample(candidate);
        const first = sample.attemptObservations[0];
        first.outcome = 'transient-retry';
        first.terminal = false;
        first.retryDelayMs = 2;
        first.failure = { kind: 'retryable', code: 'ECONNRESET', name: 'Error' };
        sample.attemptObservations.splice(1, 0, {
            ...first,
            attempt: 2,
            outcome: 'accepted',
            terminal: true,
            failure: { kind: 'none' }
        });
        sample.durableEvidence.appInbox[0].attempts = 2;
        refreshStateWritePerformanceWorkload(candidate.workloads[0]);
        expect(validateStateWriteArtifact(candidate)).toEqual([]);
        first.outcome = 'conflicted';
        expectStateWriteArtifactIssues(candidate, 'only recognized optimistic conflicts');
    });

    it('rejects malformed durable results and receipt/effect identity mismatches', () => {
        for (const [mutate, expected] of malformedDurableResultCases) {
            const artifact = createDefaultStateWritePerformanceArtifact();
            mutate(artifact);
            expectStateWriteArtifactIssues(artifact, expected);
        }
        for (const prefix of ['CLIENT_', 'GROUP_']) {
            const swapped = createDefaultStateWritePerformanceArtifact();
            swapCompleteDurableResults(swapped, prefix);
            expect(validateStateWriteArtifact(swapped)).not.toEqual([]);
        }
        const missingTopologySibling = createDefaultStateWritePerformanceArtifact();
        const missingEntry = findTopologyEntry(missingTopologySibling);
        Reflect.deleteProperty(missingEntry.durableResult, 'config');
        expect(validateStateWriteArtifact(missingTopologySibling)).not.toEqual([]);
        const swappedTopologySibling = createDefaultStateWritePerformanceArtifact();
        const topologyEntries = findTopologyEntries(swappedTopologySibling);
        [topologyEntries[0].durableResult.config, topologyEntries[1].durableResult.config] = [
            topologyEntries[1].durableResult.config,
            topologyEntries[0].durableResult.config
        ];
        expect(validateStateWriteArtifact(swappedTopologySibling)).not.toEqual([]);
    });

    it('is total over malformed nested candidate evidence', () => {
        for (
            const mutate of [
                (candidate: StateWritePerformanceArtifact) => Reflect.set(artifactSample(candidate), 'durableEvidence', null),
                (candidate: StateWritePerformanceArtifact) => Reflect.deleteProperty(durableEvidence(candidate).appInbox, '0'),
                (candidate: StateWritePerformanceArtifact) => Reflect.set(durableEvidence(candidate).receipts, '0', null),
                (candidate: StateWritePerformanceArtifact) => Reflect.set(durableEvidence(candidate).resourceOutbox, '0', null)
            ]
        ) {
            const candidate = createDefaultStateWritePerformanceArtifact();
            mutate(candidate);
            expect(() => validateStateWriteArtifact(candidate)).not.toThrow();
            expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
            expect(() => compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), candidate)).not.toThrow();
        }
    });

    // Resource counters follow retry attempt counts, which follow timing, so an
    // identical-code control drifts (up to +2.7% measured, issue #157). The gate
    // has to absorb that drift and still catch a real resource regression.
    it('tolerates resource variance within 5% and rejects beyond it', () => {
        const withinTolerance = createDefaultStateWritePerformanceArtifact();
        setResourceAdverseRatio(withinTolerance, 0.04);
        expect(
            compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), withinTolerance)
        ).toEqual([]);

        const beyondTolerance = createDefaultStateWritePerformanceArtifact();
        setResourceAdverseRatio(beyondTolerance, 0.06);
        expect(
            compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), beyondTolerance)
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'uncontended median sql.serializedResultBytes regressed by more than 5% ' +
                        'without a recorded reason'
                ),
                expect.stringContaining(
                    'hot median sql.serializedResultBytes regressed by more than 5% ' +
                        'without a recorded reason'
                )
            ])
        );
    });

    it('lets a recorded reason authorize a resource regression beyond the band', () => {
        const authorized = createDefaultStateWritePerformanceArtifact();
        setResourceAdverseRatio(authorized, 0.06);
        authorized.regressionReasons = [...STATE_WRITE_REASONS];
        expect(compareStateWriteArtifacts(createDefaultStateWritePerformanceArtifact(), authorized)).toEqual(
            []
        );
    });

    it('preserves scale, retry-exhaustion, latency, throughput, and resource gates', () => {
        const baseline = createDefaultStateWritePerformanceArtifact();
        const candidate = createDefaultStateWritePerformanceArtifact();
        candidate.workloads[0].scale.clients = 99;
        candidate.workloads[0].summary.latencyMs.p95 *= 2;
        candidate.workloads[1].summary.throughputPerSecond = 1;
        candidate.workloads[1].summary.outcomes.exhausted = 1;
        candidate.workloads[1].summary.sql.statements += 1;
        expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('scale.clients must equal 100'),
                expect.stringContaining('summary.latencyMs.p95 does not match raw samples'),
                expect.stringContaining('summary.throughputPerSecond does not match raw samples'),
                expect.stringContaining('summary.outcomes.exhausted does not match raw samples'),
                expect.stringContaining('summary.sql.statements does not match sample median')
            ])
        );
    });

    it('records durable append resource costs without weakening hard throughput gates', () => {
        const reasons = STATE_WRITE_REASONS;
        expect(reasons).toHaveLength(12);
        expect(new Set(reasons.map(({ workload, metric }) => `${workload}:${metric}`))).toEqual(
            new Set(
                ['uncontended', 'shared', 'hot'].flatMap((workload) =>
                    [
                        'sql.statements',
                        'sql.rowsRead',
                        'sql.serializedResultBytes',
                        'postgres.transactionDurationMs'
                    ].map((metric) => `${workload}:${metric}`)
                )
            )
        );

        const baseline = createDefaultStateWritePerformanceArtifact();
        const candidate = createDefaultStateWritePerformanceArtifact();
        candidate.regressionReasons = [...reasons];
        setThroughputAdverseRatio(candidate, 0.06);
        expect(compareStateWriteArtifacts(baseline, candidate)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('shared throughput regressed by more than 5%'),
                expect.stringContaining('hot throughput regressed by more than 5%')
            ])
        );
    });

    it('keeps setup and evidence reads outside measured mutation timing', () => {
        expect(classifyBenchmarkSql('select * from resource_inbox', [])).toBe('read');
        expect(
            readResourceEffectKind({
                ri_resource_id: 'command:principal-state:event:revision=1',
                ri_topic_id: 'client-state.event',
                ri_type_id: 'WS_OUTBOX',
                ri_resource: '{}'
            })
        ).toBe('principal-state:event');
        expect(
            readAllCommandIds(queueResource({ request: { requestId: 'nested-command' } }))
        ).toContain('nested-command');
        expect(
            readAllCommandIds(
                queueResource(
                    { event: { requestId: 'stale-command' } },
                    'raw-command:rtc-topology-recompute:group-revision:group=1;presence=0'
                )
            )[0]
        ).toBe('raw-command');
        expect(
            readCanonicalEffectCommandId(
                queueResource(
                    { event: { requestId: 'config-command' } },
                    'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0'
                )
            )
        ).toBe('topology-command');
        const topologyCommand = {
            kind: 'topology-source',
            commandId: 'topology-command',
            stackIndex: 0,
            latencyMs: 1,
            status: 'accepted'
        } as const;
        const topologyRecord = {
            resourceId: 'stored-effect',
            outboxId: 'topology-command:rtc-topology-recompute:group-revision:group=1;presence=0',
            typeId: 'APP_OUTBOX',
            topicId: 'app-outbox.rtc-topology',
            effectKind: 'rtc-topology-recompute',
            canonicalCommandId: 'topology-command',
            commandIds: ['topology-command', 'config-command']
        } as const;
        expect(
            computeProductionOutboxEvidence({
                commands: [topologyCommand],
                receipts: [
                    {
                        commandId: 'topology-command',
                        receiptIds: ['topology-command'],
                        outboxIds: [topologyRecord.outboxId],
                        identityKind: 'logical-msg-id',
                        resultBindings: [binding(topologyCommand, 'command')]
                    }
                ],
                records: [topologyRecord]
            })[0]
        ).toMatchObject({
            commandId: 'topology-command',
            effectId: topologyRecord.outboxId,
            resourceId: 'stored-effect',
            outboxId: topologyRecord.outboxId
        });
        expect(
            computeProductionOutboxEvidence({
                commands: [topologyCommand],
                receipts: [],
                records: [topologyRecord]
            })
        ).toEqual([]);
        const groupCommand = {
            kind: 'membership',
            commandId: 'group-command',
            stackIndex: 0,
            latencyMs: 1,
            status: 'accepted'
        } as const;
        const groupBinding = binding(groupCommand, 'command');
        const groupRecord = {
            resourceId: groupBinding.outboxIds[0],
            outboxId: `${groupBinding.receiptId}:group-presence-summary:revision=1`,
            typeId: 'APP_OUTBOX',
            topicId: 'app-outbox.group-presence-summary',
            effectKind: 'group-presence-summary',
            canonicalCommandId: groupBinding.receiptId,
            commandIds: [groupBinding.receiptId, groupCommand.commandId]
        } as const;
        expect(
            computeProductionOutboxEvidence({
                commands: [groupCommand],
                receipts: [{
                    commandId: groupCommand.commandId,
                    receiptIds: [groupBinding.receiptId],
                    outboxIds: [groupRecord.resourceId],
                    identityKind: 'physical-resource-id',
                    resultBindings: [groupBinding]
                }],
                records: [groupRecord]
            })[0]
        ).toMatchObject({
            commandId: groupCommand.commandId,
            effectId: groupRecord.resourceId
        });
        expect(
            computeProductionOutboxExpectations(
                [topologyCommand],
                [{
                    commandId: topologyCommand.commandId,
                    receiptIds: [topologyCommand.commandId],
                    outboxIds: [topologyRecord.outboxId],
                    identityKind: 'logical-msg-id',
                    resultBindings: [binding(topologyCommand, 'command')]
                }]
            )[0]
        ).toMatchObject({
            effectId: topologyRecord.outboxId,
            canonicalCommandId: topologyCommand.commandId,
            effectKind: 'rtc-topology-recompute',
            typeId: 'APP_OUTBOX',
            physicalKey: toAppQueueKey({
                resourceId: topologyRecord.outboxId,
                topicId: 'app-outbox.rtc-topology',
                contextId: 'app=app:ws=workspace:group=topology-command'
            }),
            logicalContextId: 'app=app:ws=workspace:group=topology-command',
            payloadTypeId: 'RTC_TOPOLOGY_RECOMPUTE'
        });
        expect(
            parseBenchmarkOptions([
                '--backend=postgres',
                '--warmup=1',
                '--runs=3',
                '--concurrency=10',
                '--out=tmp/perf/candidate.json'
            ])
        ).toEqual({
            backend: 'postgres',
            warmup: 1,
            runs: 3,
            concurrency: 10,
            out: 'tmp/perf/candidate.json'
        });
    });
});

function expectStateWriteArtifactIssues(
    candidate: StateWritePerformanceArtifact,
    ...messages: readonly string[]
): void {
    expect(validateStateWriteArtifact(candidate)).toEqual(
        expect.arrayContaining(messages.map((message) => expect.stringContaining(message)))
    );
}

function groupIdempotencyRecord(
    command: Readonly<{ requestId: string; commandId: string; commandHash: string; }>,
    aggregateRef: Readonly<{ applicationId: string; workspaceId: string; groupId: string; }>
) {
    return {
        aggregateRef,
        requestId: command.commandId,
        commandHash: command.commandHash,
        receipt: {
            commandId: command.commandId,
            requestId: command.requestId,
            commandHash: command.commandHash,
            aggregateRef,
            outcome: 'no-op' as const,
            attemptCount: 1,
            acceptedStorageRevision: 0,
            snapshotVersion: 1,
            causalRevision: { groupRevision: 1, presenceRevision: 0 },
            eventId: null,
            outboxIds: [],
            joinCode: null,
            joinCodeExpiresAtEpochMs: null,
            rejection: null
        }
    };
}

const artifactSample = (artifact: StateWritePerformanceArtifact): StateWritePerformanceSample => artifact.workloads[0].samples[0];
const durableEvidence = (artifact: StateWritePerformanceArtifact): StateWriteDurableEvidence => artifactSample(artifact).durableEvidence;
const malformedDurableResultCases: readonly [
    (artifact: StateWritePerformanceArtifact) => void,
    string
][] = [
    [
        (artifact) => Reflect.deleteProperty(durableEvidence(artifact).appInbox[0], 'durableResult'),
        'persisted durable result is malformed'
    ],
    [
        (artifact) => (durableEvidence(artifact).receipts[0].outboxIds = ['invented-effect']),
        'receipt outbox IDs must match exact ResourceInbox effects'
    ],
    [
        (artifact) => {
            const entry = findPresenceEntry(artifact);
            entry.durableResult.outboxIds = ['invented-embedded-effect'];
        },
        'embedded result receipt must match authoritative receipt and effects'
    ],
    [
        (artifact) => {
            const entry = durableEvidence(artifact).appInbox.find((candidate) => candidate.commandType.startsWith('CLIENT_'));
            if (!entry) {
                throw new Error('Expected client AppInbox fixture');
            }
            Reflect.set(entry.durableResult, 'unreceipted', true);
        },
        'persisted durable result is malformed'
    ]
];

function queueResource(
    data: object,
    msgId?: string,
    identity?: Readonly<{
        resourceId: string;
        topicId: string;
        contextId: string;
        payloadTypeId: string;
    }>
): string {
    return JSON.stringify({
        ...(msgId === undefined ? {} : { id: { msgId } }),
        ...(identity === undefined
            ? {}
            : {
                route: {
                    resourceId: identity.resourceId,
                    topicId: identity.topicId,
                    contextId: identity.contextId
                }
            }),
        payload: {
            ...(identity === undefined ? {} : { typeId: identity.payloadTypeId }),
            resource: JSON.stringify(identity === undefined ? { data } : data)
        }
    });
}

// Scales serializedResultBytes rather than statements: the fixture's statement
// count is 20, too coarse for 4% and 6% to land on different integers.
function setResourceAdverseRatio(artifact: StateWritePerformanceArtifact, ratio: number): void {
    for (const workload of artifact.workloads) {
        for (const sample of workload.samples) {
            sample.sql.serializedResultBytes = Math.round(sample.sql.serializedResultBytes * (1 + ratio));
        }
        refreshStateWritePerformanceWorkload(workload);
    }
}

function setThroughputAdverseRatio(artifact: StateWritePerformanceArtifact, ratio: number): void {
    for (const workload of artifact.workloads) {
        for (const sample of workload.samples) {
            sample.durationMs = 100 / (1 - ratio);
            sample.throughputPerSecond = 700 / (sample.durationMs / 1000);
        }
        refreshStateWritePerformanceWorkload(workload);
    }
}

interface StateWriteTopologyAppInboxEntry extends StateWriteAppInboxEvidenceEntry {
    durableResult: StateWriteTopologyDurableResult;
}

interface StateWritePresenceAppInboxEntry extends StateWriteAppInboxEvidenceEntry {
    durableResult: StateWritePresenceDurableResult;
}

function findTopologyEntry(
    artifact: StateWritePerformanceArtifact
): StateWriteTopologyAppInboxEntry {
    const entry = findTopologyEntries(artifact)[0];
    if (!entry) {
        throw new Error('Expected topology AppInbox fixture');
    }
    return entry;
}

function findTopologyEntries(
    artifact: StateWritePerformanceArtifact
): StateWriteTopologyAppInboxEntry[] {
    return durableEvidence(artifact).appInbox.filter(isTopologyEntry);
}

function isTopologyEntry(
    entry: StateWriteAppInboxEvidenceEntry
): entry is StateWriteTopologyAppInboxEntry {
    return entry.commandType === 'TOPOLOGY_CONFIG_PUT' && 'receipt' in entry.durableResult;
}

function findPresenceEntry(
    artifact: StateWritePerformanceArtifact
): StateWritePresenceAppInboxEntry {
    const entry = durableEvidence(artifact).appInbox.find(isPresenceEntry);
    if (!entry) {
        throw new Error('Expected presence AppInbox fixture');
    }
    return entry;
}

function isPresenceEntry(
    entry: StateWriteAppInboxEvidenceEntry
): entry is StateWritePresenceAppInboxEntry {
    return entry.commandType.startsWith('GROUP_PRESENCE_') && 'outboxIds' in entry.durableResult;
}
