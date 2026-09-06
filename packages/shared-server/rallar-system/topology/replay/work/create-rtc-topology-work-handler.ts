import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OutboxQueueReader } from '@shared/services/outbox-queue-reader.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';

import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import type { ResourceInboxReservationFinish } from '../../../../queuebox/postgres/resource-inbox-reservation-write.ts';
import { AppOutboxType } from '../../../app-outbox/app-outbox-type.ts';
import type { RtcRttRefinementService } from '../../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import type { RtcTopologyMutationComputed, RtcTopologyMutationRead } from '../../mutation/rtc-topology-mutations.ts';
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
    type RtcTopologyWorkFacts,
    type RtcTopologyWorkRead
} from './compute-rtc-topology-work.ts';
import type { GroupFormationAutomationPort } from './create-group-connect-trigger-work-handler.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId
} from './rtc-topology-work-codec.ts';
import {
    computeRtcTopologyReservationFinish,
    writeRtcTopologyWorkCompletion
} from './rtc-topology-work-completion.ts';
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
    readonly outboxQueueReader: OutboxQueueReader;
    readonly database: PSqlSql;
    readonly topologyPlanning: Pick<
        GroupTopologyPlanningService,
        | 'readTopologyPlanningAuthority'
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
    const reservationFinish = computeRtcTopologyReservationFinish(entry, new Date());
    const workEnvelope = readRtcTopologyWorkEnvelope(
        message,
        AppOutboxType.RTC_TOPOLOGY_RECOMPUTE
    );
    const workId = toRtcTopologyExecutionId(workEnvelope);
    const mutationRead = await options.executionRepository.readTopologyMutation(
        workEnvelope.data.groupSnapshot.group,
        workId
    );
    if (mutationRead.publicationClaim) {
        const replayRead = await readLoadedRtcTopologyWork(options, mutationRead);
        await processLoadedRtcTopologyWork(options, replayRead, reservationFinish);
        return;
    }
    const facts: RtcTopologyWorkFacts = {
        workEnvelope,
        workId,
        attemptCount: entry.dequeueAudit.attempts,
        expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds
    };
    const attempt = {
        options,
        facts,
        mutationRead
    };
    const rttRefinementSkip = claimRttRefinementSkip(attempt);
    if (rttRefinementSkip !== null) {
        const writeInput: ComputeRtcTopologyWorkWriteInput = {
            accepted: rttRefinementSkip,
            entry,
            sourceWorkId: workId,
            reservationFinish,
            formationAutomationEnabled: options.formationAutomation !== undefined,
            serviceId: options.serviceId,
            publisherStreamId: options.topologyDelivery?.publisherStreamId
        };
        const computedWrite = computeRtcTopologyWorkWrite(writeInput);
        const issues = validateRtcTopologyWorkWrite(writeInput, computedWrite);
        if (issues[0] !== undefined) {
            throw issues[0].cause;
        }
        await writeAcceptedRtcTopologyWork({
            options,
            accepted: rttRefinementSkip,
            computedWrite,
            computeDurationMs: 0
        });
        await deferredCriterionPetitioner?.request(workEnvelope.data, mutationRead);
        return;
    }
    const computationInput: ComputeRtcTopologyWorkInput = {
        facts,
        read: await readRtcTopologyWork(attempt),
        publicationExpireAtTimestamp: workEnvelope.data.publish
            ? options.executionRepository.publicationExpireAtTimestamp()
            : null,
        entry,
        reservationFinish,
        formationAutomationEnabled: options.formationAutomation !== undefined,
        serviceId: options.serviceId,
        publisherStreamId: options.topologyDelivery?.publisherStreamId
    };
    const computeStartedAtMs = options.topologyPlanning.readDurationNowMs();
    const computed = await computeRtcTopologyWork(computationInput);
    const issues = await validateRtcTopologyWork(computationInput, computed);
    if (issues[0] !== undefined) {
        throw issues[0].cause;
    }
    await writeAcceptedRtcTopologyWork({
        options,
        accepted: computed.accepted,
        computedWrite: computed.write,
        computeDurationMs: options.topologyPlanning.readDurationNowMs() - computeStartedAtMs
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
    const outboxKey = computeRtcTopologyPublicationOutbox(publication).key;
    const [outbox, delivery] = await Promise.all([
        options.outboxQueueReader.outbox.getItem(outboxKey),
        options.topologyDelivery
            ? options.topologyDelivery.reader.findPublicationDelivery({
                groupRef: publication.groupRef,
                publicationId: publication.publicationId
            })
            : Promise.resolve(undefined)
    ]);
    return {
        mutation,
        outbox: outbox ?? null,
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
): AcceptedRtcTopologyWork | null {
    const work = input.facts.workEnvelope.data;
    if (
        work.kind !== 'rtt-refresh' ||
        !input.options.rttRefinementService ||
        input.options.rttRefinementService.claimWork({
            observationId: work.refinementObservationId,
            workId: input.facts.workId,
            groupKey: toWebRtcGroupKey(work.groupSnapshot.group),
            rtt: work.rtt,
            expireAtEpochMs: input.facts.expireAtEpochMs
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

async function readRtcTopologyWork(
    input: RtcTopologyWorkAttemptInput
): Promise<RtcTopologyWorkRead> {
    const { options, facts, mutationRead } = input;
    const { workEnvelope } = facts;
    const work = workEnvelope.data;
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
    return {
        mutation: mutationRead,
        authority,
        promotion: promotionRead,
        storedInputFingerprint
    };
}

interface WriteAcceptedRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly accepted: AcceptedRtcTopologyWork;
    readonly computedWrite: AcceptedRtcTopologyWorkWrite;
    readonly computeDurationMs: number;
}

async function writeAcceptedRtcTopologyWork(
    input: WriteAcceptedRtcTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite, computeDurationMs } = input;
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
        await writeSkippedTopologyWork({ options, accepted, computedWrite, computeDurationMs });
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
            await petitionGroupStageTrigger(options, accepted.criterionPetition.authority);
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
    readonly computeDurationMs: number;
}

async function writeSkippedTopologyWork(
    input: WriteSkippedTopologyWorkInput
): Promise<void> {
    const { options, accepted, computedWrite, computeDurationMs } = input;
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
        recordCommittedPlanningObservation(options, accepted, computeDurationMs);
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
    petition: CommittedCriterionPetition | null
): Promise<void> {
    if (petition === null) {
        return;
    }
    await petitionFormationCriterion(options, petition.authority, petition.planned);
    await petitionGroupStageTrigger(options, petition.authority);
    // The criterion leg returns early outside establishment; the status leg
    // does not, because coverage is exactly what an `active` group reports.
    await petitionGroupActivationStatus({
        dependencies: options,
        authority: petition.authority,
        planned: petition.planned,
        dwell: null
    });
}
