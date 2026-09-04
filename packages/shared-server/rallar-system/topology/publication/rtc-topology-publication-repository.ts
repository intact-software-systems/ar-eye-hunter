import type { GroupRef } from '@shared/api/group-types.ts';

import type { RuntimeStateEntryValue } from '../../../runtime-state/runtime-state-json-store.ts';
import { RuntimeStateJsonStore } from '../../../runtime-state/runtime-state-json-store.ts';
import type {
    RuntimeStateEntry,
    RuntimeStateEntryPageOptions,
    RuntimeStateRepositoryLike
} from '../../../runtime-state/runtime-state-repository.ts';
import { rtcTopologySemanticEqual } from '../persistence/rtc-topology-semantic-equal.ts';
import {
    hashRtcTopologyExecutionCommand,
    RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
    RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
    type RtcTopologyClaimedPublication,
    type RtcTopologyPublicationWorkClaim
} from './rtc-topology-publication-repository-contracts.ts';
import {
    assertTrustedSlot,
    childKey,
    compact,
    decodeChildKey,
    parseValue,
    publicationCorruption,
    validateWorkClaim
} from './rtc-topology-publication-repository-state.ts';
import type { RtcTopologyPublication } from './rtc-topology-publication.ts';
import { validateRtcTopologyPublication } from './validate-rtc-topology-publication.ts';

export class RtcTopologyPublicationRepository extends RuntimeStateJsonStore {
    readonly runtimeRepository: RuntimeStateRepositoryLike;

    constructor(runtimeRepository: RuntimeStateRepositoryLike) {
        super(runtimeRepository);
        this.runtimeRepository = runtimeRepository;
    }

    async findPublication(
        groupRef: GroupRef,
        publicationId: string
    ): Promise<RtcTopologyPublication | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            this.publicationKey(groupRef, publicationId)
        );
        if (!entry) {
            return undefined;
        }
        return (await this.toLivePublicationEntry(
            entry,
            groupRef,
            publicationId
        ))?.value;
    }

    async findPublicationForWork(
        groupRef: GroupRef,
        workId: string
    ): Promise<RtcTopologyPublication | undefined> {
        return (await this.findClaimedPublicationForWork(groupRef, workId))?.publication;
    }

    async findClaimedPublicationForWork(
        groupRef: GroupRef,
        workId: string
    ): Promise<RtcTopologyClaimedPublication | undefined> {
        const claim = await this.findWorkClaimEntry(groupRef, workId);
        if (!claim) {
            return undefined;
        }
        const publication = await this.findPublication(groupRef, claim.value.publicationId);
        if (!publication || publication.workId !== workId) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology work claim publication is missing or mismatched'
            );
        }
        if (
            !rtcTopologySemanticEqual(
                claim.value.acceptedCausalRevision,
                publication.sourceGroupStateCausalRevision
            ) || claim.value.outboxIds[0] !== publication.publicationId
        ) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology execution receipt effects differ from publication'
            );
        }
        const commandHash = await hashRtcTopologyExecutionCommand(publication);
        if (claim.value.commandHash !== commandHash) {
            throw publicationCorruption(
                claim.entry.key,
                'RTC topology execution receipt command hash differs from publication'
            );
        }
        return { claim, publication };
    }

    async findWorkClaimEntry(
        groupRef: GroupRef,
        workId: string
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim> | undefined> {
        const entry = await this.runtimeRepository.findEntry(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            this.workIndexKey(groupRef, workId)
        );
        if (!entry) {
            return undefined;
        }
        return await this.toLiveWorkClaimEntry(entry, groupRef, workId);
    }

    async listPublicationEntries(): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublication>[]> {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE
        );
        return compact(await Promise.all(entries.map((entry) => this.toLivePublicationEntry(entry))));
    }

    async listPublicationEntriesPage(
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublication>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            '',
            options
        );
        return compact(await Promise.all(entries.map((entry) => this.toLivePublicationEntry(entry))));
    }

    async listWorkClaimEntries(): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]> {
        const entries = await this.runtimeRepository.findAllEntries(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE
        );
        return compact(await Promise.all(entries.map((entry) => this.toLiveWorkClaimEntry(entry))));
    }

    async listWorkClaimEntriesPage(
        options: RuntimeStateEntryPageOptions
    ): Promise<readonly RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim>[]> {
        const entries = await this.listEntriesPage(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            '',
            options
        );
        return compact(await Promise.all(entries.map((entry) => this.toLiveWorkClaimEntry(entry))));
    }

    publicationKey(groupRef: GroupRef, publicationId: string): string {
        return childKey(groupRef, 'publication', publicationId);
    }

    workIndexKey(groupRef: GroupRef, workId: string): string {
        return childKey(groupRef, 'work', workId);
    }

    private async toLivePublicationEntry(
        entry: RuntimeStateEntry,
        trustedRef?: GroupRef,
        trustedPublicationId?: string
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublication> | undefined> {
        const decoded = decodeChildKey(entry.key, 'publication');
        assertTrustedSlot({
            decoded,
            trustedRef,
            trustedValue: trustedPublicationId,
            storageKey: entry.key
        });
        const value = parseValue(entry);
        try {
            validateRtcTopologyPublication(value, decoded.groupRef);
        }
        catch (error) {
            throw publicationCorruption(
                entry.key,
                error instanceof Error ? error.message : 'publication value is invalid'
            );
        }
        if (value.publicationId !== decoded.value) {
            throw publicationCorruption(entry.key, 'publication value differs from key');
        }
        const live = await this.toLiveJsonEntryValue(
            RTC_TOPOLOGY_PUBLICATIONS_NAMESPACE,
            entry
        );
        return live ? { entry: live.entry, value } : undefined;
    }

    private async toLiveWorkClaimEntry(
        entry: RuntimeStateEntry,
        trustedRef?: GroupRef,
        trustedWorkId?: string
    ): Promise<RuntimeStateEntryValue<RtcTopologyPublicationWorkClaim> | undefined> {
        const decoded = decodeChildKey(entry.key, 'work');
        assertTrustedSlot({
            decoded,
            trustedRef,
            trustedValue: trustedWorkId,
            storageKey: entry.key
        });
        const value = parseValue(entry);
        try {
            validateWorkClaim(value, decoded.groupRef);
        }
        catch (error) {
            throw publicationCorruption(
                entry.key,
                error instanceof Error ? error.message : 'work claim is invalid'
            );
        }
        if (value.workId !== decoded.value) {
            throw publicationCorruption(entry.key, 'work claim differs from key');
        }
        const live = await this.toLiveJsonEntryValue(
            RTC_TOPOLOGY_PUBLICATION_WORK_INDEX_NAMESPACE,
            entry
        );
        return live ? { entry: live.entry, value } : undefined;
    }
}
