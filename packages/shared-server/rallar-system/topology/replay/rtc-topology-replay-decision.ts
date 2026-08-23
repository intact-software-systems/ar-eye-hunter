import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import { compareTopologyTuple, validateTopologySnapshot } from '../persistence/rtc-topology-snapshot-contract.ts';
import type { RtcTopologyPublication } from '../publication/rtc-topology-publication.ts';
import { computeRtcTopologyPublicationOutbox } from '../publication/rtc-topology-ws-outbox-entry.ts';
import { validateRtcTopologyPublication } from '../publication/validate-rtc-topology-publication.ts';
import type { RtcTopologyDeliveryLogEntry } from './rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError
} from './rtc-topology-delivery-validation.ts';

export interface RtcTopologyReplayEntryDecisionInput {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly publication?: RtcTopologyPublication;
    readonly outbox?: ResourceEntry;
    readonly currentSnapshot?: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export type RtcTopologyReplayEntryDecision =
    | Readonly<{ status: 'deliver-publication'; message: ALMessage; }>
    | Readonly<{
        status: 'deliver-current';
        currentSnapshot: RallarOverlayTopologySnapshot;
    }>
    | Readonly<{ status: 'gap'; }>;

export function decideRtcTopologyReplayEntry(
    input: RtcTopologyReplayEntryDecisionInput
): RtcTopologyReplayEntryDecision {
    const databaseNowEpochMs = readRtcTopologyDeliverySafeInteger(
        input.databaseNowEpochMs,
        'RTC topology replay database time'
    );
    if (input.entry.retainUntilEpochMs <= databaseNowEpochMs) {
        return { status: 'gap' };
    }
    const publication = input.publication;
    const outbox = input.outbox;
    if (!publication || !outbox) {
        throw corruption(input.entry, 'an unexpired durable reference is missing');
    }

    try {
        validateRtcTopologyPublication(publication, input.entry.groupRef);
    }
    catch {
        throw corruption(input.entry, 'the referenced publication is invalid');
    }
    if (publication.publicationId !== input.entry.publicationId) {
        throw corruption(input.entry, 'the referenced publication identity differs');
    }
    const expectedOutbox = computeRtcTopologyPublicationOutbox(publication);
    if (
        !isKeysEqual(input.entry.outboxKey, expectedOutbox.key) ||
        input.entry.retainUntilEpochMs !== expectedOutbox.audit.expiryTs.epochMilliseconds
    ) {
        throw corruption(input.entry, 'the log identity differs from its publication outbox');
    }
    if (
        !isKeysEqual(outbox.key, expectedOutbox.key) ||
        outbox.typeId !== expectedOutbox.typeId ||
        outbox.resource !== expectedOutbox.resource ||
        outbox.audit.expiryTs.epochMilliseconds !== expectedOutbox.audit.expiryTs.epochMilliseconds
    ) {
        throw corruption(input.entry, 'the durable outbox differs from its publication');
    }

    const current = input.currentSnapshot;
    if (!current) {
        throw corruption(input.entry, 'current durable topology is missing');
    }
    try {
        validateTopologySnapshot(current, input.entry.groupRef);
    }
    catch {
        throw corruption(input.entry, 'current durable topology is invalid');
    }
    const historical = readPublicationSnapshot(publication, input.entry);
    const comparison = compareTopologyTuple(current, historical);
    if (comparison === 'equal') {
        if (!rtcTopologySemanticEqual(current, historical)) {
            throw corruption(input.entry, 'equal topology identity has different content');
        }
        return {
            status: 'deliver-publication',
            message: JSON.parse(outbox.resource) as ALMessage
        };
    }
    if (comparison === 'dominates' || comparison === 'incomparable') {
        return { status: 'deliver-current', currentSnapshot: current };
    }
    throw corruption(input.entry, 'the historical publication appears newer than current topology');
}

function readPublicationSnapshot(
    publication: RtcTopologyPublication,
    entry: RtcTopologyDeliveryLogEntry
): RallarOverlayTopologySnapshot {
    try {
        const snapshot = JSON.parse(publication.message.payload.resource);
        validateTopologySnapshot(snapshot, entry.groupRef);
        return snapshot;
    }
    catch {
        throw corruption(entry, 'the publication topology payload is invalid');
    }
}

function corruption(
    entry: RtcTopologyDeliveryLogEntry,
    reason: string
): RtcTopologyDeliveryCorruptionError {
    return new RtcTopologyDeliveryCorruptionError(
        `RTC topology replay entry ${entry.publisherStreamId}/${entry.sequence}: ${reason}`
    );
}
