import type { GroupRef } from '@shared/api/group-types.ts';
import type { Key } from '@shared/queuebox/ResourceEntry.ts';

export interface RtcTopologyDeliveryAppendInput {
    readonly publisherStreamId: string;
    readonly groupRef: GroupRef;
    readonly publicationId: string;
    readonly outboxKey: Key;
    readonly retainUntilEpochMs: number;
}

/** Persistence-ready append computed before the transaction begins. */
export interface RtcTopologyDeliveryAppend extends RtcTopologyDeliveryAppendInput {
    readonly retainUntilIsoTimestamp: string;
}

export interface RtcTopologyDeliveryPublicationReadInput {
    readonly groupRef: GroupRef;
    readonly publicationId: string;
}

export interface RtcTopologyDeliveryStream {
    readonly streamId: string;
    readonly headSequence: number;
    readonly retainedFromSequence: number;
    readonly leaseExpiresAtEpochMs: number;
}

export interface RtcTopologyDeliveryLogEntry extends RtcTopologyDeliveryAppendInput {
    readonly sequence: number;
    readonly insertedAtEpochMs: number;
}

export interface RtcTopologyDeliveryStreamRegistrationInput {
    readonly streamId: string;
    readonly leaseDurationMs: number;
}

export type RtcTopologyDeliveryStreamRegistrationResult =
    | Readonly<{ status: 'registered'; stream: RtcTopologyDeliveryStream; }>
    | Readonly<{ status: 'conflict'; }>;

export interface RtcTopologyDeliveryStreamLeaseRenewalInput {
    readonly streamId: string;
    readonly leaseDurationMs: number;
}

export type RtcTopologyDeliveryStreamLeaseRenewalResult =
    | Readonly<{ status: 'renewed'; stream: RtcTopologyDeliveryStream; }>
    | Readonly<{ status: 'lease-lost'; }>;

export type RtcTopologyDeliveryAppendResult =
    | Readonly<{ status: 'appended'; entry: RtcTopologyDeliveryLogEntry; }>
    | Readonly<{ status: 'existing'; entry: RtcTopologyDeliveryLogEntry; }>
    | Readonly<{ status: 'conflict'; }>
    | Readonly<{ status: 'lease-lost'; }>;

export interface RtcTopologyDeliveryCompactionInput {
    readonly pageSize: number;
}

export interface RtcTopologyDeliveryCompactionResult {
    readonly scannedStreamCount: number;
    readonly deletedEntryCount: number;
}
