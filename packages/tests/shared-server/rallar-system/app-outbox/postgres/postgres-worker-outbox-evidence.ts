import { decodeJsonWireValue, type JsonWireObject, type JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';
import { AppTopics, EnqueuedType } from '@shared/api/api-config.ts';
import { GROUP_PRESENCE_SUMMARY_TOPIC } from '@shared/queuebox/GroupPresenceSummaryEntryContract.ts';
import { EntityStatus } from '@shared/queuebox/ResourceEntry.ts';
import {
    expectDirectResourceOutboxLifecycle,
    type DirectResourceOutboxEvidence,
    type DirectResourceOutboxLifecycleExpectation
} from '../direct-resource-outbox-evidence.ts';

export type WorkerOutboxReceipt = Readonly<{
    outboxIds: readonly string[];
    domainStatus: 'applied' | 'no-op' | 'rejected';
}>;

export type WorkerOutboxKind = 'client' | 'group';
export type WorkerOutboxEffect =
    | 'principal-state:snapshot'
    | 'principal-state:event'
    | 'group-presence-summary';

export type DirectResourceInboxRowEvidence = Readonly<{
    ri_resource_id: string;
    ri_topic_id: string;
    ri_type_id: string;
    ri_status: string;
    ri_resource: string;
}>;

export interface ExpectWorkerOutboxLifecycleEvidenceInput {
    readonly entries: readonly DirectResourceOutboxEvidence[];
    readonly outputs: readonly WorkerOutboxReceipt[];
    readonly kind: WorkerOutboxKind;
    readonly effects: readonly WorkerOutboxEffect[];
}

export function expectWorkerOutboxLifecycleEvidence(input: ExpectWorkerOutboxLifecycleEvidenceInput): void {
    const { entries, outputs, kind, effects } = input;
    const expectedEntries = outputs.flatMap((output) => {
        if (output.domainStatus !== 'applied') {
            throw new Error(`Expected applied worker receipt, received: ${output.domainStatus}`);
        }
        if (output.outboxIds.length !== effects.length) {
            throw new Error(
                `Expected ${effects.length} ${kind} outbox ids, received: ${output.outboxIds.length}`
            );
        }
        return output.outboxIds.map((resourceId, index) => expectedOutboxEntry(resourceId, kind, effects[index]!));
    });
    const resourceIds = expectedEntries.map((entry) => entry.resourceId);
    if (new Set(resourceIds).size !== resourceIds.length) {
        throw new Error('Worker receipts must retain distinct direct outbox resource ids');
    }
    expectDirectResourceOutboxLifecycle(entries, {
        entries: expectedEntries,
        appToWsLinks: []
    });
}

export function expectGroupPresenceSummaryAppToWsLifecycleEvidence(
    rows: readonly DirectResourceInboxRowEvidence[],
    appResourceIds: readonly string[]
): void {
    const entries = rows.map((row) => ({
        resourceId: row.ri_resource_id,
        topicId: row.ri_topic_id,
        typeId: row.ri_type_id,
        status: row.ri_status,
        resource: row.ri_resource
    }));
    if (appResourceIds.length === 0) {
        throw new Error('Expected receipt-linked group presence-summary APP_OUTBOX rows');
    }
    const byResourceId = new Map(entries.map((entry) => [entry.resourceId, entry]));
    const appEntries = appResourceIds.map((resourceId) => {
        const entry = byResourceId.get(resourceId);
        if (!entry) {
            throw new Error(`Missing group presence-summary APP_OUTBOX: ${resourceId}`);
        }
        return entry;
    });
    const wsEntries = entries.filter((entry) => entry.typeId === EnqueuedType.WS_OUTBOX);
    const expectedEntries: DirectResourceOutboxLifecycleExpectation['entries'][number][] = [];
    const appToWsLinks: DirectResourceOutboxLifecycleExpectation['appToWsLinks'][number][] = [];

    for (const appEntry of appEntries) {
        const commandId = commandIdFromGroupPresenceSummaryEntry(appEntry);
        expectedEntries.push({
            resourceId: appEntry.resourceId,
            topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
            typeId: EnqueuedType.APP_OUTBOX,
            status: EntityStatus.COMPLETED,
            payloadIncludes: [commandId, 'group-presence-summary']
        });
        const linked = expectedGroupPresenceSummaryWsEntries(wsEntries, commandId);
        for (const wsEntry of linked) {
            expectedEntries.push(wsEntry.expected);
            appToWsLinks.push({
                appResourceId: appEntry.resourceId,
                wsResourceId: wsEntry.resourceId,
                linkIdentity: commandId
            });
        }
    }
    expectDirectResourceOutboxLifecycle(entries, { entries: expectedEntries, appToWsLinks });
}

function commandIdFromGroupPresenceSummaryEntry(entry: DirectResourceOutboxEvidence): string {
    try {
        const message = decodeJsonWireObject(JSON.parse(entry.resource), 'APP_OUTBOX message');
        const payload = decodeJsonWireObject(message.payload, 'APP_OUTBOX payload');
        const resource = readJsonWireString(payload.resource, 'APP_OUTBOX payload resource');
        const envelope = decodeJsonWireObject(JSON.parse(resource), 'APP_OUTBOX envelope');
        const data = decodeJsonWireObject(envelope.data, 'APP_OUTBOX envelope data');
        const commandId = data.commandId;
        if (typeof commandId !== 'string' || commandId.length === 0) {
            throw new TypeError('missing command id');
        }
        return commandId;
    }
    catch {
        throw new Error(`Invalid group presence-summary APP_OUTBOX payload: ${entry.resourceId}`);
    }
}

function decodeJsonWireObject(value: unknown, label: string): JsonWireObject {
    const decoded = decodeJsonWireValue(value, label);
    if (!isJsonWireObject(decoded)) {
        throw new TypeError(`${label} must be an object`);
    }
    return decoded;
}

function isJsonWireObject(value: JsonWireValue): value is JsonWireObject {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readJsonWireString(value: JsonWireValue | undefined, label: string): string {
    if (typeof value !== 'string') {
        throw new TypeError(`${label} must be a string`);
    }
    return value;
}

function expectedGroupPresenceSummaryWsEntries(
    entries: readonly DirectResourceOutboxEvidence[],
    commandId: string
): readonly Readonly<{
    resourceId: string;
    expected: DirectResourceOutboxLifecycleExpectation['entries'][number];
}>[] {
    // The event row carries the delta envelope; the bare member-state:event
    // payload went with snapshot-per-change.
    const expectedEffects = [
        ['member-state:delta-envelope', AppTopics.groupStateEvent]
    ] as const;
    return expectedEffects.map(([effect, topicId]) => {
        const matching = entries.filter((entry) =>
            entry.topicId === topicId &&
            entry.resource.includes(commandId) &&
            entry.resource.includes(effect)
        );
        if (matching.length !== 1) {
            throw new Error(
                `Expected one ${effect} WS_OUTBOX linked to group presence command: ${commandId}`
            );
        }
        const entry = matching[0]!;
        return {
            resourceId: entry.resourceId,
            expected: {
                resourceId: entry.resourceId,
                topicId,
                typeId: EnqueuedType.WS_OUTBOX,
                status: EntityStatus.NEW,
                payloadIncludes: [commandId, effect]
            }
        };
    });
}

function expectedOutboxEntry(
    resourceId: string,
    kind: WorkerOutboxKind,
    effect: WorkerOutboxEffect
): DirectResourceOutboxLifecycleExpectation['entries'][number] {
    if (kind === 'client' && effect === 'principal-state:snapshot') {
        return {
            resourceId,
            topicId: AppTopics.clientStateSnapshot,
            typeId: EnqueuedType.WS_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, effect]
        };
    }
    if (kind === 'client' && effect === 'principal-state:event') {
        return {
            resourceId,
            topicId: AppTopics.clientStateEvent,
            typeId: EnqueuedType.WS_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, effect]
        };
    }
    if (kind === 'group' && effect === 'group-presence-summary') {
        return {
            resourceId,
            topicId: GROUP_PRESENCE_SUMMARY_TOPIC,
            typeId: EnqueuedType.APP_OUTBOX,
            status: EntityStatus.NEW,
            payloadIncludes: [resourceId, '\\"effectKind\\":\\"group-presence-summary\\"']
        };
    }
    throw new Error(`Unsupported ${kind} worker outbox effect: ${effect}`);
}
