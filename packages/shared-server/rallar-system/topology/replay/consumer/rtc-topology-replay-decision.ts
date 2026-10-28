import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { decodePersistedALMessage } from '@shared/al-contracts/al-message-persistence-validation.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { isKeysEqual, type ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';

import { Either } from '@shared/resilience/Either.ts';
import { decodeJsonWireValue } from '../../../protocol/json-wire-identity.ts';
import { decodeRtcTopologySnapshot } from '../../persistence/decode-rtc-topology-snapshot.ts';
import { rtcTopologySemanticEqual } from '../../persistence/rtc-topology-semantic-equal.ts';
import { compareTopologyTuple } from '../../persistence/rtc-topology-snapshot-contract.ts';
import {
    decodeRtcTopologyPublication,
    type RtcTopologyPublicationRefusal
} from '../../publication/decode-rtc-topology-publication.ts';
import type { RtcTopologyPublicationRead } from '../../publication/rtc-topology-publication-repository-contracts.ts';
import type { RtcTopologyPublication } from '../../publication/rtc-topology-publication.ts';
import {
    assertRtcTopologyPublicationOutbox,
    computeRtcTopologyPublicationOutbox
} from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryLogEntry } from '../delivery/rtc-topology-delivery-contracts.ts';
import {
    readRtcTopologyDeliverySafeInteger,
    RtcTopologyDeliveryCorruptionError
} from '../delivery/rtc-topology-delivery-validation.ts';

export interface RtcTopologyReplayEntryDecisionInput {
    readonly entry: RtcTopologyDeliveryLogEntry;
    readonly publication: RtcTopologyPublicationRead;
    readonly outbox?: readonly (ResourceEntry | undefined)[];
    readonly currentSnapshot?: RallarOverlayTopologySnapshot;
    readonly databaseNowEpochMs: number;
}

export type RtcTopologyReplayEntryDecision =
    | { readonly status: 'deliver-publication'; readonly messages: readonly ALMessage[]; }
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
    return decodeReferencedPublication(input.entry, input.publication).fold<RtcTopologyReplayEntryDecision>(
        () => ({ status: 'gap' }),
        (publication) => decidePublicationDelivery(input, publication)
    );
}

function decidePublicationDelivery(
    input: RtcTopologyReplayEntryDecisionInput,
    publication: RtcTopologyPublication
): RtcTopologyReplayEntryDecision {
    const outbox = readPublicationOutbox(input.entry, publication, input.outbox);
    const current = readCurrentSnapshot(input.currentSnapshot, input.entry);
    const historical = readPublicationSnapshot(publication, input.entry);
    const comparison = compareTopologyTuple(current, historical);
    if (comparison === 'equal') {
        if (!rtcTopologySemanticEqual(current, historical)) {
            throw corruption(input.entry, 'equal topology identity has different content');
        }
        return {
            status: 'deliver-publication',
            messages: outbox.map((page) => decodePersistedALMessage(page.resource))
        };
    }
    if (comparison === 'dominates' || comparison === 'incomparable') {
        return { status: 'deliver-current', currentSnapshot: current };
    }
    throw corruption(input.entry, 'the historical publication appears newer than current topology');
}

/** A pre-v4 publication is a non-blocking refusal (Left): the consumer re-hydrates as for an expired reference. */
function decodeReferencedPublication(
    entry: RtcTopologyDeliveryLogEntry,
    read: RtcTopologyPublicationRead
): Either<RtcTopologyPublicationRefusal, RtcTopologyPublication> {
    if (read.status === 'unsupported') {
        return Either.ofLeft({ code: 'unsupported', message: read.message });
    }
    if (read.status === 'absent') {
        throw corruption(entry, 'an unexpired durable reference is missing');
    }
    return decodeRtcTopologyPublication(read.publication, entry.groupRef).fold<
        Either<RtcTopologyPublicationRefusal, RtcTopologyPublication>
    >((refusal) => {
        if (refusal.code === 'malformed') {
            throw corruption(entry, 'the referenced publication is invalid');
        }
        return Either.ofLeft(refusal);
    }, (publication) => {
        if (publication.publicationId !== entry.publicationId) {
            throw corruption(entry, 'the referenced publication identity differs');
        }
        return Either.ofRight(publication);
    });
}

function readPublicationOutbox(
    entry: RtcTopologyDeliveryLogEntry,
    publication: RtcTopologyPublication,
    outbox: readonly (ResourceEntry | undefined)[] | undefined
): readonly ResourceEntry[] {
    if (!outbox) {
        throw corruption(entry, 'an unexpired durable reference is missing');
    }
    const expectedOutbox = computeRtcTopologyPublicationOutbox(publication);
    if (
        !isKeysEqual(entry.outboxKey, expectedOutbox[0].key) ||
        entry.retainUntilEpochMs !== expectedOutbox[0].audit.expiryTs.epochMilliseconds
    ) {
        throw corruption(entry, 'the log identity differs from its publication outbox');
    }
    try {
        assertRtcTopologyPublicationOutbox(publication, outbox);
    }
    catch {
        throw corruption(entry, 'the durable outbox differs from its publication');
    }
    return outbox.flatMap((page) => page ? [page] : []);
}

function readPublicationSnapshot(
    publication: RtcTopologyPublication,
    entry: RtcTopologyDeliveryLogEntry
): RallarOverlayTopologySnapshot {
    try {
        return decodeRtcTopologySnapshot(
            decodeJsonWireValue(
                publication.snapshot,
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
