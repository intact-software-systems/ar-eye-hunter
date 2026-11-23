import { expect, it } from 'vitest';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { computeSha256CanonicalJson } from '@shared-server/rallar-system/protocol/compute-sha256-canonical-json.ts';
import { computeViewInvalidationPublication } from '@shared-server/rallar-system/websocket/outbox/compute-view-invalidation-publication.ts';
import { matchesStateWriteOutboxContract } from '../../../../../apps/api-v1/scripts/perf/api-v1-state-write-outbox-contract.mjs';
import { computeProductionOutboxExpectations } from '../../../../../apps/api-v1/scripts/perf/api-v1-state-write-outbox-expectations.ts';
import { validateExpectedProductionOutboxRecord } from '../../../../../apps/api-v1/scripts/perf/api-v1-state-write-outbox-resource-codec.ts';
import { binding } from './test-support/state-write-performance-result-fixture.ts';

const command = { kind: 'membership', commandId: 'measured:membership:7' } as const;
const result = binding(command, 'command');
const scope = { applicationId: 'app', workspaceId: 'workspace' };
const ref = { ...scope, groupId: command.commandId };
const changeId = computeSha256CanonicalJson({ commandId: result.receiptId, ref, revision: result.snapshotVersion });
const { entry } = computeViewInvalidationPublication({
    scope, groupId: ref.groupId, changeId, resource: 'room-access', principalIds: ['client-7'],
    createdAtEpochMs: 1_000, retentionMs: 60_000, serviceId: 'server', traceId: 'trace-room-access'
}).outbox[0]!;
const outboxIds = [entry.key.resourceId, 'presence-summary'];
const receipt = {
    commandId: command.commandId, receiptIds: [result.receiptId], outboxIds, identityKind: 'physical-resource-id' as const,
    resultBindings: [{ ...result, outboxIds }]
};

it('reads the persisted private room-access effect using the accepted membership command and revision', () => {
    const [expectation] = computeProductionOutboxExpectations([command], [receipt]);
    const row = {
        ri_resource_id: entry.key.resourceId, ri_topic_id: entry.key.topicId, fk_ext_bank_id: entry.key.contextId,
        ri_type_id: entry.typeId, ri_resource: entry.resource
    };
    expect(validateExpectedProductionOutboxRecord(row, expectation!).right).toMatchObject({
        effectKind: 'room-access', canonicalCommandId: result.receiptId
    });
    const message = decodePersistedALMessage(entry.resource);
    const notice = JSON.parse(message.payload.resource);
    for (const patch of [{ principalId: 'client-8' }, { groupId: 'other' }, { changeId: 'prior-revision' }]) {
        const changed = { ...message, payload: { ...message.payload, resource: JSON.stringify({ ...notice, ...patch }) } };
        expect(validateExpectedProductionOutboxRecord({ ...row, ri_resource: JSON.stringify(changed) }, expectation!).right).toBeUndefined();
    }
});

it('requires the access notification even if a membership receipt and outbox both omit it', () => {
    const effectId = 'presence-summary';
    const incomplete = { ...receipt, outboxIds: [effectId], resultBindings: [{ ...result, outboxIds: [effectId] }] };
    const summary = { commandId: command.commandId, effectId, resourceId: effectId, effectKind: 'group-presence-summary' };
    expect(matchesStateWriteOutboxContract(command, incomplete, [summary])).toBe(false);
});
