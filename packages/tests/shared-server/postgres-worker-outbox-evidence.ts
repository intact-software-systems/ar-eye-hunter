import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    expectDirectResourceOutboxLifecycle,
    type DirectResourceOutboxEvidence,
    type DirectResourceOutboxLifecycleExpectation,
} from './direct-resource-outbox-evidence.ts';

export type WorkerOutboxReceipt = Readonly<{
    outboxIds: readonly string[];
    domainStatus: 'applied' | 'no-op' | 'rejected';
}>;

export type WorkerOutboxKind = 'client' | 'group';
export type WorkerOutboxEffect =
    | 'principal-state:snapshot'
    | 'principal-state:event'
    | 'group-presence-summary';

export function expectWorkerOutboxLifecycleEvidence(
    entries: readonly DirectResourceOutboxEvidence[],
    outputs: readonly WorkerOutboxReceipt[],
    kind: WorkerOutboxKind,
    effects: readonly WorkerOutboxEffect[],
): void {
    const expectedEntries = outputs.flatMap((output) => {
        if (output.domainStatus !== 'applied') {
            throw new Error(`Expected applied worker receipt, received: ${output.domainStatus}`);
        }
        if (output.outboxIds.length !== effects.length) {
            throw new Error(
                `Expected ${effects.length} ${kind} outbox ids, received: ${output.outboxIds.length}`,
            );
        }
        return output.outboxIds.map((resourceId, index) =>
            expectedOutboxEntry(resourceId, kind, effects[index]!)
        );
    });
    const resourceIds = expectedEntries.map((entry) => entry.resourceId);
    if (new Set(resourceIds).size !== resourceIds.length) {
        throw new Error('Worker receipts must retain distinct direct outbox resource ids');
    }
    expectDirectResourceOutboxLifecycle(entries, {
        entries: expectedEntries,
        appToWsLinks: [],
    });
}

function expectedOutboxEntry(
    resourceId: string,
    kind: WorkerOutboxKind,
    effect: WorkerOutboxEffect,
): DirectResourceOutboxLifecycleExpectation['entries'][number] {
    if (kind === 'client' && effect === 'principal-state:snapshot') {
        return {
            resourceId,
            topicId: AppTopics.clientStateSnapshot,
            typeId: EnqueuedType.WS_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, effect],
        };
    }
    if (kind === 'client' && effect === 'principal-state:event') {
        return {
            resourceId,
            topicId: AppTopics.clientStateEvent,
            typeId: EnqueuedType.WS_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, effect],
        };
    }
    if (kind === 'group' && effect === 'group-presence-summary') {
        return {
            resourceId,
            topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
            typeId: EnqueuedType.APP_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, '"effectKind":"group-presence-summary"'],
        };
    }
    throw new Error(`Unsupported ${kind} worker outbox effect: ${effect}`);
}
