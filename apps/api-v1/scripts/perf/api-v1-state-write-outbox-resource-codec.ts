import { decodeALMessageValue } from '@shared/al-contracts/al-message-persistence-validation.ts';
import { decodeStateSnapshotPage } from '@shared/api/state-snapshot-page.ts';
import { toAppQueueKey } from '@shared/queuebox/AppQueueIdentity.ts';
import { Either } from '@shared/resilience/Either.ts';

import type { JsonWireObject, JsonWireValue } from '@shared-server/rallar-system/protocol/json-wire-identity.ts';

import type { ProductionOutboxExpectation } from './api-v1-state-write-outbox-expectations.ts';

export interface ProductionOutboxRecord {
    readonly resourceId: string;
    readonly outboxId: string;
    readonly typeId: 'APP_OUTBOX' | 'WS_OUTBOX';
    readonly topicId: string;
    readonly effectKind: string;
    readonly canonicalCommandId: string;
}

export interface ProductionOutboxRow {
    readonly ri_resource_id: string;
    readonly ri_topic_id: string;
    readonly fk_ext_bank_id: string;
    readonly ri_type_id: string;
    readonly ri_resource: string;
}

export function validateExpectedProductionOutboxRecord(
    row: ProductionOutboxRow,
    expectation: ProductionOutboxExpectation
): Either<Error, ProductionOutboxRecord> {
    try {
        const message = requireJsonWireObject(JSON.parse(row.ri_resource));
        if (!matchesExpectedOutboxRow(row, expectation) || !matchesExpectedMessage(message, expectation)) {
            return Either.ofLeft(new TypeError('ResourceInbox outbox differs from its receipt'));
        }
        return Either.ofRight({
            resourceId: row.ri_resource_id,
            outboxId: requireNonEmptyString(requireJsonWireObject(message.id).msgId),
            typeId: expectation.typeId,
            topicId: row.ri_topic_id,
            effectKind: expectation.effectKind,
            canonicalCommandId: expectation.canonicalCommandId
        });
    }
    catch (error) {
        return Either.ofLeft(error instanceof Error ? error : new TypeError('Invalid ResourceInbox outbox'));
    }
}

function matchesExpectedOutboxRow(row: ProductionOutboxRow, expectation: ProductionOutboxExpectation): boolean {
    return row.ri_resource_id === expectation.physicalKey.resourceId &&
        row.ri_topic_id === expectation.physicalKey.topicId &&
        row.fk_ext_bank_id === expectation.physicalKey.contextId &&
        row.ri_type_id === expectation.typeId && computeResourceEffectKind(row) === expectation.effectKind;
}

function matchesExpectedMessage(message: JsonWireObject, expectation: ProductionOutboxExpectation): boolean {
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
        route.topicId !== expectation.physicalKey.topicId ||
        route.contextId !== expectation.physicalKey.contextId ||
        payload.typeId !== expectation.payloadTypeId ||
        messagePhysicalKey.resourceId !== expectation.physicalKey.resourceId ||
        (expectation.identityKind === 'logical-msg-id' && messageId !== expectation.effectId)
    ) {
        return false;
    }
    if (expectation.effectKind === 'principal-state:snapshot') {
        return matchesSnapshotMessage(message, expectation);
    }
    if (
        route.resourceId !== expectation.physicalKey.resourceId ||
        readCanonicalMessageId(message) !== expectation.canonicalCommandId ||
        (expectation.sourceMessageId !== null && messageId !== expectation.sourceMessageId)
    ) {
        return false;
    }
    if (expectation.typeId !== 'APP_OUTBOX') {
        return true;
    }
    const envelope = typeof payload.resource === 'string'
        ? requireJsonWireObject(JSON.parse(payload.resource))
        : undefined;
    return envelope?.type === expectation.payloadTypeId &&
        envelope.topicId === expectation.physicalKey.topicId &&
        envelope.resourceId === messageId && envelope.contextId === expectation.logicalContextId;
}

function matchesSnapshotMessage(message: JsonWireObject, expectation: ProductionOutboxExpectation): boolean {
    const decoded = decodeALMessageValue(message);
    if (decoded.left || expectation.sourceMessageId === null) {
        return false;
    }
    const envelope = decoded.right!;
    const decodedPage = decodeStateSnapshotPage(envelope, expectation.aggregateRef);
    if (decodedPage.left) {
        return false;
    }
    const page = decodedPage.right!;
    const sourceKey = toAppQueueKey({
        resourceId: expectation.sourceMessageId,
        topicId: expectation.physicalKey.topicId,
        contextId: expectation.logicalContextId
    });
    return page.scope.kind === 'principal' &&
        page.scope.resourceId === expectation.aggregateRef.principalId &&
        page.revision === `revision=${expectation.stateRevision}` &&
        page.originalMessageId === expectation.sourceMessageId &&
        envelope.route.resourceId === sourceKey.resourceId;
}

function requireJsonWireObject(value: JsonWireValue | undefined): JsonWireObject {
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

function readCanonicalMessageId(value: JsonWireValue): string | undefined {
    if (!isJsonWireObject(value) || !isJsonWireObject(value.id)) {
        return undefined;
    }
    return effectIdentityCommandIds(value.id.msgId)[0];
}

function isJsonWireObject(
    value: JsonWireValue | undefined
): value is JsonWireObject {
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

function computeResourceEffectKind(
    row: Pick<ProductionOutboxRow, 'ri_resource_id' | 'ri_topic_id' | 'ri_type_id' | 'ri_resource'>
): string | undefined {
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
    return undefined;
}
