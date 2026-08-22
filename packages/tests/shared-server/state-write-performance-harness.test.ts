import { describe, expect, it, vi } from 'vitest';
import { compareStateWriteArtifacts, validateStateWriteArtifact } from '../../../scripts/perf/compare-api-v1-state-write-results.mjs';

import { mutationDescriptor, toDescriptorCommand } from '@shared-server/rallar-system/group-state/group-mutation-authority.ts';
import { toGroupMutationDescriptorTargetIdentity } from '@shared-server/rallar-system/group-state/inbox/to-group-mutation-descriptor.ts';
import { toScopedGroupMutationCommandId } from '@shared-server/rallar-system/group-state/scoped-group-mutation-command-id.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { computeGroupPresenceSummaryEntry } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { readScopedGroupCommandIdentity } from '../../../scripts/perf/api-v1-state-write-group-receipt-evidence.ts';
import {
    computeProductionOutboxEvidence,
    computeProductionOutboxExpectations,
    createProductionOutboxRepository,
    readAllCommandIds,
    readCanonicalEffectCommandId,
    readResourceEffectKind
} from '../../../scripts/perf/api-v1-state-write-outbox-evidence.ts';
import { classifyBenchmarkSql } from '../../../scripts/perf/create-instrumented-state-write-sql.ts';
import { STATE_WRITE_REASONS } from '../../../scripts/perf/state-write/api-v1-state-write-regression-reasons.ts';

import { parseBenchmarkOptions } from '../../../scripts/perf/state-write/api-v1-state-write-benchmark-options.ts';
import { createStateWritePerformanceArtifact, refreshStateWritePerformanceWorkload } from './state-write-performance-artifact-fixture.ts';
import { binding, swapCompleteDurableResults } from './state-write-performance-result-fixture.ts';

describe('API-v1 state-write final durable evidence', { timeout: 30_000 }, () => {
    it('reads a scoped group command only from its exact actor, workspace, group, topic, and context', async () => {
        const requestId = 'state-write:config:7';
        const actorPrincipalId = 'client-7';
        const groupRef = {
            applicationId: 'state-write-run-uncontended-measured-0',
            workspaceId: 'state-write-workspace-with-a-benchmark-length-identity',
            groupId: 'group-2'
        };
        const topicId = 'GROUP_UPDATE';
        const logicalContextId = [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId]
            .map(encodeURIComponent)
            .join(':');
        const physicalKey = toAppQueueKey({
            resourceId: requestId,
            topicId,
            contextId: logicalContextId
        });
        const descriptor = mutationDescriptor(
            'updateGroup',
            {
                applicationId: groupRef.applicationId,
                workspaceId: groupRef.workspaceId
            },
            groupRef.groupId,
            {
                metadata: { benchmarkConfigSource: requestId },
                actorPrincipalId,
                requestId
            }
        );
        const commandId = await toScopedGroupMutationCommandId(descriptor, actorPrincipalId);
        const command = {
            ...toDescriptorCommand(descriptor, () => requestId),
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
                        facts: {},
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
        const expectation = {
            requestId,
            topicId,
            logicalContextId,
            groupRef,
            actorPrincipalId
        };

        await expect(readScopedGroupCommandIdentity(row, expectation)).resolves.toEqual({
            requestId,
            commandId
        });
        await expect(readScopedGroupCommandIdentity(row, {
            ...expectation,
            groupRef: { ...groupRef, workspaceId: 'wrong-workspace' }
        })).resolves.toBeUndefined();
        await expect(readScopedGroupCommandIdentity(row, {
            ...expectation,
            actorPrincipalId: 'wrong-actor'
        })).resolves.toBeUndefined();
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
        const topicId = 'GROUP_PRESENCE_CONNECT';
        const logicalContextId = [groupRef.applicationId, groupRef.workspaceId, groupRef.groupId]
            .map(encodeURIComponent)
            .join(':');
        const descriptor = mutationDescriptor(
            'connectPresence',
            { applicationId: groupRef.applicationId, workspaceId: groupRef.workspaceId },
            groupRef.groupId,
            {
                principalId: actorPrincipalId,
                generationId: `${sessionId}:generation-1`,
                connectedAtEpochMs: 1_000,
                lastHeartbeatAtEpochMs: 1_000,
                expiresAtEpochMs: 61_000,
                actorPrincipalId,
                actorSessionId: sessionId,
                requestId
            },
            actorPrincipalId,
            sessionId
        );
        const commandId = await toScopedGroupMutationCommandId(descriptor, actorPrincipalId);
        const command = { ...toDescriptorCommand(descriptor, () => requestId), commandId };
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
                            facts: {},
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
        })).resolves.toEqual({ requestId, commandId });
    });

    it.each(['joinGroup', 'acceptGroupInvite'] as const)(
        'keeps the descriptor target empty for %s after resolving its command principal',
        (operation) => {
            const actorPrincipalId = 'client-admission';
            const descriptor = mutationDescriptor(
                operation,
                { applicationId: 'app', workspaceId: 'workspace' },
                'group',
                {
                    actorPrincipalId,
                    actorSessionId: 'session',
                    requestId: `request-${operation}`
                }
            );
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
                outboxId: null,
                outboxIds: [entry.key.resourceId],
                aggregateRef,
                stateRevision: 4,
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
        const expectation = computeProductionOutboxExpectations([command], [receipt])[0]!;
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
        const expectation = computeProductionOutboxExpectations([command], [receipt])[0]!;
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
        const candidate = createStateWritePerformanceArtifact();
        const sample = artifactSample(candidate);
        expect(candidate.measurement.counterSources.outbox).toBe('resource_inbox');
        expect(candidate.measurement.counterSources.attempts).toBe(
            'resource_inbox.release.telemetry+app_inbox.ri_attempts reconciliation'
        );
        expect(sample.durableEvidence.intermediateMutationIntents).toEqual([]);
        expect(sample.correctness.atomicCompletionFailures).toBe(0);
        expect(candidate.features).toBeUndefined();
        expect(validateStateWriteArtifact(candidate)).toEqual([]);
    });

    it('accepts scoped physical group receipt identities distinct from public request IDs', () => {
        const candidate = createStateWritePerformanceArtifact();
        const sample = artifactSample(candidate);
        const command = sample.commands.find((entry: any) => entry.kind === 'membership');
        const receipt = sample.durableEvidence.receipts.find(
            (entry: any) => entry.commandId === command.commandId
        );
        const binding = receipt.resultBindings[0];

        expect(binding.receiptId).toMatch(/^group-app-inbox:[0-9a-f]{64}$/);
        expect(binding.receiptId).not.toBe(command.commandId);
        expect(binding.requestId).toBe(command.commandId);
        expect(validateStateWriteArtifact(candidate)).toEqual([]);
    });

    it('tolerates equal throughput between baseline and candidate', () => {
        expect(
            compareStateWriteArtifacts(
                createStateWritePerformanceArtifact(),
                createStateWritePerformanceArtifact()
            )
        ).toEqual([]);
    });

    it('tolerates throughput variance within 5% and rejects beyond it', () => {
        const withinTolerance = createStateWritePerformanceArtifact();
        setThroughputAdverseRatio(withinTolerance, 0.04);
        expect(
            compareStateWriteArtifacts(createStateWritePerformanceArtifact(), withinTolerance)
        ).toEqual([]);

        const beyondTolerance = createStateWritePerformanceArtifact();
        setThroughputAdverseRatio(beyondTolerance, 0.06);
        expect(
            compareStateWriteArtifacts(createStateWritePerformanceArtifact(), beyondTolerance)
        ).toEqual(
            expect.arrayContaining([
                expect.stringContaining('shared throughput regressed by more than 5%'),
                expect.stringContaining('hot throughput regressed by more than 5%')
            ])
        );
    });

    it('rejects intermediate intents and service-local attempt evidence', () => {
        const candidate = createStateWritePerformanceArtifact();
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
                (sample: any) => sample.durableEvidence.appInbox.shift(),
                (sample: any) => sample.durableEvidence.receipts.shift(),
                (sample: any) => sample.durableEvidence.resourceOutbox.shift()
            ]
        ) {
            const candidate = createStateWritePerformanceArtifact();
            mutate(artifactSample(candidate));
            refreshStateWritePerformanceWorkload(candidate.workloads[0]);
            expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
        }
    });

    it('rejects malformed retry delay, due age, lane, and transaction evidence', () => {
        for (const field of ['retryDelayMs', 'dueAgeMs', 'transactionDurationMs'] as const) {
            const candidate = createStateWritePerformanceArtifact();
            durableEvidence(candidate).appInbox[0][field] = -1;
            expectStateWriteArtifactIssues(candidate, 'appInbox[0] is malformed');
        }
        const lane = createStateWritePerformanceArtifact();
        durableEvidence(lane).appInbox[0].selectedLane = 'unknown';
        expect(validateStateWriteArtifact(lane)).not.toEqual([]);
    });

    it('rejects invented retry history and zero-delay nonterminal conflicts', () => {
        const invented = createStateWritePerformanceArtifact();
        const inventedSample = artifactSample(invented);
        inventedSample.attemptObservations.splice(1, 0, {
            ...inventedSample.attemptObservations[0],
            attempt: 2
        });
        expectStateWriteArtifactIssues(invented, 'must reconcile exactly to durable AppInbox attempts');
        const zeroDelay = createStateWritePerformanceArtifact();
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
        const candidate = createStateWritePerformanceArtifact();
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
            const artifact = createStateWritePerformanceArtifact();
            mutate(artifact);
            expectStateWriteArtifactIssues(artifact, expected);
        }
        for (const prefix of ['CLIENT_', 'GROUP_']) {
            const swapped = createStateWritePerformanceArtifact();
            swapCompleteDurableResults(swapped, prefix);
            expect(validateStateWriteArtifact(swapped)).not.toEqual([]);
        }
        const missingTopologySibling = createStateWritePerformanceArtifact();
        const missingEntry = durableEvidence(missingTopologySibling).appInbox.find(
            (entry: any) => entry.commandType === 'TOPOLOGY_CONFIG_PUT'
        );
        delete missingEntry.durableResult.config;
        expect(validateStateWriteArtifact(missingTopologySibling)).not.toEqual([]);
        const swappedTopologySibling = createStateWritePerformanceArtifact();
        const topologyEntries = durableEvidence(swappedTopologySibling).appInbox.filter(
            (entry: any) => entry.commandType === 'TOPOLOGY_CONFIG_PUT'
        );
        [topologyEntries[0].durableResult.config, topologyEntries[1].durableResult.config] = [
            topologyEntries[1].durableResult.config,
            topologyEntries[0].durableResult.config
        ];
        expect(validateStateWriteArtifact(swappedTopologySibling)).not.toEqual([]);
    });

    it('is total over malformed nested candidate evidence', () => {
        for (
            const mutate of [
                (candidate: any) => (artifactSample(candidate).durableEvidence = null),
                (candidate: any) => delete durableEvidence(candidate).appInbox[0],
                (candidate: any) => (durableEvidence(candidate).receipts[0] = null),
                (candidate: any) => (durableEvidence(candidate).resourceOutbox[0] = null)
            ]
        ) {
            const candidate = createStateWritePerformanceArtifact();
            mutate(candidate);
            expect(() => validateStateWriteArtifact(candidate)).not.toThrow();
            expect(validateStateWriteArtifact(candidate)).not.toEqual([]);
            expect(() => compareStateWriteArtifacts(createStateWritePerformanceArtifact(), candidate)).not.toThrow();
        }
    });

    // Resource counters follow retry attempt counts, which follow timing, so an
    // identical-code control drifts (up to +2.7% measured, issue #157). The gate
    // has to absorb that drift and still catch a real resource regression.
    it('tolerates resource variance within 5% and rejects beyond it', () => {
        const withinTolerance = createStateWritePerformanceArtifact();
        setResourceAdverseRatio(withinTolerance, 0.04);
        expect(
            compareStateWriteArtifacts(createStateWritePerformanceArtifact(), withinTolerance)
        ).toEqual([]);

        const beyondTolerance = createStateWritePerformanceArtifact();
        setResourceAdverseRatio(beyondTolerance, 0.06);
        expect(
            compareStateWriteArtifacts(createStateWritePerformanceArtifact(), beyondTolerance)
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
        const authorized = createStateWritePerformanceArtifact();
        setResourceAdverseRatio(authorized, 0.06);
        authorized.regressionReasons = [...STATE_WRITE_REASONS];
        expect(compareStateWriteArtifacts(createStateWritePerformanceArtifact(), authorized)).toEqual(
            []
        );
    });

    it('preserves scale, retry-exhaustion, latency, throughput, and resource gates', () => {
        const baseline = createStateWritePerformanceArtifact();
        const candidate = createStateWritePerformanceArtifact();
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

        const baseline = createStateWritePerformanceArtifact();
        const candidate = createStateWritePerformanceArtifact();
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

function expectStateWriteArtifactIssues(candidate: unknown, ...messages: readonly string[]): void {
    expect(validateStateWriteArtifact(candidate)).toEqual(
        expect.arrayContaining(messages.map((message) => expect.stringContaining(message)))
    );
}

const artifactSample = (artifact: any): any => artifact.workloads[0].samples[0];
const durableEvidence = (artifact: any): any => artifactSample(artifact).durableEvidence;
const malformedDurableResultCases: readonly [(artifact: any) => void, string][] = [
    [
        (artifact) => delete durableEvidence(artifact).appInbox[0].durableResult,
        'persisted durable result is malformed'
    ],
    [
        (artifact) => (durableEvidence(artifact).receipts[0].outboxIds = ['invented-effect']),
        'receipt outbox IDs must match exact ResourceInbox effects'
    ],
    [
        (artifact) => {
            const entry = durableEvidence(artifact).appInbox.find((candidate: any) => candidate.commandType.startsWith('GROUP_PRESENCE_'));
            entry.durableResult.outboxIds = ['invented-embedded-effect'];
        },
        'embedded result receipt must match authoritative receipt and effects'
    ],
    [
        (artifact) => {
            const entry = durableEvidence(artifact).appInbox.find((candidate: any) => candidate.commandType.startsWith('CLIENT_'));
            entry.durableResult.unreceipted = true;
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
function setResourceAdverseRatio(artifact: any, ratio: number): void {
    for (const workload of artifact.workloads) {
        for (const sample of workload.samples) {
            sample.sql.serializedResultBytes = Math.round(sample.sql.serializedResultBytes * (1 + ratio));
        }
        refreshStateWritePerformanceWorkload(workload);
    }
}

function setThroughputAdverseRatio(artifact: any, ratio: number): void {
    for (const workload of artifact.workloads) {
        for (const sample of workload.samples) {
            sample.durationMs = 100 / (1 - ratio);
            sample.throughputPerSecond = 700 / (sample.durationMs / 1000);
        }
        refreshStateWritePerformanceWorkload(workload);
    }
}
