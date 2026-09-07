import { describe, expect, it } from 'vitest';

import { computeClientStateSyncEntries } from '@shared-server/rallar-system/state-sync/state-sync-entry-computation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { ClientEvent, ClientSnapshot } from '@shared/api/client-types.ts';
import { decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import { computeProductionOutboxExpectations } from '../../../../../scripts/perf/api-v1-state-write-outbox-expectations.ts';
import { validateExpectedProductionOutboxRecord, type ProductionOutboxRow } from '../../../../../scripts/perf/api-v1-state-write-outbox-resource-codec.ts';
import type { ProductionReceiptEvidence } from '../../../../../scripts/perf/api-v1-state-write-receipt-evidence.ts';
import { validateStateWriteArtifact } from '../../../../../scripts/perf/compare-api-v1-state-write-results.mjs';
import { createClientSnapshot } from '../../rallar-system/state-sync/http/rest-state-snapshot-read-test-fixtures.ts';
import {
    createDefaultStateWritePerformanceArtifact,
    refreshStateWritePerformanceWorkload
} from './test-support/state-write-performance-artifact-fixture.ts';
import { binding } from './test-support/state-write-performance-result-fixture.ts';

const COMMAND = { commandId: 'snapshot-benchmark:profile-instance:0', kind: 'profile-instance' } as const;

describe('state-write snapshot outbox evidence', () => {
    it('captures every production page and audience carrier under its own operation receipt', () => {
        const profile = createOperationEntries('profile', 0);
        const instance = createOperationEntries('instance', 2);
        const receipt = createReceipt(profile, instance);
        const entries = [...profile, ...instance];
        const expectations = computeProductionOutboxExpectations([COMMAND], [receipt]);

        expect(profile.length).toBeGreaterThan(2);
        expect(instance.length).toBeGreaterThan(profile.length);
        expect(expectations.map((entry) => entry.effectId)).toEqual(receipt.outboxIds);
        const records = entries.map((entry, index) => validateExpectedProductionOutboxRecord(toOutboxRow(entry), expectations[index]!).right);
        expect(records.every((record) => record !== undefined)).toBe(true);
        expect(records.map((record) => record!.resourceId)).toEqual(receipt.outboxIds);
        expect(records.slice(0, profile.length).every((record) => record!.canonicalCommandId === `${COMMAND.commandId}-profile`)).toBe(true);
        expect(records.slice(profile.length).every((record) => record!.canonicalCommandId === `${COMMAND.commandId}-instance`)).toBe(true);
    });

    it('classifies receipt effects by their producer identities when receipt order changes', () => {
        const profile = createOperationEntries('profile', 0);
        const instance = createOperationEntries('instance', 1);
        const receipt = createReceipt(profile, instance);
        const reordered = { ...receipt, outboxIds: receipt.outboxIds.toReversed() };
        const rows = new Map([...profile, ...instance].map((entry) => [entry.key.resourceId, toOutboxRow(entry)]));
        const expectations = computeProductionOutboxExpectations([COMMAND], [reordered]);

        expect(expectations.map((entry) => entry.effectId)).toEqual(reordered.outboxIds);
        for (const expectation of expectations) {
            const result = validateExpectedProductionOutboxRecord(rows.get(expectation.effectId)!, expectation);
            expect(result.left).toBeUndefined();
            expect(result.right?.resourceId).toBe(expectation.effectId);
        }
    });

    it.each(['source', 'scope', 'route', 'page-index'])('rejects a changed snapshot %s', (field) => {
        const profile = createOperationEntries('profile', 0);
        const instance = createOperationEntries('instance', 0);
        const [expectation] = computeProductionOutboxExpectations([COMMAND], [createReceipt(profile, instance)]);
        const row = toOutboxRow(profile[0]!);
        const message = decodePersistedALMessage(row.ri_resource);
        const page = decodeStateSnapshotPage(message, expectation!.aggregateRef).right!;
        const changedPage = {
            ...page,
            originalMessageId: field === 'source' ? 'another-command:principal-state:snapshot:revision=1' : page.originalMessageId,
            scope: field === 'scope' ? { ...page.scope, resourceId: 'another-principal' } : page.scope,
            index: field === 'page-index' ? page.index + 1 : page.index
        };
        const changedMessage = {
            ...message,
            route: field === 'route' ? { ...message.route, resourceId: message.id.msgId } : message.route,
            payload: { ...message.payload, resource: JSON.stringify(changedPage) }
        };

        expect(validateExpectedProductionOutboxRecord(row, expectation!).right).toBeDefined();
        expect(
            validateExpectedProductionOutboxRecord({
                ...row,
                ri_resource: JSON.stringify(changedMessage)
            }, expectation!).right
        ).toBeUndefined();
    });
});

describe('state-write snapshot artifact comparison', () => {
    it('requires each additional carrier in both the operation receipt and physical outbox', () => {
        const artifact = createPagedArtifact();
        expect(validateStateWriteArtifact(artifact)).toEqual([]);
        const sample = artifact.workloads[0]!.samples[0]!;
        sample.durableEvidence.resourceOutbox.pop();
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('receipt outbox IDs must match exact ResourceInbox effects')
        );
    });

    it('rejects carriers assigned to both profile and instance receipts', () => {
        const artifact = createPagedArtifact();
        const receipt = artifact.workloads[0]!.samples[0]!.durableEvidence.receipts[0]!;
        receipt.resultBindings[1]!.outboxIds.push(receipt.resultBindings[0]!.outboxIds[0]!);
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('resource outbox does not match the mutation contract')
        );
    });

    it('rejects an additional event even when a receipt references it', () => {
        const artifact = createPagedArtifact();
        const sample = artifact.workloads[0]!.samples[0]!;
        const carrier = sample.durableEvidence.resourceOutbox.at(-1)!;
        sample.durableEvidence.resourceOutbox[sample.durableEvidence.resourceOutbox.length - 1] = {
            ...carrier,
            effectKind: 'principal-state:event'
        };
        expect(validateStateWriteArtifact(artifact)).toContainEqual(
            expect.stringContaining('resource outbox does not match the mutation contract')
        );
    });
});

function createPagedArtifact() {
    const artifact = createDefaultStateWritePerformanceArtifact();
    const workload = artifact.workloads[0]!;
    const sample = workload.samples[0]!;
    const receipt = sample.durableEvidence.receipts[0]!;
    const snapshot = sample.durableEvidence.resourceOutbox[0]!;
    const effectId = `${snapshot.effectId}:additional-page`;
    receipt.outboxIds.push(effectId);
    receipt.resultBindings[0]!.outboxIds.push(effectId);
    sample.durableEvidence.resourceOutbox.push({ ...snapshot, effectId, resourceId: effectId, outboxId: effectId });
    sample.correctness.requiredOutboxIntentCount += 1;
    sample.correctness.outboxIntentCount += 1;
    refreshStateWritePerformanceWorkload(workload);
    return artifact;
}

function createOperationEntries(operation: 'profile' | 'instance', sessionCount: number): readonly ResourceEntry[] {
    const initial = createClientSnapshot(1);
    const activeSessions = Array.from({ length: sessionCount }, (_, index) => createSession(initial, index));
    const snapshot: ClientSnapshot = {
        ...initial,
        principal: { ...initial.principal, metadata: { text: 'x'.repeat(60_000) } },
        instances: activeSessions.map((session) => createInstance(initial, session.clientInstanceId)),
        activeSessions,
        activeSessionCount: activeSessions.length,
        isOnline: activeSessions.length > 0,
        lastSeenAtEpochMs: activeSessions.length > 0 ? 1_000 : null
    };
    const commandId = `${COMMAND.commandId}-${operation}`;
    return computeClientStateSyncEntries({
        commandId,
        aggregateRef: snapshot.principal,
        acceptedCausalRevision: snapshot.stateRevision,
        audience: {
            kind: 'principal',
            applicationId: snapshot.principal.applicationId,
            workspaceId: snapshot.principal.workspaceId,
            resourceId: snapshot.principal.principalId
        },
        createdAtEpochMs: 1_000,
        expireAtEpochMs: 61_000,
        effects: [
            { effectKind: 'principal-state', payloadKind: 'snapshot', payload: snapshot },
            { effectKind: 'principal-state', payloadKind: 'event', payload: createEvent(snapshot, commandId) }
        ]
    }, 'server-1');
}

function createInstance(snapshot: ClientSnapshot, clientInstanceId: string): ClientSnapshot['instances'][number] {
    return {
        applicationId: snapshot.principal.applicationId,
        workspaceId: snapshot.principal.workspaceId,
        principalId: snapshot.principal.principalId,
        clientInstanceId,
        platform: 'web',
        deviceLabel: null,
        appVersion: null,
        userAgent: null,
        capabilities: [],
        registered: snapshot.principal.created,
        updated: snapshot.principal.updated,
        status: 'active',
        revoked: null
    };
}

function createSession(snapshot: ClientSnapshot, index: number): ClientSnapshot['activeSessions'][number] {
    return {
        applicationId: snapshot.principal.applicationId,
        workspaceId: snapshot.principal.workspaceId,
        principalId: snapshot.principal.principalId,
        clientInstanceId: `instance-${index}`,
        sessionId: `session-${index}`,
        generationId: `generation-${index}`,
        generationVersion: 1,
        presenceState: 'online',
        transport: 'ws',
        connectionId: `connection-${index}`,
        authenticatedAtEpochMs: 1,
        connectedAtEpochMs: 1,
        lastHeartbeatAtEpochMs: 1_000,
        expiresAtEpochMs: 61_000,
        status: 'active',
        disconnectedAtEpochMs: null,
        disconnectReason: null
    };
}

function createEvent(snapshot: ClientSnapshot, commandId: string): ClientEvent {
    return {
        applicationId: snapshot.principal.applicationId,
        workspaceId: snapshot.principal.workspaceId,
        principalId: snapshot.principal.principalId,
        eventId: `${commandId}:event`,
        eventType: 'principal-updated',
        snapshotVersion: snapshot.stateRevision,
        clientInstanceId: null,
        sessionId: null,
        occurredAtEpochMs: 1_000,
        actor: { kind: 'service', serviceId: 'server-1' },
        reason: null,
        traceId: null,
        requestId: commandId,
        payload: {}
    };
}

function createReceipt(profile: readonly ResourceEntry[], instance: readonly ResourceEntry[]): ProductionReceiptEvidence {
    const principal = createClientSnapshot(1).principal;
    const resultBindings = [profile, instance].map((entries, index) => ({
        ...binding(COMMAND, index === 0 ? 'profile' : 'instance'),
        aggregateRef: {
            applicationId: principal.applicationId,
            workspaceId: principal.workspaceId,
            principalId: principal.principalId
        },
        outboxIds: entries.map((entry) => entry.key.resourceId)
    }));
    return {
        commandId: COMMAND.commandId,
        receiptIds: resultBindings.map((entry) => entry.receiptId),
        outboxIds: resultBindings.flatMap((entry) => entry.outboxIds),
        identityKind: 'physical-resource-id',
        resultBindings
    };
}

function toOutboxRow(entry: ResourceEntry): ProductionOutboxRow {
    return {
        ri_resource_id: entry.key.resourceId,
        ri_topic_id: entry.key.topicId,
        fk_ext_bank_id: entry.key.contextId,
        ri_type_id: entry.typeId,
        ri_resource: entry.resource
    };
}
