import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import { AppOutboxType } from '../../../app-outbox/app-outbox-type.ts';
import type { RallarTimingSink } from '../../../observability/timing.ts';
import type { RtcRttRefinementService } from '../../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import type { RtcTopologyMutationRead } from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import { computeRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryRuntime } from '../delivery/rtc-topology-delivery-runtime.ts';
import {
    computeRtcTopologyReplayWrite,
    computeRtcTopologyWorkWrite,
    validateRtcTopologyReplayWrite,
    validateRtcTopologyWorkWrite,
    type AcceptedRtcTopologyMutation,
    type AcceptedRtcTopologyWork,
    type AcceptedRtcTopologyWorkWrite,
    type CommittedCriterionPetition,
    type ComputeRtcTopologyWorkWriteInput,
    type RtcTopologyReplayRead
} from './compute-rtc-topology-work-write.ts';
import {
    computeRtcTopologyWork,
    validateRtcTopologyWork,
    type ComputeRtcTopologyWorkInput,
    type RtcTopologyWorkFacts
} from './compute-rtc-topology-work.ts';
import type { GroupFormationAutomationPort } from './create-group-connect-trigger-work-handler.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId,
    toRtcTopologyWorkGroupRef
} from './rtc-topology-work-codec.ts';
import {
    computeRtcTopologyReservationFinish,
    writeRtcTopologyWorkCompletion
} from './rtc-topology-work-completion.ts';
import { recordRtcTopologyWorkTiming } from './rtc-topology-work-timing.ts';
import {
    readTopologyPromotion,
    type TopologyPromotionPublicationPort
} from './topology-promotion-request.ts';
import {
    writeRtcTopologyPublicationTransaction,
    type RtcTopologyPublicationTransactionWrite
} from './write-rtc-topology-publication-transaction.ts';

import {
    createDeferredCriterionPetitioner,
    petitionFormationCriterion,
    petitionGroupStageTrigger,
    type DeferredCriterionPetitioner,
    type FormationCriterionPort
} from './formation-criterion-observer.ts';
import {
    petitionGroupActivationStatus,
    type GroupActivationStatusPort
} from './group-activation-status-observer.ts';

interface RtcTopologyWorkHandlerOptions {
    readonly nowEpochMs: () => number;
    /** How long past the attempt a row the work derives lives at least (`appInbox.finishedRetentionMs`). */
    readonly finishedRetentionMs: number;
    readonly outboxQueueReader: OutboxQueueReader;
    readonly database: PSqlSql;
    readonly topologyPlanning: Pick<
        GroupTopologyPlanningService,
        | 'readTopologyPlanningAuthority'
        | 'readTopologyPlanningAuthorityIfPresent'
        | 'readDurationNowMs'
        | 'observeCommittedTopology'
        | 'recordTopologyPlanningObservation'
        | 'recordTopologyPublication'
        | 'recordTopologyPlanFrozen'
        | 'recordTopologyRebuildSkippedFingerprint'
    >;
    readonly executionRepository: RtcTopologyExecutionRepository;
    readonly rttRefinementService?: RtcRttRefinementService;
    /**
     * The evidence leg of the activation criterion. Absent means this deployment
     * does not automate formation; groups then activate only by operator command.
     */
    readonly formationCriterion?: FormationCriterionPort;
    readonly activationStatus?: GroupActivationStatusPort;
    readonly formationAutomation?: GroupFormationAutomationPort;
    readonly topologyPublication?: TopologyPromotionPublicationPort;
    readonly topologyDelivery?: RtcTopologyDeliveryRuntime;
    readonly onInactiveOverlay?: (overlayId: string) => void;
    readonly wakeQueue?: () => void;
    readonly wakeReplay?: () => void;
    readonly serviceId?: string;
    /** Present only while timing is on; absent, no recompute decision line is built or recorded. */
    readonly timing?: RallarTimingSink;
}

interface RtcTopologyWorkAttemptInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly facts: RtcTopologyWorkFacts;
    readonly mutationRead: RtcTopologyMutationRead;
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
    const nowEpochMs = options.nowEpochMs();
    const reservationFinish = computeRtcTopologyReservationFinish(entry, new Date(nowEpochMs));
    const workEnvelope = readRtcTopologyWorkEnvelope(
        message,
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
    );
    const workId = toRtcTopologyExecutionId(workEnvelope, message.id.ts);
    const mutationRead = await options.executionRepository.readTopologyMutation(
        toRtcTopologyWorkGroupRef(workEnvelope.data),
        workId
    );
    if (mutationRead.publicationClaim) {
        const replayRead = await readLoadedRtcTopologyWork(options, mutationRead);
        await processLoadedRtcTopologyWork(options, replayRead, reservationFinish);
        return;
    }
    const facts = toRtcTopologyWorkFacts({ options, message, entry, workEnvelope, workId, nowEpochMs });
    const attempt = { options, facts, mutationRead };
    const accepted = claimRttRefinementSkip(attempt);
    if (accepted !== null) {
        await writeSkippedRttRefinement({ options, entry, facts, reservationFinish, accepted });
        await deferredCriterionPetitioner?.request(accepted.work, mutationRead, facts.traceId);
        return;
    }
    const computationInput = await readRtcTopologyWorkComputationInput({
        ...attempt,
        entry,
        reservationFinish
    });
    if (computationInput === null) {
        // The group is gone: there is no layout to plan or remove, so the row is settled work (D290).
        await writeRtcTopologyWorkCompletion(options.database, reservationFinish);
        return;
    }
    const computeStartedAtMs = options.topologyPlanning.readDurationNowMs();
    const computation = computeRtcTopologyWork(computationInput);
    const issues = validateRtcTopologyWork(computationInput, computation);
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
    if (computation.right === undefined) {
        throw Object.assign(new RuntimeStateWriteConflictError(), { cause: computation.left });
    }
    const computed = computation.right;
    await writeAcceptedRtcTopologyWork({
        options,
        accepted: computed.accepted,
        computedWrite: computed.write,
        computeDurationMs: options.topologyPlanning.readDurationNowMs() - computeStartedAtMs,
        traceId: facts.traceId
    });
}

interface ToRtcTopologyWorkFactsInput {
    readonly options: Pick<RtcTopologyWorkHandlerOptions, 'finishedRetentionMs'>;
    readonly message: ALMessage;
    readonly entry: ResourceEntry;
    readonly workEnvelope: RtcTopologyWorkFacts['workEnvelope'];
    readonly workId: string;
    readonly nowEpochMs: number;
}

function toRtcTopologyWorkFacts(input: ToRtcTopologyWorkFactsInput): RtcTopologyWorkFacts {
    const { options, message, entry } = input;
    return {
        workEnvelope: input.workEnvelope,
        workId: input.workId,
        attemptCount: entry.dequeueAudit.attempts,
        derivedExpireAtEpochMs: Math.max(
            entry.audit.expiryTs.epochMilliseconds,
            input.nowEpochMs + options.finishedRetentionMs
        ),
        traceId: message.id.traceId
    };
}

interface ReadRtcTopologyWorkComputationInput extends RtcTopologyWorkAttemptInput {
    readonly entry: ResourceEntry;
    readonly reservationFinish: ResourceInboxReservationFinish;
}

/** Null when the group the work names no longer exists, so there is nothing to compute. */
async function readRtcTopologyWorkComputationInput(
    input: ReadRtcTopologyWorkComputationInput
): Promise<ComputeRtcTopologyWorkInput | null> {
    const { options, facts, mutationRead, entry, reservationFinish } = input;
    const { workEnvelope } = facts;
    const work = workEnvelope.data;
    const groupRef = toRtcTopologyWorkGroupRef(work);
    const [authority, promotionRead, storedInputFingerprint] = await Promise.all([
        // A membership change plans from the group's current stored state, which is at or past
        // the revision that asked (D290); an RTT refresh still carries the snapshot it measured.
        options.topologyPlanning.readTopologyPlanningAuthorityIfPresent({
            groupRef,
            requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
            ...(work.kind === 'rtt-refresh' ? { knownGroup: work.groupSnapshot } : {})
        }),
        readTopologyPromotion({
            publication: options.topologyPublication,
            groupRef
        }),
        options.executionRepository.readTopologyInputFingerprint(groupRef)
    ]);
    if (authority === null) {
        return null;
    }
    return {
        facts,
        read: { mutation: mutationRead, authority, promotion: promotionRead, storedInputFingerprint },
        publicationExpireAtTimestamp: facts.workEnvelope.data.publish
            ? options.executionRepository.publicationExpireAtTimestamp()
            : null,
        entry,
        reservationFinish,
        formationAutomationEnabled: options.formationAutomation !== undefined,
        serviceId: options.serviceId,
        publisherStreamId: options.topologyDelivery?.publisherStreamId
    };
}

interface WriteSkippedRttRefinementInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly facts: RtcTopologyWorkFacts;
    readonly entry: ResourceEntry;
    readonly reservationFinish: ResourceInboxReservationFinish;
    readonly accepted: AcceptedRtcTopologyWork;
}

async function writeSkippedRttRefinement(input: WriteSkippedRttRefinementInput): Promise<void> {
    const { options, entry, facts, reservationFinish, accepted } = input;
    const writeInput: ComputeRtcTopologyWorkWriteInput = {
        accepted,
        entry,
        sourceWorkId: facts.workId,
        derivedExpireAtEpochMs: facts.derivedExpireAtEpochMs,
        reservationFinish,
        formationAutomationEnabled: options.formationAutomation !== undefined,
        serviceId: options.serviceId,
        publisherStreamId: options.topologyDelivery?.publisherStreamId,
        traceId: facts.traceId
    };
    const computedWrite = computeRtcTopologyWorkWrite(writeInput);
    const issues = validateRtcTopologyWorkWrite(writeInput, computedWrite);
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
    await writeAcceptedRtcTopologyWork({
        options,
        accepted,
        computedWrite,
        computeDurationMs: 0,
        traceId: facts.traceId
    });
}

async function processLoadedRtcTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    read: RtcTopologyReplayRead,
    reservationFinish: ResourceInboxReservationFinish
): Promise<void> {
    const replayInput = {
        read,
        reservationFinish,
        publisherStreamId: options.topologyDelivery?.publisherStreamId
    };
    const computed = computeRtcTopologyReplayWrite(replayInput);
    const issues = validateRtcTopologyReplayWrite(replayInput, computed);
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: undefined
    }, computed.transaction);
    options.topologyPlanning.recordTopologyPublication(true);
    options.wakeQueue?.();
    options.wakeReplay?.();
}

async function readLoadedRtcTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    mutation: RtcTopologyMutationRead
): Promise<RtcTopologyReplayRead> {
    const publication = mutation.publicationClaim?.publication;
    if (!publication) {
        throw new TypeError('RTC topology loaded replay requires its durable publication');
    }
    const outboxPages = computeRtcTopologyPublicationOutbox(publication);
    const [outbox, delivery] = await Promise.all([
        Promise.all(outboxPages.map((page) => options.outboxQueueReader.outbox.getItem(page.key))),
        options.topologyDelivery
            ? options.topologyDelivery.reader.findPublicationDelivery({
                groupRef: publication.groupRef,
                publicationId: publication.publicationId
            })
            : Promise.resolve(undefined)
    ]);
    return {
        mutation,
        outbox,
        delivery: delivery ?? null
    };
}

/**
 * The RTT-refinement claim gate defers the replan, never the activation
 * decision: the measurement that carries a connecting group across its
 * threshold must still petition the criterion, or activation waits for the
 * next deadline evaluation. A removed stored plan never petitions — its
 * empty edge set would read as trivially-complete readiness.
 */
function claimRttRefinementSkip(
    input: RtcTopologyWorkAttemptInput
): Extract<AcceptedRtcTopologyWork, { decision: 'skipped-rtt-refinement'; }> | null {
    const work = input.facts.workEnvelope.data;
    if (
        work.kind !== 'rtt-refresh' ||
        !input.options.rttRefinementService ||
        input.options.rttRefinementService.claimWork({
            observationId: work.refinementObservationId,
            workId: input.facts.workId,
            groupKey: toWebRtcGroupKey(work.groupSnapshot.group),
            rtt: work.rtt,
            expireAtEpochMs: input.facts.derivedExpireAtEpochMs
        })
    ) {
        return null;
    }
    return {
        decision: 'skipped-rtt-refinement',
        work,
        group: work.groupSnapshot
    };
}

interface WriteAcceptedRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: AcceptedRtcTopologyWork;
    readonly computedWrite: AcceptedRtcTopologyWorkWrite;
    readonly computeDurationMs: number;
    /** The work row's trace: every petition the committed decision makes submits under it. */
    readonly traceId: string;
}

async function writeAcceptedRtcTopologyWork(
    input: WriteAcceptedRtcTopologyWorkInput
): Promise<void> {
    await writeRtcTopologyWorkDecision(input);
    recordRtcTopologyWorkTiming({
        timing: input.options.timing,
        serviceId: input.options.serviceId,
        accepted: input.accepted,
        computeDurationMs: input.computeDurationMs,
        traceId: input.traceId
    });
}

async function writeRtcTopologyWorkDecision(
    input: WriteAcceptedRtcTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite, computeDurationMs, traceId } = input;
    if (accepted.decision === 'skipped-rtt-refinement') {
        await writeCompletionOnly(options.database, computedWrite);
        return;
    }
    if (accepted.decision === 'skipped-fingerprint') {
        await writeCompletionOnly(options.database, computedWrite);
        options.topologyPlanning.recordTopologyRebuildSkippedFingerprint();
        // Topology inputs exclude lifecycle: entering a dialing stage can
        // activate against this stored layout without a rebuild/publication.
        await petitionCommittedCriterion(options, accepted.criterionPetition, traceId);
        return;
    }
    if (
        accepted.decision === 'skipped-unchanged' || accepted.decision === 'skipped-frozen' ||
        accepted.decision === 'held-young-layout'
    ) {
        await writeSkippedTopologyWork({ options, accepted, computedWrite, computeDurationMs, traceId });
        return;
    }
    const computed = accepted.computed;
    if (computed.outcome === 'superseded') {
        await writeCompletionOnly(options.database, computedWrite);
        recordCommittedPlanningObservation(options, accepted, computeDurationMs);
        options.topologyPlanning.observeCommittedTopology(accepted.group, computed.current);
        // The winning cycle publishes, but it petitions from its own
        // revision: this one still carries presence evidence the winner may
        // not have seen, and the trigger fences that evidence itself.
        if (accepted.criterionPetition !== null) {
            await petitionGroupStageTrigger(options, accepted.criterionPetition.authority, traceId);
        }
        return;
    }
    const transaction = requireTopologyTransactionWrite(computedWrite);
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: options.topologyDelivery?.append
    }, transaction);
    recordCommittedPlanningObservation(options, accepted, computeDurationMs);
    await finishCommittedTopologyWork({ options, accepted, computed, traceId });
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
 * Every decision that keeps the stored layout commits one already validated
 * transaction write. Only the unchanged decision refreshes the input
 * fingerprint. The frozen path must NOT write it: the stale fingerprint is
 * the latched signal that the stored layout trails the authority. The held
 * path writes none because nothing changed: a hold requires the stored
 * fingerprint to equal the authority's already.
 */
interface WriteSkippedTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: Extract<
        AcceptedRtcTopologyWork,
        { decision: 'skipped-unchanged' | 'skipped-frozen' | 'held-young-layout'; }
    >;
    readonly computedWrite: AcceptedRtcTopologyWorkWrite;
    readonly computeDurationMs: number;
    readonly traceId: string;
}

async function writeSkippedTopologyWork(
    input: WriteSkippedTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite, computeDurationMs, traceId } = input;
    const transaction = requireTopologyTransactionWrite(computedWrite);
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: undefined
    }, transaction);
    if (accepted.decision === 'skipped-frozen') {
        options.topologyPlanning.recordTopologyPlanFrozen();
    }
    else if (accepted.decision === 'skipped-unchanged') {
        recordCommittedPlanningObservation(options, accepted, computeDurationMs);
        options.topologyPlanning.recordTopologyPublication(false);
    }
    await petitionCommittedCriterion(options, accepted.criterionPetition, traceId);
}

interface FinishCommittedTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: Extract<AcceptedRtcTopologyWork, { decision: 'accepted'; }>;
    readonly computed: Exclude<AcceptedRtcTopologyMutation, Readonly<{ outcome: 'superseded'; }>>;
    readonly traceId: string;
}

async function finishCommittedTopologyWork(
    { options, accepted, computed, traceId }: FinishCommittedTopologyWorkInput
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
        }, traceId);
    }
    if (accepted.publication) {
        options.topologyPlanning.recordTopologyPublication(true);
        options.wakeQueue?.();
        options.wakeReplay?.();
    }
}

function recordCommittedPlanningObservation(
    options: RtcTopologyWorkHandlerOptions,
    accepted: Extract<AcceptedRtcTopologyWork, { decision: 'accepted' | 'skipped-unchanged'; }>,
    computeDurationMs: number
): void {
    if (accepted.planningObservation !== null) {
        options.topologyPlanning.recordTopologyPlanningObservation(
            accepted.planningObservation,
            computeDurationMs
        );
    }
}

async function petitionCommittedCriterion(
    options: RtcTopologyWorkHandlerOptions,
    petition: CommittedCriterionPetition | null,
    traceId: string
): Promise<void> {
    if (petition === null) {
        return;
    }
    await petitionFormationCriterion(options, petition, traceId);
    await petitionGroupStageTrigger(options, petition.authority, traceId);
    // The criterion leg returns early outside establishment; the status leg
    // does not, because coverage is exactly what an `active` group reports.
    await petitionGroupActivationStatus({
        dependencies: options,
        authority: petition.authority,
        planned: petition.planned,
        dwell: null,
        traceId
    });
}
