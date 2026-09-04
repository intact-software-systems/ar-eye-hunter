import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../../persistence/decode-rtc-topology-snapshot.ts';
import { rtcTopologySemanticEqual } from '../../persistence/rtc-topology-semantic-equal.ts';
import { compareTopologyTuple } from '../../persistence/rtc-topology-snapshot-contract.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import {
    computeRtcTopologyPublicationOutbox,
    validateRtcTopologyPublicationOutbox
} from '../../publication/rtc-topology-ws-outbox-entry.ts';
import { validateRtcTopologyPublication } from '../../publication/validate-rtc-topology-publication.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError
} from '../delivery/rtc-topology-delivery-validation.ts';

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
    try {
        validateRtcTopologyPublicationOutbox(publication, outbox);
    }
    catch {
        throw corruption(input.entry, 'the durable outbox differs from its publication');
    }

    const current = readCurrentSnapshot(input.currentSnapshot, input.entry);
    const historical = readPublicationSnapshot(publication, input.entry);
    const comparison = compareTopologyTuple(current, historical);
    if (comparison === 'equal') {
        if (!rtcTopologySemanticEqual(current, historical)) {
            throw corruption(input.entry, 'equal topology identity has different content');
        }
        return {
            status: 'deliver-publication',
            message: decodePersistedALMessage(outbox.resource)
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
        return decodeRtcTopologySnapshot(
            decodeJsonWireValue(
                JSON.parse(publication.message.payload.resource),
                'RTC topology publication snapshot'
            ),
            entry.groupRef
        );
    }
    catch {
        throw corruption(entry, 'the publication topology payload is invalid');
    }
}

function readCurrentSnapshot(
    snapshot: RallarOverlayTopologySnapshot | undefined,
    entry: RtcTopologyDeliveryLogEntry
): RallarOverlayTopologySnapshot {
    if (!snapshot) {
        throw corruption(entry, 'current durable topology is missing');
    }
    try {
        return decodeRtcTopologySnapshot(
            decodeJsonWireValue(snapshot, 'Current RTC topology snapshot'),
            entry.groupRef
        );
    }
    catch {
        throw corruption(entry, 'current durable topology is invalid');
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
