import { Temporal } from '@js-temporal/polyfill';

import type { JsonWireValue } from '@shared-server/rallar-system/services/mutation-command-identity.ts';
import type { RallarCrdtDocumentRef } from '@shared/crdt/mod.ts';
import { EntityStatus, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

const FUTURE_INSTANT = Temporal.Instant.from('9999-12-31T23:59:59.999Z');
const CREATED_TS = Temporal.PlainDateTime.from('2026-06-01T12:00:00');
const CRDT_ROOM_REF = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    groupId: 'room-1'
};

interface CreateResourceEntryOptions {
    readonly topicId?: string;
    readonly contextId?: string;
    readonly typeId?: string;
    readonly status?: EntityStatus;
    readonly payload?: JsonWireValue;
    readonly expiryTs?: Temporal.Instant;
}

export const CRDT_DOCUMENT_REF: RallarCrdtDocumentRef = {
    applicationId: 'rallar-test',
    workspaceId: 'main',
    scope: 'room',
    documentType: 'checklist',
    documentId: 'room-1',
    roomRef: CRDT_ROOM_REF
};

export function createResourceEntry(
    resourceId: string,
    options: CreateResourceEntryOptions = {}
): ResourceEntry {
    return {
        key: {
            topicId: options.topicId ?? 'topic-smoke',
            resourceId,
            contextId: options.contextId ?? 'ctx-smoke'
        },
        resource: JSON.stringify(options.payload ?? { resourceId }),
        typeId: options.typeId ?? 'TYPE_A',
        status: options.status ?? EntityStatus.NEW,
        audit: {
            date: CREATED_TS.toPlainTime(),
            createdBy: 'tester',
            createdTs: CREATED_TS,
            expiryTs: options.expiryTs ?? FUTURE_INSTANT
        },
        dequeueAudit: {
            attempts: 0
        }
    };
}
