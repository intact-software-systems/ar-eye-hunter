import type { ALMessage } from '@shared/al-contracts/al-contract.ts';
import { toWebRtcGroupKey } from '@shared/api/api-type-utils.ts';
import { fromCanonicalGroupTopologyConfigPatch } from '@shared/api/group-topology-config-canonical.ts';
import type { GroupRef, GroupSnapshot } from '@shared/api/group-types.ts';
import type { RallarOverlayTopologySnapshot } from '@shared/api/overlay-topology.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { OnMessageCallback } from '@shared/services/queue-message-callbacks.ts';
import type { GroupFormationAutomationPort } from './create-group-connect-trigger-work-handler.ts';
import {
    computePublicationConnectTriggerRequests
} from './write-group-connect-trigger-requests.ts';
import {
    computeRtcTopologyPublicationDeliveryWrite,
    writeRtcTopologyPublicationTransaction,
    type RtcTopologyDeliveryOptions
} from './write-rtc-topology-publication-transaction.ts';

import { toRtcTopologyPublicationId } from '@shared-server/rallar-system/topology/persistence/rtc-topology-identifiers.ts';
import type { GroupTopologyPlanningAuthority } from '@shared-server/rallar-system/topology/planning/group-topology-planning-authority.ts';
import { hashRtcTopologyExecutionCommand } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication-repository-contracts.ts';
import { type RtcTopologyPublication } from '@shared-server/rallar-system/topology/publication/rtc-topology-publication.ts';
import type { PSqlSql } from '../../../../postgres/p-sql-sql.ts';
import { RuntimeStateWriteConflictError } from '../../../../runtime-state/optimistic-runtime-state-write.ts';
import type { RallarTimingSink } from '../../../observability/timing.ts';
import type { RtcRttRefinementService } from '../../../rtc-rtt/topic/rtc-rtt-refinement-service.ts';
import {
    computeTopologyMutation,
    validateTopologyMutation,
    type RtcTopologyMutationComputed,
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
    computeRtcTopologyReservationFinish,
    finishRtcTopologyWork
} from './finish-rtc-topology-work.ts';
import { isChangeGatedGroupRevisionWork, toTopologyWorkOrigin } from './rtc-topology-coalesced-group-revision-work.ts';
import {
    computeAuthorityTopologyInputFingerprint,
    computeRtcTopologyInputFingerprintWrite
} from './rtc-topology-input-fingerprint.ts';
import {
    readRtcTopologyWorkEnvelope,
    toRtcTopologyExecutionId,
    type PersistedRtcTopologyWork,
    type RtcTopologyWorkEnvelope
} from './rtc-topology-work-codec.ts';
import {
    readTopologyPromotionRequest,
    type TopologyPromotionPublicationPort
} from './write-topology-promotion-request.ts';

type AcceptedRtcTopologyMutation = Exclude<RtcTopologyMutationComputed, Readonly<{ outcome: 'loaded' | 'retry'; }>>;

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
        criterionPetition: CommittedCriterionPetition;
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
    const accepted = await prepareRtcTopologyWork({
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
    read: RtcTopologyMutationRead
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
        reservationFinish: computeRtcTopologyReservationFinish(entry, new Date())
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
    const authority = await options.topologyPlanning.readTopologyPlanningAuthority({
        groupRef: work.groupSnapshot.group,
        requestOptions: fromCanonicalGroupTopologyConfigPatch(work.requestOptions),
        knownGroup: work.groupSnapshot,
        snapshotSelection: membershipDeltaWork ? 'preserve-known-revision' : 'prefer-current'
    });
    const inputFingerprint = await computeAuthorityTopologyInputFingerprint(authority);
    const fingerprintSkip = await readFingerprintSkip(input, authority, inputFingerprint);
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
            criterionPetition: { authority, planned: read.snapshot.value }
        };
    }
    return await prepareTopologyMutation({
        base: input,
        authority,
        planned: computedTopology,
        inputFingerprint
    });
}

async function readFingerprintSkip(
    input: PrepareRtcTopologyWorkInput,
    authority: GroupTopologyPlanningAuthority,
    inputFingerprint: string
): Promise<Extract<AcceptedRtcTopologyWork, { decision: 'skipped-fingerprint'; }> | null> {
    const work = input.workEnvelope.data;
    const snapshot = input.read.snapshot;
    if (!isChangeGatedGroupRevisionWork(work) || snapshot?.value.state !== 'active') {
        return null;
    }
    const storedFingerprint = await input.options.executionRepository.readTopologyInputFingerprint(
        authority.group.group
    );
    return storedFingerprint === inputFingerprint
        ? {
            decision: 'skipped-fingerprint',
            work,
            group: authority.group,
            criterionPetition: { authority, planned: snapshot.value }
        }
        : null;
}

interface PrepareTopologyMutationInput {
    readonly base: PrepareRtcTopologyWorkInput;
    readonly authority: GroupTopologyPlanningAuthority;
    readonly planned: Extract<ReconcileGroupTopologyResult, { action: 'planned'; }>;
    readonly inputFingerprint: string;
}

async function prepareTopologyMutation(
    input: PrepareTopologyMutationInput
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
        // Topology inputs exclude lifecycle: entering a dialing stage can
        // activate against this stored layout without a rebuild/publication.
        await petitionCommittedCriterion(options, accepted.criterionPetition);
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
    const connectRequests = computePublicationConnectTriggerRequests({
        automation: options.formationAutomation,
        target: computed.outcome === 'write' ? computed.snapshotGuard.candidate : null,
        entry
    });
    const deliveryWrite = accepted.publication
        ? computeRtcTopologyPublicationDeliveryWrite(
            accepted.publication,
            options.topologyDelivery?.publisherStreamId
        )
        : null;
    const fingerprintWrite = computed.outcome === 'write'
        ? computeRtcTopologyInputFingerprintWrite(
            accepted.group.group,
            accepted.inputFingerprint
        )
        : null;
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: options.topologyDelivery?.append
    }, {
        mutation: computed,
        promotionRequest,
        connectRequests,
        fingerprint: fingerprintWrite,
        delivery: deliveryWrite,
        reservationFinish: computeRtcTopologyReservationFinish(entry, new Date())
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
    const connectRequests = computePublicationConnectTriggerRequests({
        automation: options.formationAutomation,
        target: accepted.criterionPetition?.planned ?? null,
        entry
    });
    const reservationFinish = computeRtcTopologyReservationFinish(entry, new Date());
    const fingerprintWrite = accepted.decision === 'skipped-unchanged'
        ? computeRtcTopologyInputFingerprintWrite(
            accepted.group.group,
            accepted.inputFingerprint
        )
        : null;
    await writeRtcTopologyPublicationTransaction({
        database: options.database,
        executionRepository: options.executionRepository,
        deliveryAppend: undefined
    }, {
        mutation: null,
        promotionRequest,
        connectRequests,
        fingerprint: fingerprintWrite,
        delivery: null,
        reservationFinish
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
