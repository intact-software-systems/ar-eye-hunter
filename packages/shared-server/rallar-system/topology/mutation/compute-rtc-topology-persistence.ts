import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '@shared/persistence/PersistenceProvider.ts';

import { encodeJsonWireValue } from '../../protocol/json-wire-identity.ts';
import { toStoredRtcTopologySnapshotRow } from '../persistence/rtc-topology-snapshot-repository.ts';
import { createRtcTopologyExecutionReceipt } from '../publication/rtc-topology-publication-repository-contracts.ts';
import { childKey } from '../publication/rtc-topology-publication-repository-state.ts';
import type { RtcTopologyPublication } from '../publication/rtc-topology-publication.ts';

export interface RtcTopologyPersistenceInput {
    readonly snapshot: RallarOverlayTopologySnapshot;
    readonly expectedRevision: number | null;
    readonly publication: RtcTopologyPublication | null;
    readonly publicationExpireAtTimestamp: number | null;
    readonly commandHash: string | null;
    readonly attemptCount: number | null;
}

export interface RtcTopologyPersistenceComputed {
    readonly snapshot: {
        readonly key: string;
        readonly value: string;
        readonly expireAtIsoTimestamp: string;
        readonly expectedRevision: number | null;
        readonly acceptedStorageRevision: number;
    };
    readonly publication: {
        readonly key: string;
        readonly value: string;
        readonly receiptKey: string;
        readonly receiptValue: string;
        readonly expireAtIsoTimestamp: string;
    } | null;
}

export function computeRtcTopologyPersistence(
    input: RtcTopologyPersistenceInput
): RtcTopologyPersistenceComputed {
    const acceptedStorageRevision = input.expectedRevision === null
        ? 0
        : input.expectedRevision + 1;
    if (!Number.isSafeInteger(acceptedStorageRevision) || acceptedStorageRevision < 0) {
        throw new TypeError('RTC topology accepted storage revision is invalid');
    }
    const snapshot = toStoredRtcTopologySnapshotRow(input.snapshot);
    return {
        snapshot: {
            ...snapshot,
            expireAtIsoTimestamp: new Date(NEVER_EXPIRE_AT_TIMESTAMP).toISOString(),
            expectedRevision: input.expectedRevision,
            acceptedStorageRevision
        },
        publication: computePublicationPersistence(input, acceptedStorageRevision)
    };
}

function computePublicationPersistence(
    input: RtcTopologyPersistenceInput,
    acceptedStorageRevision: number
): RtcTopologyPersistenceComputed['publication'] {
    const publication = input.publication;
    if (publication === null) {
        return null;
    }
    if (
        input.publicationExpireAtTimestamp === null ||
        input.commandHash === null ||
        input.attemptCount === null
    ) {
        throw new TypeError('RTC topology publication persistence facts are incomplete');
    }
    if (
        !Number.isSafeInteger(input.publicationExpireAtTimestamp) ||
        input.publicationExpireAtTimestamp <= publication.createdAtEpochMs
    ) {
        throw new TypeError('RTC topology publication expiry is invalid');
    }
    const receipt = createRtcTopologyExecutionReceipt(publication, {
        commandHash: input.commandHash,
        attemptCount: input.attemptCount,
        acceptedStorageRevision
    });
    const key = childKey(publication.groupRef, 'publication', publication.publicationId);
    return {
        key,
        value: JSON.stringify(encodeJsonWireValue(publication, 'RTC topology publication')),
        receiptKey: childKey(publication.groupRef, 'work', publication.workId),
        receiptValue: JSON.stringify(encodeJsonWireValue(receipt, 'RTC topology execution receipt')),
        expireAtIsoTimestamp: new Date(input.publicationExpireAtTimestamp).toISOString()
    };
}
