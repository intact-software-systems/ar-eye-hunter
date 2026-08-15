import type { GroupRef } from '@shared/api/group-types.ts';

export type RtcRttEndpointAdmission = Readonly<{
  endpointId: string;
  peers: readonly Readonly<{
    peerSessionId: string;
    expiresAtEpochMs: number;
  }>[];
  version: number;
  updatedAtEpochMs: number;
}>;

export type RtcRttMutationReceipt = Readonly<{
  receiptId: string;
  commandId: string;
  requestId: string;
  sessionIdFrom: string;
  sessionIdTo: string;
  aggregateRef: Readonly<{ sessionIdFrom: string; sessionIdTo: string }>;
  measurementVersion: number;
  affectedGroupRefs: readonly GroupRef[];
  acceptedAtEpochMs: number;
  outcome: 'accepted';
  attemptCount: number;
  acceptedStorageRevision: number;
  eventId: null;
  outboxIds: readonly string[];
  commandHash: string;
}>;
