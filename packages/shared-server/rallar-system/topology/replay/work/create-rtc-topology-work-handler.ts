import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { hashRtcTopologyExecutionCommand } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { type RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingSink } from '../../../observability/timing.ts';
import type { RtcRttRefinementService } from '../../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationComputed,
    type RtcTopologyMutationInput,
    type RtcTopologyMutationRead
} from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyWorkRuntime } from '../../mutation/rtc-topology-outbox-work.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { ReconcileGroupTopologyResult } from '../../planning/group-topology-planning-contracts.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import {
    materializeRtcOverlayTopologyBroadcastMessage,
    type RtcOverlayTopologyMessageFacts
} from '../../planning/materialize-rtc-overlay-topology-broadcast-message.ts';
import {
    computeRtcTopologyWorkWrite,
    validateRtcTopologyWorkWrite,
    type AcceptedRtcTopologyMutation,
    type AcceptedRtcTopologyWork,
    type AcceptedRtcTopologyWorkWrite,
    type CommittedCriterionPetition,
    type ComputeRtcTopologyWorkWriteInput
} from './compute-rtc-topology-work-write.ts';
import type { GroupFormationAutomationPort } from './create-group-connect-trigger-work-handler.ts';
import { isChangeGatedGroupRevisionWork, toTopologyWorkOrigin } from './rtc-topology-coalesced-group-revision-work.ts';
import {
    computeAuthorityTopologyInputFingerprint
} from './rtc-topology-input-fingerprint.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId,
    type PersistedRtcTopologyWork,
    type RtcTopologyWorkEnvelope
} from './rtc-topology-work-codec.ts';
import {
    computeRtcTopologyReservationFinish,
    writeRtcTopologyWorkCompletion
} from './rtc-topology-work-completion.ts';
import {
    readTopologyPromotion,
    type TopologyPromotionPublicationPort,
    type TopologyPromotionRead
} from './topology-promotion-request.ts';
import {
    computeRtcTopologyPublicationDeliveryWrite,
    writeRtcTopologyPublicationTransaction,
    type RtcTopologyDeliveryOptions,
    type RtcTopologyPublicationTransactionWrite
} from './write-rtc-topology-publication-transaction.ts';

import {
    createDeferredCriterionPetitioner,
    petitionFormationCriterion,
    type DeferredCriterionPetitioner,
    type FormationCriterionPort
} from './formation-criterion-observer.ts';

interface RtcTopologyWorkHandlerOptions {
    readonly runtime: RtcTopologyWorkRuntime;
    readonly database: PSqlSql;
    readonly topologyPlanning: Pick<
        GroupTopologyPlanningService,
        | 'readTopologyPlanningAuthority'
        | 'computeTopologyFromAuthority'
        | 'observeCommittedTopology'
        | 'recordTopologyPublication'
        | 'recordTopologyPlanFrozen'
        | 'recordTopologyRebuildSkippedFingerprint'
    >;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly rttRefinementService?: RtcRttRefinementService;
    /**
     * The evidence leg of the activation criterion (plan slice 3b). Absent means
     * this deployment does not automate formation; groups then activate only by
     * operator command.
     */
    readonly formationCriterion?: FormationCriterionPort;
    readonly formationAutomation?: GroupFormationAutomationPort;
    readonly topologyPublication?: TopologyPromotionPublicationPort;
    readonly topologyDelivery?: RtcTopologyDeliveryOptions;
    readonly onInactiveOverlay?: (overlayId: string) => void;
    readonly wakeQueue?: () => void;
    readonly wakeReplay?: () => void;
    readonly sleep?: (delayMs: number) => Promise<void>;
    readonly timing?: RallarTimingSink;
    readonly serviceId?: string;
}

interface PrepareRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly workId: string;
    readonly attemptCount: number;
    readonly read: RtcTopologyMutationRead;
    readonly expireAtEpochMs: number;
    readonly deferredCriterionPetitioner: DeferredCriterionPetitioner | null;
}

interface ToTopologyPublicationInput {
    readonly envelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly group: GroupSnapshot;
    readonly snapshot: Parameters<typeof materializeRtcOverlayTopologyBroadcastMessage>[1];
    readonly facts: RtcOverlayTopologyMessageFacts;
}

export function createRtcTopologyWorkHandler(
    options: RtcTopologyWorkHandlerOptions
): OnMessageCallback {
    const deferredCriterionPetitioner = createDeferredCriterionPetitioner(options);
    return {
        onMessage: async (message, entry) => {
            await processRtcTopologyWork({ options, message, entry, deferredCriterionPetitioner });
        }
    };
}

interface ProcessRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly deferredCriterionPetitioner: DeferredCriterionPetitioner | null;
}

async function processRtcTopologyWork(input: ProcessRtcTopologyWorkInput): Promise<void> {
    const { options, message, entry, deferredCriterionPetitioner } = input;
    const reservationFinish = computeRtcTopologyReservationFinish(entry, new Date());
    const workEnvelope = readRtcTopologyWorkEnvelope(message, options.runtime.workType);
    const workId = toRtcTopologyExecutionId(workEnvelope);
    const read = await options.executionRepository.readTopologyMutation(
        workEnvelope.data.groupSnapshot.group,
        workId
    );
    if (read.publicationClaim) {
        await processLoadedRtcTopologyWork(options, read, reservationFinish);
        return;
    }
    const accepted = await prepareRtcTopologyWork({
        options,
        workEnvelope,
        workId,
        attemptCount: entry.dequeueAudit.attempts,
        read,
        expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds,
        deferredCriterionPetitioner
    });
    const writeInput: ComputeRtcTopologyWorkWriteInput = {
        entry,
        accepted,
        reservationFinish,
        formationAutomationEnabled: options.formationAutomation !== undefined,
        serviceId: options.serviceId,
        publisherStreamId: options.topologyDelivery?.publisherStreamId
    };
    const computedWrite = computeRtcTopologyWorkWrite(writeInput);
    validateRtcTopologyWorkWrite(writeInput, computedWrite);
    await writeAcceptedRtcTopologyWork({ options, accepted, computedWrite });
}

async function processLoadedRtcTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    read: RtcTopologyMutationRead,
    reservationFinish: ResourceInboxReservationFinish
): Promise<void> {
    const replayInput = {
        read,
        candidate: null,
        publication: null,
        facts: {
            publicationExpireAtTimestamp: null,
            commandHash: null,
            attemptCount: null
        }
    } as const;
    const computed = computeTopologyMutation(replayInput);
    validateTopologyMutation({ ...replayInput, computed });
    if (computed.outcome !== 'loaded') {
        throw new RuntimeStateWriteConflictError();
    }
    const deliveryWrite = computeRtcTopologyPublicationDeliveryWrite(
        computed.publication,
        options.topologyDelivery?.publisherStreamId
    );
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: options.topologyDelivery?.append
    }, {
        mutation: null,
        promotionRequest: null,
        connectRequests: [],
        fingerprint: null,
        delivery: deliveryWrite,
        reservationFinish
    });
    options.topologyPlanning.recordTopologyPublication(true);
    options.wakeQueue?.();
    options.wakeReplay?.();
}

/**
 * The RTT-refinement claim gate defers the replan, never the activation
 * decision: the measurement that carries a connecting group across its
 * threshold must still petition the criterion, or activation waits for the
 * next deadline evaluation. A removed stored plan never petitions — its
 * empty edge set would read as trivially-complete readiness.
 */
async function processRttRefinementGate(
    input: PrepareRtcTopologyWorkInput
): Promise<AcceptedRtcTopologyWork | null> {
    const work = input.workEnvelope.data;
    if (
        work.kind !== 'rtt-refresh' ||
        !input.options.rttRefinementService ||
        input.options.rttRefinementService.claimWork({
            observationId: work.refinementObservationId,
            workId: input.workId,
            groupKey: toWebRtcGroupKey(work.groupSnapshot.group),
            rtt: work.rtt,
            expireAtEpochMs: input.expireAtEpochMs
        })
    ) {
        return null;
    }
    await input.deferredCriterionPetitioner?.request(work, input.read);
    return {
        decision: 'skipped-rtt-refinement',
        work,
        group: work.groupSnapshot
    };
}

async function prepareRtcTopologyWork(
    input: PrepareRtcTopologyWorkInput
): Promise<AcceptedRtcTopologyWork> {
    const { options, workEnvelope, read } = input;
    const work = workEnvelope.data;
    const rttRefinementSkip = await processRttRefinementGate(input);
    if (rttRefinementSkip !== null) {
        return rttRefinementSkip;
    }
    const membershipDeltaWork = work.kind === 'group-revision';
    const [authority, promotionRead, storedInputFingerprint] = await Promise.all([
        options.topologyPlanning.readTopologyPlanningAuthority({
            groupRef: work.groupSnapshot.group,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
            knownGroup: work.groupSnapshot,
            snapshotSelection: membershipDeltaWork ? 'preserve-known-revision' : 'prefer-current'
        }),
        readTopologyPromotion({
            publication: options.topologyPublication,
            groupRef: work.groupSnapshot.group
        }),
        options.executionRepository.readTopologyInputFingerprint(
            work.groupSnapshot.group
        )
    ]);
    const inputFingerprint = await computeAuthorityTopologyInputFingerprint(authority);
    const fingerprintSkip = computeFingerprintSkip({
        input,
        authority,
        inputFingerprint,
        promotionRead,
        storedInputFingerprint
    });
    if (fingerprintSkip !== null) {
        return fingerprintSkip;
    }
    const computedTopology = options.topologyPlanning.computeTopologyFromAuthority(
        authority,
        read.snapshot?.value,
        {
            intent: membershipDeltaWork ? 'membership-delta' : 'full-rebuild',
            origin: toTopologyWorkOrigin(work)
        }
    );
    if (computedTopology.action === 'frozen') {
        // The union's own payload is the row the freeze decision named.
        return {
            decision: 'skipped-frozen',
            work,
            group: authority.group,
            promotionRead,
            criterionPetition: { authority, planned: computedTopology.current }
        };
    }
    // RTT is deliberately outside the fingerprint, so an RTT refresh always
    // replans — but an unchanged planned graph publishes nothing (M8). The
    // criterion petition fences on the stored row, not the recomputed
    // candidate: an unchanged graph still drifts its causal revision, and a
    // candidate-identity fence would reject the decisive activation.
    const unchangedGated = isChangeGatedGroupRevisionWork(work) || work.kind !== 'group-revision';
    if (unchangedGated && read.snapshot !== null && !computedTopology.changed) {
        return {
            decision: 'skipped-unchanged',
            work,
            group: authority.group,
            inputFingerprint,
            promotionRead,
            criterionPetition: { authority, planned: read.snapshot.value }
        };
    }
    return await prepareTopologyMutation({
        base: input,
        authority,
        planned: computedTopology,
        inputFingerprint,
        promotionRead
    });
}

interface ComputeFingerprintSkipInput {
    readonly input: PrepareRtcTopologyWorkInput;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly inputFingerprint: string;
    readonly promotionRead: TopologyPromotionRead | null;
    readonly storedInputFingerprint: string | null;
}

function computeFingerprintSkip(
    input: ComputeFingerprintSkipInput
): Extract<AcceptedRtcTopologyWork, { decision: 'skipped-fingerprint'; }> | null {
    const {
        input: preparation,
        authority,
        inputFingerprint,
        promotionRead,
        storedInputFingerprint
    } = input;
    const work = preparation.workEnvelope.data;
    const snapshot = preparation.read.snapshot;
    if (!isChangeGatedGroupRevisionWork(work) || snapshot?.value.state !== 'active') {
        return null;
    }
    return storedInputFingerprint === inputFingerprint
        ? {
            decision: 'skipped-fingerprint',
            work,
            group: authority.group,
            promotionRead,
            criterionPetition: { authority, planned: snapshot.value }
        }
        : null;
}

interface PrepareTopologyMutationInput {
    readonly base: PrepareRtcTopologyWorkInput;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: Extract<ReconcileGroupTopologyResult, { action: 'planned'; }>;
    readonly inputFingerprint: string;
    readonly promotionRead: TopologyPromotionRead | null;
}

async function prepareTopologyMutation(
    input: PrepareTopologyMutationInput
): Promise<AcceptedRtcTopologyWork> {
    const { authority, planned, inputFingerprint, promotionRead } = input;
    const { options, workEnvelope, workId, attemptCount, read } = input.base;
    const work = workEnvelope.data;
    const publicationExpireAtTimestamp = work.publish
        ? options.executionRepository.publicationExpireAtTimestamp()
        : null;
    const publication = publicationExpireAtTimestamp === null
        ? null
        : toTopologyPublication({
            envelope: workEnvelope,
            group: authority.group,
            snapshot: planned.snapshot,
            facts: {
                workId,
                createdAtEpochMs: work.requestedAtEpochMs,
                expiresAtEpochMs: publicationExpireAtTimestamp
            }
        });
    const facts = publication && publicationExpireAtTimestamp !== null
        ? {
            publicationExpireAtTimestamp,
            commandHash: await hashRtcTopologyExecutionCommand(publication),
            attemptCount
        }
        : ({
            publicationExpireAtTimestamp: null,
            commandHash: null,
            attemptCount: null
        } as const);
    const mutationInput: RtcTopologyMutationInput = {
        read,
        candidate: planned.snapshot,
        publication,
        facts
    };
    const computed = computeTopologyMutation(mutationInput);
    if (computed.outcome === 'retry') {
        throw new RuntimeStateWriteConflictError();
    }
    if (computed.outcome === 'loaded') {
        throw new TypeError('RTC topology publication claim appeared on a claim-miss path');
    }
    return {
        decision: 'accepted',
        work,
        group: authority.group,
        computed,
        mutationInput,
        publication,
        inputFingerprint,
        promotionRead,
        criterionPetition: { authority, planned: planned.snapshot }
    };
}

interface WriteAcceptedRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: AcceptedRtcTopologyWork;
    readonly computedWrite: AcceptedRtcTopologyWorkWrite;
}

async function writeAcceptedRtcTopologyWork(
    input: WriteAcceptedRtcTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite } = input;
    if (accepted.decision === 'skipped-rtt-refinement') {
        await writeCompletionOnly(options.database, computedWrite);
        return;
    }
    if (accepted.decision === 'skipped-fingerprint') {
        await writeCompletionOnly(options.database, computedWrite);
        options.topologyPlanning.recordTopologyRebuildSkippedFingerprint();
        // Topology inputs exclude lifecycle: entering a dialing stage can
        // activate against this stored layout without a rebuild/publication.
        await petitionCommittedCriterion(options, accepted.criterionPetition);
        return;
    }
    if (accepted.decision === 'skipped-unchanged' || accepted.decision === 'skipped-frozen') {
        await writeSkippedTopologyWork({ options, accepted, computedWrite });
        return;
    }
    const computed = accepted.computed;
    if (computed.outcome === 'superseded') {
        await writeCompletionOnly(options.database, computedWrite);
        options.topologyPlanning.observeCommittedTopology(accepted.group, computed.current);
        return;
    }
    const transaction = requireTopologyTransactionWrite(computedWrite);
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: options.topologyDelivery?.append
    }, transaction);
    await finishCommittedTopologyWork(options, accepted, computed);
}

async function writeCompletionOnly(
    database: PSqlSql,
    computed: AcceptedRtcTopologyWorkWrite
): Promise<void> {
    if (computed.kind !== 'completion-only') {
        throw new TypeError('RTC topology work expected a completion-only write');
    }
    await writeRtcTopologyWorkCompletion(database, computed.reservationFinish);
}

function requireTopologyTransactionWrite(
    computed: AcceptedRtcTopologyWorkWrite
): RtcTopologyPublicationTransactionWrite {
    if (computed.kind !== 'transaction') {
        throw new TypeError('RTC topology work expected a publication transaction');
    }
    return computed.transaction;
}

/**
 * Both skip decisions commit one already validated transaction write. Only
 * the unchanged decision refreshes the input fingerprint: the frozen path
 * must NOT write it, because the stale fingerprint is decision 11's latched
 * signal that the stored layout trails the authority.
 */
interface WriteSkippedTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: Extract<AcceptedRtcTopologyWork, { decision: 'skipped-unchanged' | 'skipped-frozen'; }>;
    readonly computedWrite: AcceptedRtcTopologyWorkWrite;
}

async function writeSkippedTopologyWork(
    input: WriteSkippedTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite } = input;
    const transaction = requireTopologyTransactionWrite(computedWrite);
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: undefined
    }, transaction);
    if (accepted.decision === 'skipped-frozen') {
        options.topologyPlanning.recordTopologyPlanFrozen();
    }
    else {
        options.topologyPlanning.recordTopologyPublication(false);
    }
    await petitionCommittedCriterion(options, accepted.criterionPetition);
}

async function finishCommittedTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    accepted: Extract<AcceptedRtcTopologyWork, { decision: 'accepted'; }>,
    computed: Exclude<AcceptedRtcTopologyMutation, Readonly<{ outcome: 'superseded'; }>>
): Promise<void> {
    const committedSnapshot = computed.outcome === 'write'
        ? computed.snapshotGuard.candidate
        : computed.currentGuard.current;
    options.topologyPlanning.observeCommittedTopology(accepted.group, committedSnapshot);
    if (committedSnapshot.state === 'removed') {
        options.onInactiveOverlay?.(accepted.work.overlayId);
    }
    if (accepted.criterionPetition !== null) {
        // Petition with the row the commit made durable, never the candidate
        // the compute phase happened to build.
        await petitionCommittedCriterion(options, {
            authority: accepted.criterionPetition.authority,
            planned: committedSnapshot
        });
    }
    if (accepted.publication) {
        options.topologyPlanning.recordTopologyPublication(true);
        options.wakeQueue?.();
        options.wakeReplay?.();
    }
}

async function petitionCommittedCriterion(
    options: RtcTopologyWorkHandlerOptions,
    petition: CommittedCriterionPetition | null
): Promise<void> {
    if (petition === null) {
        return;
    }
    await petitionFormationCriterion(options, petition.authority, petition.planned);
}

function toTopologyPublication(input: ToTopologyPublicationInput): RtcTopologyPublication {
    const { envelope, group, snapshot, facts } = input;
    const workId = toRtcTopologyExecutionId(envelope);
    return {
        publicationId: toRtcTopologyPublicationId({
            workId,
            sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
            overlayVersion: snapshot.version
        }),
        workId,
        groupRef: canonicalGroupRef(group.group),
        sourceGroupStateCausalRevision: snapshot.sourceGroupStateCausalRevision,
        overlayVersion: snapshot.version,
        targetGroupSnapshotVersion: group.group.snapshotVersion,
        recipientSessionIds: snapshot.activeSessionIds,
        message: materializeRtcOverlayTopologyBroadcastMessage(group, snapshot, facts),
        createdAtEpochMs: facts.createdAtEpochMs
    };
}

function canonicalGroupRef(ref: GroupRef): GroupRef {
    return {
        applicationId: ref.applicationId,
        workspaceId: ref.workspaceId,
        groupId: ref.groupId
    };
}
