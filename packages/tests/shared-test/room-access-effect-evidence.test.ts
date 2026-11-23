import { describe, expect, it } from 'vitest';
import { AppTopics } from '@shared/api/api-config.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { computeRoomAccessEvidenceIdentity, matchesRoomAccessEffect } from '@shared-test/black-box-runner/state-write-evidence/room-access-effect-evidence.ts';

const scope = { applicationId: 'application', workspaceId: 'workspace' };
const ref = { ...scope, groupId: 'room' };
const expected = { commandId: 'new-member', ref, revision: 12, principalId: 'guest' };

describe('committed room access outbox evidence', () => {
    it('binds the stored row, envelope, recipient and room revision to the command', () => {
        const publication = computeViewInvalidationPublication({
            resource: 'room-access', scope, groupId: ref.groupId, principalIds: ['guest'],
            changeId: computeSha256CanonicalJson({ commandId: 'new-member', ref, revision: 12 }),
            createdAtEpochMs: 100, retentionMs: 1000, serviceId: 'api-v1', traceId: 'trace'
        });
        const entry = publication.outbox[0]?.entry;
        if (!entry) throw new Error('Missing published access notice');
        const row = {
            ri_type_id: 'WS_OUTBOX', ri_topic_id: AppTopics.viewInvalidated, ri_status: 'NEW',
            ri_resource_id: entry.key.resourceId, fk_ext_bank_id: entry.key.contextId, ri_resource: entry.resource
        };
        const identity = computeRoomAccessEvidenceIdentity(expected);
        expect(matchesRoomAccessEffect(row, identity)).toBe(true);
        for (const change of [{ revision: 13 }, { principalId: 'other' }, { commandId: 'previous' }, { ref: { ...ref, groupId: 'elsewhere' } }]) {
            expect(matchesRoomAccessEffect(row, computeRoomAccessEvidenceIdentity({ ...expected, ...change }))).toBe(false);
        }
        expect(matchesRoomAccessEffect({ ...row, fk_ext_bank_id: 'different-target' }, identity)).toBe(false);
        expect(matchesRoomAccessEffect({ ...row, ri_resource: row.ri_resource.replace('"principalId":"guest"', '"principalId":"other"') }, identity)).toBe(false);
    });
});
