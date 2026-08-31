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
import { runInPSqlTransaction } from '../../../../postgres/run-in-p-sql-transaction.ts';
import { PSqlResourceInboxRepository } from '../../../../queuebox/postgres/create-p-sql-resource-inbox-repository.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingSink } from '../../../observability/timing.ts';
import type { RtcRttRefinementService } from '../../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationComputed
} from '../../mutation/rtc-topology-mutations.ts';
import type { RtcTopologyWorkRuntime } from '../../mutation/rtc-topology-outbox-work.ts';
import type { RtcTopologyExecutionRepository } from '../../persistence/rtc-topology-execution-repository.ts';
import type { ReconcileGroupTopologyResult } from '../../planning/group-topology-planning-contracts.ts';
import type { GroupTopologyPlanningService } from '../../planning/group-topology-planning-service.ts';
import {
    materializeRtcOverlayTopologyBroadcastMessage,
    type RtcOverlayTopologyMessageFacts
} from '../../planning/materialize-rtc-overlay-topology-broadcast-message.ts';
import { writeRtcTopologyPublicationOutbox } from '../../publication/rtc-topology-ws-outbox-entry.ts';
import type { RtcTopologyDeliveryAppendPort } from '../delivery/rtc-topology-delivery-append-port.ts';
import { RtcTopologyDeliveryLeaseLostError } from '../delivery/rtc-topology-delivery-stream-service.ts';
import {
    isRtcTopologyDeliveryRetryableConflict,
    toRtcTopologyDeliveryAppendInput
} from '../delivery/rtc-topology-delivery-validation.ts';
import { finishRtcTopologyReservation, finishRtcTopologyWork } from './finish-rtc-topology-work.ts';
import { isChangeGatedGroupRevisionWork, toTopologyWorkOrigin } from './rtc-topology-coalesced-group-revision-work.ts';
import { computeAuthorityTopologyInputFingerprint } from './rtc-topology-input-fingerprint.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId,
    type PersistedRtcTopologyWork,
    type RtcTopologyWorkEnvelope
} from './rtc-topology-work-codec.ts';
import {
    readTopologyPromotionRequest,
    writeTopologyPromotionRequest,
    type TopologyPromotionPublicationPort
} from './write-topology-promotion-request.ts';

type AcceptedRtcTopologyMutation = Exclude<RtcTopologyMutationComputed, Readonly<{ outcome: 'loaded' | 'retry'; }>>;

import {
    createDeferredCriterionPetitioner,
    petitionFormationCriterion,
    type DeferredCriterionPetitioner,
    type FormationCriterionPort
} from './compute-formation-criterion-command.ts';

export interface RtcTopologyDeliveryOptions {
    readonly publisherStreamId: string;
    readonly append: RtcTopologyDeliveryAppendPort;
}

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
    /**
     * Damping interval for criterion petitions from refinement-deferred RTT
     * work. Absent means the default; 0 petitions per deferred item.
     */
    readonly criterionPetitionMinIntervalMs?: number;
    readonly topologyPublication?: TopologyPromotionPublicationPort;
    readonly topologyDelivery?: RtcTopologyDeliveryOptions;
    readonly onInactiveOverlay?: (overlayId: string) => void;
    readonly wakeQueue?: () => void;
    readonly wakeReplay?: () => void;
    readonly sleep?: (delayMs: number) => Promise<void>;
    readonly timing?: RallarTimingSink;
    readonly serviceId?: string;
}

/**
 * A criterion petition deferred until the write phase commits: the fence
 * must name the layout identity the store actually holds, so the petition
 * fires only after the row it names is durable (product decisions 19/32,
 * the plan's post-publication boundary).
 */
interface CommittedCriterionPetition {
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: RallarOverlayTopologySnapshot;
}

type AcceptedRtcTopologyWork =
    | Readonly<{
        decision: 'accepted';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        computed: AcceptedRtcTopologyMutation;
        publication: RtcTopologyPublication | null;
        inputFingerprint: string;
        criterionPetition: CommittedCriterionPetition | null;
    }>
    | Readonly<{
        decision: 'skipped-fingerprint';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
    }>
    | Readonly<{
        decision: 'skipped-unchanged';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        inputFingerprint: string;
        criterionPetition: CommittedCriterionPetition | null;
    }>
    | Readonly<{
        decision: 'skipped-frozen';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
        criterionPetition: CommittedCriterionPetition;
    }>
    | Readonly<{
        decision: 'skipped-rtt-refinement';
        work: PersistedRtcTopologyWork;
        group: GroupSnapshot;
    }>;

type RtcTopologyExecutionRead = Awaited<ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>>;

interface ComputeAcceptedRtcTopologyWorkInput {
    readonly options: RtcTopologyWorkHandlerOptions;
    readonly workEnvelope: RtcTopologyWorkEnvelope<PersistedRtcTopologyWork>;
    readonly workId: string;
    readonly attemptCount: number;
    readonly read: RtcTopologyExecutionRead;
    readonly expireAtEpochMs: number;
    readonly deferredCriterionPetitioner: DeferredCriterionPetitioner;
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
    readonly deferredCriterionPetitioner: DeferredCriterionPetitioner;
}

async function processRtcTopologyWork(input: ProcessRtcTopologyWorkInput): Promise<void> {
    const { options, message, entry, deferredCriterionPetitioner } = input;
    const workEnvelope = readRtcTopologyWorkEnvelope(message, options.runtime.workType);
    const workId = toRtcTopologyExecutionId(workEnvelope);
    const read = await options.executionRepository.readTopologyMutation(
        workEnvelope.data.groupSnapshot.group,
        workId
    );
    if (read.publicationClaim) {
        await processLoadedRtcTopologyWork(options, entry, read);
        return;
    }
    const accepted = await computeAcceptedRtcTopologyWork({
        options,
        workEnvelope,
        workId,
        attemptCount: entry.dequeueAudit.attempts,
        read,
        expireAtEpochMs: entry.audit.expiryTs.epochMilliseconds,
        deferredCriterionPetitioner
    });
    await writeAcceptedRtcTopologyWork(options, entry, accepted);
}

async function processLoadedRtcTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    entry: ResourceEntry,
    read: Awaited<ReturnType<RtcTopologyExecutionRepository['readTopologyMutation']>>
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
    await writeRtcTopologyPublicationTransaction(options, entry, async (transaction) => {
        await writePublicationDelivery(transaction, computed.publication, options.topologyDelivery);
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
async function computeRttRefinementSkip(
    input: ComputeAcceptedRtcTopologyWorkInput
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
    await input.deferredCriterionPetitioner.request(work, input.read);
    return {
        decision: 'skipped-rtt-refinement',
        work,
        group: work.groupSnapshot
    };
}

async function computeAcceptedRtcTopologyWork(
    input: ComputeAcceptedRtcTopologyWorkInput
): Promise<AcceptedRtcTopologyWork> {
    const { options, workEnvelope, read } = input;
    const work = workEnvelope.data;
    const rttRefinementSkip = await computeRttRefinementSkip(input);
    if (rttRefinementSkip !== null) {
        return rttRefinementSkip;
    }
    const membershipDeltaWork = work.kind === 'group-revision';
    const authority = await options.topologyPlanning.readTopologyPlanningAuthority({
        groupRef: work.groupSnapshot.group,
        requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
        knownGroup: work.groupSnapshot,
        snapshotSelection: membershipDeltaWork ? 'preserve-known-revision' : 'prefer-current'
    });
    const inputFingerprint = await computeAuthorityTopologyInputFingerprint(authority);
    const changeGated = work.kind === 'group-revision' && isChangeGatedGroupRevisionWork(work);
    if (changeGated && await isFingerprintUnchanged(input, authority, inputFingerprint)) {
        return { decision: 'skipped-fingerprint', work, group: authority.group };
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
            criterionPetition: { authority, planned: computedTopology.current }
        };
    }
    // RTT is deliberately outside the fingerprint, so an RTT refresh always
    // replans — but an unchanged planned graph publishes nothing (M8). The
    // criterion petition fences on the stored row, not the recomputed
    // candidate: an unchanged graph still drifts its causal revision, and a
    // candidate-identity fence would reject the decisive activation.
    const unchangedGated = changeGated || work.kind !== 'group-revision';
    if (unchangedGated && read.snapshot !== null && !computedTopology.changed) {
        return {
            decision: 'skipped-unchanged',
            work,
            group: authority.group,
            inputFingerprint,
            criterionPetition: { authority, planned: read.snapshot.value }
        };
    }
    return await computeCommittedTopologyWork({
        base: input,
        authority,
        planned: computedTopology,
        inputFingerprint
    });
}

async function isFingerprintUnchanged(
    input: ComputeAcceptedRtcTopologyWorkInput,
    authority: GroupTopologyPlanningAuthority,
    inputFingerprint: string
): Promise<boolean> {
    if (input.read.snapshot?.value.state !== 'active') {
        return false;
    }
    const storedFingerprint = await input.options.executionRepository.readTopologyInputFingerprint(
        authority.group.group
    );
    return storedFingerprint === inputFingerprint;
}

interface ComputeCommittedTopologyWorkInput {
    readonly base: ComputeAcceptedRtcTopologyWorkInput;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: Extract<ReconcileGroupTopologyResult, { action: 'planned'; }>;
    readonly inputFingerprint: string;
}

async function computeCommittedTopologyWork(
    input: ComputeCommittedTopologyWorkInput
): Promise<AcceptedRtcTopologyWork> {
    const { authority, planned, inputFingerprint } = input;
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
    const computed = computeTopologyMutation({
        read,
        candidate: planned.snapshot,
        publication,
        facts
    });
    validateTopologyMutation({ read, candidate: planned.snapshot, publication, facts, computed });
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
        publication,
        inputFingerprint,
        criterionPetition: { authority, planned: planned.snapshot }
    };
}

async function writeAcceptedRtcTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    entry: ResourceEntry,
    accepted: AcceptedRtcTopologyWork
): Promise<void> {
    if (accepted.decision === 'skipped-rtt-refinement') {
        await finishRtcTopologyWork(options.database, entry);
        return;
    }
    if (accepted.decision === 'skipped-fingerprint') {
        await finishRtcTopologyWork(options.database, entry);
        options.topologyPlanning.recordTopologyRebuildSkippedFingerprint();
        return;
    }
    if (accepted.decision === 'skipped-unchanged' || accepted.decision === 'skipped-frozen') {
        await writeSkippedTopologyWork(options, entry, accepted);
        return;
    }
    const computed = accepted.computed;
    if (computed.outcome === 'superseded') {
        await finishRtcTopologyWork(options.database, entry);
        options.topologyPlanning.observeCommittedTopology(accepted.group, computed.current);
        return;
    }
    // Read outside, mint inside: the gate reads use the shared database
    // handle and must not run while the transaction holds the session.
    const promotionRequest = computed.outcome === 'write'
        ? await readTopologyPromotionRequest({
            publication: options.topologyPublication,
            serviceId: options.serviceId,
            entry,
            target: computed.snapshotGuard.candidate
        })
        : null;
    await writeRtcTopologyPublicationTransaction(options, entry, async (transaction) => {
        await options.executionRepository.writeTopologyMutation(transaction, computed);
        await writeTopologyPromotionRequest(transaction, promotionRequest);
        if (computed.outcome === 'write') {
            await options.executionRepository.writeTopologyInputFingerprint(
                transaction,
                accepted.group.group,
                accepted.inputFingerprint
            );
        }
        if (accepted.publication) {
            await writePublicationDelivery(transaction, accepted.publication, options.topologyDelivery);
        }
    });
    await finishCommittedTopologyWork(options, accepted, computed);
}

/**
 * The one transaction both skip decisions share: the promotion reconcile —
 * a request a stale cycle failed to mint is re-derived from the stored row
 * here, so accepted and planned can never diverge silently — plus the
 * reservation finish. Only the unchanged decision refreshes the input
 * fingerprint: the frozen path must NOT write it, because the stale
 * fingerprint is decision 11's latched signal that the stored layout
 * trails the authority.
 */
async function writeSkippedTopologyWork(
    options: RtcTopologyWorkHandlerOptions,
    entry: ResourceEntry,
    accepted: Extract<AcceptedRtcTopologyWork, { decision: 'skipped-unchanged' | 'skipped-frozen'; }>
): Promise<void> {
    const promotionRequest = await readTopologyPromotionRequest({
        publication: options.topologyPublication,
        serviceId: options.serviceId,
        entry,
        target: accepted.criterionPetition?.planned ?? null
    });
    await runInPSqlTransaction(options.database, async (transaction) => {
        if (accepted.decision === 'skipped-unchanged') {
            await options.executionRepository.writeTopologyInputFingerprint(
                transaction,
                accepted.group.group,
                accepted.inputFingerprint
            );
        }
        await writeTopologyPromotionRequest(transaction, promotionRequest);
        await finishRtcTopologyReservation(transaction, entry);
    });
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

async function writeRtcTopologyPublicationTransaction(
    options: Pick<RtcTopologyWorkHandlerOptions, 'database'>,
    entry: ResourceEntry,
    write: (transaction: PSqlSql) => Promise<void>
): Promise<void> {
    try {
        await runInPSqlTransaction(options.database, async (transaction) => {
            await write(transaction);
            await finishRtcTopologyReservation(transaction, entry);
        });
    }
    catch (error) {
        if (error instanceof Error && isRtcTopologyDeliveryRetryableConflict(error)) {
            throw new RuntimeStateWriteConflictError();
        }
        throw error;
    }
}

async function writePublicationDelivery(
    transaction: PSqlSql,
    publication: RtcTopologyPublication,
    delivery: RtcTopologyDeliveryOptions | undefined
): Promise<void> {
    const outbox = await writeRtcTopologyPublicationOutbox(transaction, publication);
    if (!delivery) {
        return;
    }
    const result = await delivery.append.appendOrValidate(
        transaction,
        toRtcTopologyDeliveryAppendInput(delivery.publisherStreamId, publication, outbox)
    );
    if (result.status === 'conflict') {
        throw new RuntimeStateWriteConflictError();
    }
    if (result.status === 'lease-lost') {
        throw new RtcTopologyDeliveryLeaseLostError(
            `RTC topology publisher stream ${delivery.publisherStreamId} lost its lease`
        );
    }
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
