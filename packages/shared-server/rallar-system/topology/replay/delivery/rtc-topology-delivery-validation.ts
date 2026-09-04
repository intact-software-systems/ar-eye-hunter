import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import { validateRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import { validateRtcTopologyPublication } from '../../publication/validate-rtc-topology-publication.ts';
import type {
    RtcTopologyDeliveryAppendInput,
    RtcTopologyDeliveryLogEntry,
    RtcTopologyDeliveryPublicationReadInput
} from './rtc-topology-delivery-contracts.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RETRYABLE_UNIQUE_CONSTRAINTS = new Set([
    'rtc_topology_delivery_log_pkey',
    'rtc_topology_delivery_log_publication_uq'
]);

export class RtcTopologyDeliveryCorruptionError extends Error {
    readonly code = 'rtc-topology-delivery-corruption';

    constructor(message: string) {
        super(message);
        this.name = 'RtcTopologyDeliveryCorruptionError';
    }
}

export type RtcTopologyDeliveryBoundaryNumber =
    | number
    | string
    | bigint
    | null
    | undefined;

interface RtcTopologyDeliveryDatabaseError extends Error {
    readonly code?: string;
    readonly constraint_name?: string;
    readonly constraint?: string;
}

export function readRtcTopologyDeliverySafeInteger(
    value: RtcTopologyDeliveryBoundaryNumber,
    label: string
): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${label} must be a non-negative safe integer`);
    }

    return value;
}

export function isRtcTopologyDeliveryRetryableConflict(error: Error): boolean {
    const candidate = error as RtcTopologyDeliveryDatabaseError;
    const constraint = candidate.constraint_name ?? candidate.constraint;
    return (
        candidate.code === '23505' &&
        typeof constraint === 'string' &&
        RETRYABLE_UNIQUE_CONSTRAINTS.has(constraint)
    );
}

export function toRtcTopologyDeliveryAppendInput(
    publisherStreamId: string,
    publication: RtcTopologyPublication,
    outbox: ResourceEntry
): RtcTopologyDeliveryAppendInput {
    validateRtcTopologyDeliveryStreamId(publisherStreamId);
    validateRtcTopologyPublication(publication, publication.groupRef);
    validateDeliveryGroupRef(publication);

    validateRtcTopologyPublicationOutbox(publication, outbox);

    return {
        publisherStreamId,
        groupRef: {
            applicationId: publication.groupRef.applicationId,
            workspaceId: publication.groupRef.workspaceId,
            groupId: publication.groupRef.groupId
        },
        publicationId: publication.publicationId,
        outboxKey: {
            topicId: outbox.key.topicId,
            resourceId: outbox.key.resourceId,
            contextId: outbox.key.contextId
        },
        retainUntilEpochMs: readRtcTopologyDeliverySafeInteger(
            publication.message.constraints?.expiresAtMs,
            'RTC topology delivery retention timestamp'
        )
    };
}

export function validateRtcTopologyDeliveryAppendInput(
    input: RtcTopologyDeliveryAppendInput
): void {
    validateRtcTopologyDeliveryStreamId(input.publisherStreamId);
    validateRtcTopologyDeliveryPublicationReadInput(input);
    validateNonEmpty(input.outboxKey.topicId, 'outbox topic ID');
    validateNonEmpty(input.outboxKey.resourceId, 'outbox resource ID');
    validateNonEmpty(input.outboxKey.contextId, 'outbox context ID');
    readRtcTopologyDeliverySafeInteger(
        input.retainUntilEpochMs,
        'RTC topology delivery retention timestamp'
    );
}

export function validateRtcTopologyDeliveryPublicationReadInput(
    input: RtcTopologyDeliveryPublicationReadInput
): void {
    validateNonEmpty(input.groupRef.applicationId, 'application ID');
    validateNonEmpty(input.groupRef.workspaceId, 'workspace ID');
    validateNonEmpty(input.groupRef.groupId, 'group ID');
    validateNonEmpty(input.publicationId, 'publication ID');
}

export function validateRtcTopologyDeliveryLogEntry(
    entry: RtcTopologyDeliveryLogEntry,
    expected: RtcTopologyDeliveryAppendInput
): void {
    if (
        entry.groupRef.applicationId !== expected.groupRef.applicationId ||
        entry.groupRef.workspaceId !== expected.groupRef.workspaceId ||
        entry.groupRef.groupId !== expected.groupRef.groupId ||
        entry.publicationId !== expected.publicationId ||
        entry.outboxKey.topicId !== expected.outboxKey.topicId ||
        entry.outboxKey.resourceId !== expected.outboxKey.resourceId ||
        entry.outboxKey.contextId !== expected.outboxKey.contextId ||
        entry.retainUntilEpochMs !== expected.retainUntilEpochMs
    ) {
        throw new RtcTopologyDeliveryCorruptionError(
            `RTC topology delivery publication ${expected.publicationId} has conflicting durable identity`
        );
    }
}

export function validateRtcTopologyDeliveryStreamId(streamId: string): void {
    if (!UUID_PATTERN.test(streamId)) {
        throw new TypeError('RTC topology publisher stream ID must be a UUID');
    }
}

function validateDeliveryGroupRef(publication: RtcTopologyPublication): void {
    const { applicationId, workspaceId, groupId } = publication.groupRef;
    if (
        typeof applicationId !== 'string' ||
        applicationId.trim().length === 0 ||
        typeof workspaceId !== 'string' ||
        workspaceId.trim().length === 0 ||
        typeof groupId !== 'string' ||
        groupId.trim().length === 0
    ) {
        throw new TypeError('RTC topology delivery group scope must be complete');
    }
}

function validateNonEmpty(value: string, label: string): void {
    if (value.trim().length === 0) {
        throw new TypeError(`RTC topology delivery ${label} must be non-empty`);
    }
}
