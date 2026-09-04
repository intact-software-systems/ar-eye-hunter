import type { GroupRef, GroupStateCausalRevision } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { encodeJsonWireValue, hashMutationCommand } from '../../protocol/json-wire-identity.ts';
import { validateWorkClaim, type PersistedBoundaryValue } from './rtc-topology-publication-repository-state.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from './validate-rtc-topology-publication.ts';

export const RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE = 'rtc-topology:publications';
export const RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE = 'rtc-topology:publication-work-index';

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

export async function hashRtcTopologyExecutionCommand(
    publication: RtcTopologyPublication
): Promise<string> {
    validateRtcTopologyPublication(publication, publication.groupRef);
    const command: PersistedBoundaryValue = {
        kind: 'rtc-topology-execution',
        schemaVersion: 1,
        publication
    };
    return await hashMutationCommand(
        encodeJsonWireValue(command, 'RTC topology execution command')
    );
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
