import type { PSqlSql } from '@shared-server/postgres/p-sql-sql.ts';
import type { ClientMutationComputedAppliedWrite } from '@shared-server/rallar-system/client-state/mutation/client-mutation-contracts.ts';
import { computeClientMutation } from '@shared-server/rallar-system/client-state/mutation/compute/compute-client-mutation.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { AppTopics } from '@shared/api/api-config.ts';
import { decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import {
    expect,
    it
} from 'vitest';
import {
    expectCompactWorkerOutput,
    expectPendingWorkerOutboxes
} from '../../integration/postgres/presence/presence-concurrency-worker-test-runtime.ts';
import {
    connectCommand,
    disconnectCommand,
    emptyRead,
    heartbeatCommand,
    readAfterWrite,
    requireWrite
} from './client-mutation-compute-test-fixtures.ts';

it.each(['client-heartbeat', 'client-reconnect', 'client-disconnect'] as const)(
    'checks receipt-linked broadcast, live unicast and event rows for %s',
    async (operation) => {
        const connectedCommand = await connectCommand();
        const connected = requireWrite(computeClientMutation({ command: connectedCommand, read: emptyRead(connectedCommand) }));
        const command = operation === 'client-heartbeat'
            ? await heartbeatCommand()
            : operation === 'client-reconnect'
            ? await connectCommand('reconnect', 'generation-2')
            : await disconnectCommand();
        const computed = requireWrite(computeClientMutation({ command, read: readAfterWrite(command, connected) }));
        const messages = computed.outboxWrites.map(({ entry }) => decodePersistedALMessage(entry.resource));
        const snapshots = messages.filter((message) => message.route.topicId === AppTopics.clientStateSnapshot);
        expect(snapshots.map((message) => message.targets)).toEqual(
            operation === 'client-disconnect'
                ? [{ mode: 'broadcast', scope: 'principal', principalRef: command.aggregateRef }]
                : [
                    { mode: 'broadcast', scope: 'principal', principalRef: command.aggregateRef },
                    { mode: 'unicast', toPeerId: 'session-1' }
                ]
        );
        expect(computed.snapshot.activeSessions.map((session) => session.sessionId))
            .toEqual(operation === 'client-disconnect' ? [] : ['session-1']);
        for (const snapshot of snapshots) {
            const decoded = decodeStateSnapshotPage(snapshot, command.aggregateRef);
            expect(decoded.left).toBeUndefined();
            const page = decoded.right;
            if (!page) {
                throw new Error('Expected a decoded page');
            }
            expect(page).toMatchObject({ index: 0, count: 1, scope: { kind: 'principal', resourceId: 'alice' } });
            expect(JSON.parse(page.chunk)).toEqual(computed.snapshot);
        }
        expect(
            messages.filter((message) => message.route.topicId === AppTopics.clientStateEvent)
                .map((message) => JSON.parse(message.payload.resource))
        ).toEqual([computed.event]);
        expect(computed.receipt.outboxIds).toEqual(computed.outboxWrites.map(({ entry }) => entry.key.resourceId));
        const output = {
            operation,
            requestId: command.commandId,
            commandHash: command.facts.commandHash,
            attemptCount: 1,
            acceptedStorageRevision: computed.receipt.acceptedStorageRevision,
            acceptedCausalRevision: null,
            acceptedVersion: computed.receipt.snapshotVersion,
            outboxIds: computed.receipt.outboxIds,
            domainStatus: 'applied' as const
        };
        expectCompactWorkerOutput(output);
        const sql = createOutboxReadback(computed);
        const input = { sql, outputs: [output], kind: 'client' as const, effects: ['principal-state:snapshot', 'principal-state:event'] as const };
        await expectPendingWorkerOutboxes(input);
        await expect(expectPendingWorkerOutboxes({ ...input, outputs: [{ ...output, outboxIds: output.outboxIds.slice(1) }] }))
            .rejects.toThrow();
        await expect(expectPendingWorkerOutboxes({ ...input, outputs: [{ ...output, outboxIds: [...output.outboxIds].reverse() }] }))
            .rejects.toThrow();
        const [first, ...remaining] = computed.outboxWrites;
        if (!first) {
            throw new Error('Expected a snapshot write');
        }
        const message = decodePersistedALMessage(first.entry.resource);
        const corrupted = {
            ...computed,
            outboxWrites: [{
                ...first,
                entry: {
                    ...first.entry,
                    resource: JSON.stringify({ ...message, id: { ...message.id, msgId: 'other-message' } })
                }
            }, ...remaining]
        };
        await expect(expectPendingWorkerOutboxes({ ...input, sql: createOutboxReadback(corrupted) }))
            .rejects.toThrow('canonical key');
        await expect(expectPendingWorkerOutboxes({ ...input, outputs: [{ ...output, outboxIds: output.outboxIds.map(() => first.entry.key.resourceId) }] }))
            .rejects.toThrow();
    }
);

function createOutboxReadback(computed: ClientMutationComputedAppliedWrite): PSqlSql {
    const read = async (_strings: TemplateStringsArray, resourceId: string) =>
        computed.outboxWrites
            .filter(({ entry }) => entry.key.resourceId === resourceId)
            .map(({ entry }) => ({
                ri_resource_id: entry.key.resourceId,
                ri_topic_id: entry.key.topicId,
                ri_type_id: entry.typeId,
                ri_status: entry.status,
                ri_resource: entry.resource
            }));
    return read as PSqlSql;
}
