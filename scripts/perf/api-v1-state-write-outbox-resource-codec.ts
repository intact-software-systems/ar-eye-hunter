import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';

import type { JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { ProductionOutboxExpectation } from './api-v1-state-write-outbox-expectations.ts';

export interface ProductionOutboxRecord {
    readonly resourceId: string;
    readonly outboxId: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
    readonly effectKind: string;
    readonly canonicalCommandId?: string;
    readonly commandIds: readonly string[];
}

export interface ProductionOutboxRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_type_id: string;
    readonly ri_resource: string;
}

export function readExpectedProductionOutboxRecord(
    row: ProductionOutboxRow,
    expectation: ProductionOutboxExpectation
): ProductionOutboxRecord | undefined {
    try {
        if (!isExpectedProductionOutboxRow(row, expectation)) {
            return undefined;
        }
        return {
            resourceId: row.ri_resource_id,
            outboxId: readOutboxMessageId(row.ri_resource),
            typeId: requireOutboxType(row.ri_type_id),
            topicId: row.ri_topic_id,
            effectKind: readResourceEffectKind(row),
            canonicalCommandId: readCanonicalEffectCommandId(row.ri_resource),
            commandIds: readAllCommandIds(row.ri_resource)
        };
    }
    catch {
        return undefined;
    }
}

function isExpectedProductionOutboxRow(
    row: ProductionOutboxRow,
    expectation: ProductionOutboxExpectation
): boolean {
    if (
        row.ri_resource_id !== expectation.physicalKey.resourceId ||
        row.ri_topic_id !== expectation.physicalKey.topicId ||
        row.fk_ext_bank_id !== expectation.physicalKey.contextId ||
        row.ri_type_id !== expectation.typeId ||
        readResourceEffectKind(row) !== expectation.effectKind
    ) {
        return false;
    }
    const message = requireJsonWireObject(JSON.parse(row.ri_resource));
    const id = requireJsonWireObject(message.id);
    const route = requireJsonWireObject(message.route);
    const payload = requireJsonWireObject(message.payload);
    const messageId = requireNonEmptyString(id.msgId);
    const messagePhysicalKey = toAppQueueKey({
        resourceId: messageId,
        topicId: expectation.physicalKey.topicId,
        contextId: expectation.logicalContextId
    });
    if (
        route.resourceId !== row.ri_resource_id ||
        route.topicId !== row.ri_topic_id ||
        route.contextId !== row.fk_ext_bank_id ||
        payload.typeId !== expectation.payloadTypeId ||
        readCanonicalEffectCommandId(row.ri_resource) !== expectation.canonicalCommandId ||
        messagePhysicalKey.resourceId !== expectation.physicalKey.resourceId ||
        messagePhysicalKey.topicId !== expectation.physicalKey.topicId ||
        messagePhysicalKey.contextId !== expectation.physicalKey.contextId ||
        (expectation.identityKind === 'logical-msg-id' && messageId !== expectation.effectId)
    ) {
        return false;
    }
    if (row.ri_type_id !== 'APP_OUTBOX') {
        return true;
    }
    const envelope = typeof payload.resource === 'string'
        ? requireJsonWireObject(JSON.parse(payload.resource))
        : undefined;
    return envelope?.type === expectation.payloadTypeId &&
        envelope.topicId === expectation.physicalKey.topicId &&
        envelope.resourceId === messageId &&
        envelope.contextId === expectation.logicalContextId;
}

function readOutboxMessageId(resource: string): string {
    const message = requireJsonWireObject(JSON.parse(resource));
    return requireNonEmptyString(requireJsonWireObject(message.id).msgId);
}

function requireJsonWireObject(value: JsonWireValue | undefined): Readonly<Record<string, JsonWireValue>> {
    if (!isJsonWireObject(value)) {
        throw new TypeError('ResourceInbox outbox envelope is invalid');
    }
    return value;
}

function requireNonEmptyString(value: JsonWireValue | undefined): string {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('ResourceInbox outbox message identity is invalid');
    }
    return value;
}

export function readAllCommandIds(resource: string): string[] {
    try {
        const parsed: JsonWireValue = JSON.parse(resource);
        return [...new Set(findCommandIds(parsed))];
    }
    catch {
        return [];
    }
}

export function readCanonicalEffectCommandId(resource: string): string | undefined {
    try {
        const envelope: JsonWireValue = JSON.parse(resource);
        return readCanonicalMessageId(envelope);
    }
    catch {
        return undefined;
    }
}

function readCanonicalMessageId(value: JsonWireValue): string | undefined {
    if (!isJsonWireObject(value) || !isJsonWireObject(value.id)) {
        return undefined;
    }
    return effectIdentityCommandIds(value.id.msgId)[0];
}

function findCommandIds(value: JsonWireValue): string[] {
    if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
        try {
            const parsed: JsonWireValue = JSON.parse(value);
            return findCommandIds(parsed);
        }
        catch {
            return [];
        }
    }
    if (!isJsonWireObject(value)) {
        return [];
    }
    return [
        ...(typeof value.commandId === 'string' ? [value.commandId] : []),
        ...(typeof value.requestId === 'string' ? [value.requestId] : []),
        ...effectIdentityCommandIds(value.msgId),
        ...effectIdentityCommandIds(value.resourceId),
        ...Object.values(value).flatMap(findCommandIds)
    ];
}

function isJsonWireObject(
    value: JsonWireValue | undefined
): value is Readonly<Record<string, JsonWireValue>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function effectIdentityCommandIds(value: JsonWireValue | undefined): string[] {
    if (typeof value !== 'string') {
        return [];
    }
    for (
        const marker of [
            ':rtc-topology-recompute:',
            ':group-presence-summary:',
            ':principal-state:'
        ]
    ) {
        const index = value.indexOf(marker);
        if (index > 0) {
            return [value.slice(0, index)];
        }
    }
    return [];
}

function requireOutboxType(value: string): 'APP_OUTBOX' | 'WS_OUTBOX' {
    if (value !== 'APP_OUTBOX' && value !== 'WS_OUTBOX') {
        throw new Error(`Receipt references non-outbox ResourceInbox row: ${value}`);
    }
    return value;
}

export function readResourceEffectKind(
    row: Pick<ProductionOutboxRow, 'ri_resource_id' | 'ri_topic_id' | 'ri_type_id' | 'ri_resource'>
): string {
    if (row.ri_topic_id === 'app-outbox.group-presence-summary') {
        return 'group-presence-summary';
    }
    if (row.ri_topic_id === 'app-outbox.rtc-topology') {
        return 'rtc-topology-recompute';
    }
    if (row.ri_type_id === 'WS_OUTBOX') {
        if (row.ri_topic_id === 'client-state.snapshot') {
            return 'principal-state:snapshot';
        }
        if (row.ri_topic_id === 'client-state.event') {
            return 'principal-state:event';
        }
    }
    throw new Error(`Unrecognized final ResourceInbox effect ${row.ri_type_id}:${row.ri_topic_id}`);
}
