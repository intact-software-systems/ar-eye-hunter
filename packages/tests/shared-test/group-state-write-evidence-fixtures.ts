import { deriveApiV1StateWriteEvidence } from '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import type { ApiV1StateWriteEvidence } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-evidence-contracts.ts';
import type { PersistedCommandEvidence } from '@shared-test/black-box-runner/state-write-evidence/api-v1-state-write-receipt-evidence.ts';
import {
    toCanonicalGroupRef,
    type GroupEvent,
    type GroupEventType,
    type GroupSnapshot
} from '@shared/api/group-types.ts';

import { createGroupSnapshotFixture } from '../shared-web/authoritative-group-fixtures.ts';

export interface GroupEvidenceReceiptOverrides {
    readonly outcome?: string;
    readonly eventId?: string | null;
    readonly snapshotVersion?: number;
}

export interface GroupStateWriteEvidenceFixtureInput {
    readonly resourceId: string;
    readonly commandId: string;
    readonly commandType: string;
    readonly commandHash: string;
    readonly eventId: string;
    readonly eventType: GroupEventType;
}

export interface GroupStateWriteEvidenceFixture {
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent;
    readonly evidence: (
        candidateEvent?: unknown,
        receiptOverrides?: GroupEvidenceReceiptOverrides,
        candidateSnapshot?: unknown
    ) => ApiV1StateWriteEvidence;
}

interface GroupEvidenceReaderInput extends GroupStateWriteEvidenceFixtureInput {
    readonly snapshot: GroupSnapshot;
    readonly event: GroupEvent;
}

export function createGroupStateWriteEvidenceFixture(
    input: GroupStateWriteEvidenceFixtureInput
): GroupStateWriteEvidenceFixture {
    const groupRef = { applicationId: 'app-1', workspaceId: 'workspace-1', groupId: 'group-1' };
    const fixture = createGroupSnapshotFixture({ ...groupRef, sessionIds: ['owner-session', 'member-session'] });
    const snapshot: GroupSnapshot = {
        ...fixture,
        causalRevision: { groupRevision: 8, presenceRevision: 2 },
        group: { ...fixture.group, snapshotVersion: 8, presenceVersion: 2 }
    };
    const event: GroupEvent = {
        ...groupRef,
        eventId: input.eventId,
        eventType: input.eventType,
        snapshotVersion: 8,
        causalRevision: { groupRevision: 8, presenceRevision: 1 },
        occurredAtEpochMs: 1,
        actor: { kind: 'service', serviceId: 'api-v1' },
        reason: null,
        traceId: null,
        requestId: input.commandId,
        payload: {}
    };
    return { snapshot, event, evidence: createGroupEvidenceReader({ ...input, snapshot, event }) };
}

function createGroupEvidenceReader(input: GroupEvidenceReaderInput): GroupStateWriteEvidenceFixture['evidence'] {
    return (candidateEvent = input.event, receiptOverrides = {}, candidateSnapshot = input.snapshot) => {
        const authoritative: readonly PersistedCommandEvidence[] = [{
            appInboxResourceId: input.resourceId,
            appInboxTopicId: 'app-inbox',
            appInboxContextId: 'scope',
            valid: true,
            commandType: input.commandType,
            commandIds: [input.commandId],
            receipt: {
                appInboxResourceId: input.resourceId,
                commandId: input.commandId,
                commandHash: input.commandHash,
                outcome: 'applied',
                outboxIds: [],
                identityKind: 'physical-resource-id',
                requestId: input.commandId,
                aggregateRef: toCanonicalGroupRef(input.event),
                causalRevision: { groupRevision: 8, presenceRevision: 1 },
                snapshotVersion: 8,
                eventId: input.event.eventId,
                ...receiptOverrides
            }
        }];
        return deriveApiV1StateWriteEvidence({
            spec: { match: 'scope', commandTypes: [input.commandType] },
            rawRows: [{
                ri_row_id: 1,
                ri_resource_id: input.resourceId,
                ri_topic_id: 'app-inbox',
                fk_ext_bank_id: 'scope',
                ri_status: 'COMPLETED',
                ri_attempts: 1,
                start_ts: new Date(1),
                end_ts: new Date(2),
                next_ts: null,
                result_status: 'COMPLETED',
                ri_resource: JSON.stringify({ payload: { typeId: input.commandType, resource: JSON.stringify({ commandId: input.commandId }) } }),
                result_resource: JSON.stringify({ status: 'ok', result: { snapshot: candidateSnapshot, event: candidateEvent } })
            }],
            commandEvidence: authoritative
        });
    };
}
