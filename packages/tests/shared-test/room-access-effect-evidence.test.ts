import { describe, expect, it } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { deriveApiV1StateWriteEvidence } from '@shared-test/black-box-runner/api-v1-state-write-evidence.ts';
import { createGroupStateWriteEvidenceFixture } from './group-state-write-evidence-fixtures.ts';
import { computeRoomAccessEvidenceIdentity, matchesRoomAccessEffect } from '@shared-test/black-box-runner/state-write-evidence/room-access-effect-evidence.ts';

const scope = { applicationId: 'app-1', workspaceId: 'workspace-1' };
const ref = { ...scope, groupId: 'group-1' };
const expected = { commandId: 'new-member', ref, revision: 8, principalId: 'guest' };

function storedNotice() {
    const publication = computeViewInvalidationPublication({
        resource: 'room-access', scope, groupId: ref.groupId, principalIds: ['guest'],
        changeId: computeSha256CanonicalJson({ commandId: 'new-member', ref, revision: 8 }),
        createdAtEpochMs: 100, retentionMs: 1000, serviceId: 'api-v1', traceId: 'trace'
    });
    const entry = publication.outbox[0]?.entry;
    if (!entry) throw new Error('Missing published access notice');
    return {
        ri_type_id: 'WS_OUTBOX', ri_topic_id: AppTopics.viewInvalidated, ri_status: 'NEW',
        ri_resource_id: entry.key.resourceId, fk_ext_bank_id: entry.key.contextId, ri_resource: entry.resource
    };
}

describe('committed room access outbox evidence', () => {
    it('binds the stored row, envelope, recipient and room revision to the command', () => {
        const row = storedNotice();
        const identity = computeRoomAccessEvidenceIdentity(expected);
        expect(matchesRoomAccessEffect(row, identity)).toBe(true);
        for (const change of [{ revision: 13 }, { principalId: 'other' }, { commandId: 'previous' }, { ref: { ...ref, groupId: 'elsewhere' } }]) {
            expect(matchesRoomAccessEffect(row, computeRoomAccessEvidenceIdentity({ ...expected, ...change }))).toBe(false);
        }
        expect(matchesRoomAccessEffect({ ...row, fk_ext_bank_id: 'different-target' }, identity)).toBe(false);
        expect(matchesRoomAccessEffect({ ...row, ri_resource: row.ri_resource.replace('"principalId":"guest"', '"principalId":"other"') }, identity)).toBe(false);
    });

    it('requires exactly the promised private notice for the completed grant', () => {
        const row = storedNotice();
        const commandType = 'GROUP_MEMBER_UPSERT';
        const commandId = expected.commandId;
        const resourceId = 'inbox-1';
        const eventId = 'event-1';
        const { snapshot, event } = createGroupStateWriteEvidenceFixture({
            resourceId, commandId, commandType, commandHash: 'hash', eventId, eventType: 'member-joined'
        });
        const raw = {
            ri_row_id: 1, ri_resource_id: resourceId, ri_topic_id: 'app-inbox', fk_ext_bank_id: 'scope',
            ri_status: 'COMPLETED', ri_attempts: 1, start_ts: null, end_ts: null, next_ts: null,
            result_status: 'COMPLETED', ri_resource: JSON.stringify({ payload: { typeId: commandType } }),
            result_resource: JSON.stringify({ status: 'ok', result: { snapshot, event } })
        };
        const command = {
            appInboxResourceId: resourceId, appInboxTopicId: raw.ri_topic_id, appInboxContextId: raw.fk_ext_bank_id,
            valid: true, commandType, commandIds: [commandId], roomAccessIdentity: computeRoomAccessEvidenceIdentity(expected),
            receipt: {
                appInboxResourceId: resourceId, commandId, commandHash: 'hash', outcome: 'applied',
                outboxIds: [row.ri_resource_id], identityKind: 'physical-resource-id' as const, requestId: commandId,
                aggregateRef: ref, causalRevision: event.causalRevision, snapshotVersion: expected.revision, eventId
            }
        };
        const evidence = (rawOutboxRows: readonly typeof row[]) => deriveApiV1StateWriteEvidence({
            spec: { match: 'scope', expectedEffectsByCommandType: { [commandType]: ['room-access'] } },
            commandEvidence: [command], rawRows: [raw], rawOutboxRows
        });
        expect(evidence([row])).toMatchObject({ atomicCompletionFailures: 0, resourceOutboxCount: 1 });
        expect(evidence([])).toMatchObject({ finalEffectFailureCount: 1 });
        expect(evidence([row, row])).toMatchObject({ finalEffectFailureCount: 1 });
        expect(evidence([{ ...row, ri_resource_id: 'another-write' }])).toMatchObject({ finalEffectFailureCount: 1 });
    });
});
