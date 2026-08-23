import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/RuntimeStateJsonStore.ts';
import { hashMutationCommand, type JsonWireValue } from '../../protocol/json-wire-identity.ts';
import { RTC_TOPOLOGY_REPLAY_RETENTION_MS } from '../replay/rtc-topology-replay-policy.ts';
import { validateWorkClaim, type PersistedBoundaryValue } from './rtc-topology-publication-repository-state.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from './validate-rtc-topology-publication.ts';

export const RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE = 'rtc-topology:publications';
export const RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE = 'rtc-topology:publication-work-index';
export const DEFAULT_RTC_TOPOLOGY_PUBLICATION_RETENTION_MS = RTC_TOPOLOGY_REPLAY_RETENTION_MS;

export type RtcTopologyPublicationWorkClaim = Readonly<{
    kind: 'rtc-topology-execution-receipt';
    schemaVersion: 1;
    groupRef: GroupRef;
    workId: string;
    commandId: string;
    requestId: string;
    commandHash: string;
    publicationId: string;
    outcome: 'accepted';
    attemptCount: number;
    acceptedCausalRevision: GroupStateCausalRevision;
    acceptedStorageRevision: number;
    eventId: null;
    outboxIds: readonly string[];
}>;

export type RtcTopologyExecutionReceiptFacts = Readonly<{
    commandHash: string;
    attemptCount: number;
    acceptedStorageRevision: number;
}>;

export type RtcTopologyClaimedPublication = Readonly<{
    claim: RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>;
    publication: RtcTopologyPublication;
}>;

export type PutRtcTopologyPublicationResult = Readonly<{
    publication: RtcTopologyPublication;
    inserted: boolean;
}>;

export async function hashRtcTopologyExecutionCommand(
    publication: RtcTopologyPublication
): Promise<string> {
    validateRtcTopologyPublication(publication, publication.groupRef);
    const command: PersistedBoundaryValue = {
        kind: 'rtc-topology-execution',
        schemaVersion: 1,
        publication
    };
    return await hashMutationCommand(command as JsonWireValue);
}

export function createRtcTopologyExecutionReceipt(
    publication: RtcTopologyPublication,
    facts: RtcTopologyExecutionReceiptFacts
): RtcTopologyPublicationWorkClaim {
    const receipt: RtcTopologyPublicationWorkClaim = {
        kind: 'rtc-topology-execution-receipt',
        schemaVersion: 1,
        groupRef: publication.groupRef,
        workId: publication.workId,
        commandId: publication.workId,
        requestId: publication.workId,
        commandHash: facts.commandHash,
        publicationId: publication.publicationId,
        outcome: 'accepted',
        attemptCount: facts.attemptCount,
        acceptedCausalRevision: publication.sourceGroupStateCausalRevision,
        acceptedStorageRevision: facts.acceptedStorageRevision,
        eventId: null,
        outboxIds: [publication.publicationId]
    };
    validateWorkClaim(receipt, publication.groupRef);
    return receipt;
}

export class RtcTopologyPublicationCollisionError extends Error {
    readonly code = 'rtc-topology-publication-collision';
    readonly status = 409;

    readonly storageKey: string;

    constructor(storageKey: string) {
        super(`RTC topology immutable publication collision: ${storageKey}`);
        this.storageKey = storageKey;
        this.name = 'RtcTopologyPublicationCollisionError';
    }
}
