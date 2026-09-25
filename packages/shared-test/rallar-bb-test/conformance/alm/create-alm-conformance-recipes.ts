import { AL_CONTROL_NACK_TYPE_ID } from '@shared/al-contracts/al-control-type-ids.ts';
import { AL_DELIVERY_ADMITTED_STATES, type ALDeliveryState } from '@shared/alm/delivery/al-delivery-lifecycle.ts';

import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestMessagesReceivedCommand,
    RallarBlackBoxTestMessagesSendCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord,
    RallarBlackBoxTestRtcConnectCommand
} from '../../rallar-black-box-test-contracts.ts';

import { ALM_CONFORMANCE_CARRIERS, type AlmConformanceCarrier } from './alm-conformance-carriers.ts';
import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';

export interface CreateAlmConformanceRecipesInput {
    readonly group: RallarBlackBoxDistributedGroupRef;
    readonly carrier: AlmConformanceCarrier;
    readonly typeId: string;
    readonly senderConnection: string;
    readonly receiverConnection: string;
    readonly deadlineMs: number;
}

export interface AlmConformanceScenario {
    readonly scenarioId:
        | 'bounded-rejection'
        | 'cross-carrier-duplicate'
        | 'deadline-expiry'
        | 'delivery-baseline'
        | 'delivery-lifecycle'
        | 'delivery-reload'
        | 'not-yet-in-sync'
        | 'ordering-resync';
    /** Every recipe, command, handle and type id the pair mints derives from it; distinct per recipe pair. */
    readonly scenarioKey: string;
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    readonly tags: readonly ('smoke' | 'full')[];
}

type AlmConformanceRole = 'sender' | 'receiver';

type AlmConformanceFaultCarrier = 'ws' | 'rtc';

interface AlmConformanceStepInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly scenarioId: AlmConformanceScenario['scenarioId'];
    readonly scenarioKey: string;
    readonly role: AlmConformanceRole;
}

interface AlmConformanceRecipeInput extends AlmConformanceStepInput {
    readonly commands: readonly RallarBlackBoxTestCommand[];
}

interface AlmConformanceMessageStepInput extends AlmConformanceStepInput {
    readonly index: number;
}

interface AlmConformanceSendDelivery {
    readonly ttlMs?: number;
    /** Command budget when it must stay independent of `ttlMs`. */
    readonly commandTimeoutMs?: number;
    readonly ack?: 'receiver';
    readonly reliability?: 'at-least-once';
    readonly orderingKey?: string;
    readonly seq?: number;
    readonly minSnapshotVersion?: RallarBlackBoxTestMessagesSendCommand['minSnapshotVersion'];
}

interface AlmConformanceSendInput extends AlmConformanceMessageStepInput {
    readonly payload: RallarBlackBoxTestJsonValue;
    readonly delivery: AlmConformanceSendDelivery;
}

interface AlmConformanceObserveInput extends AlmConformanceMessageStepInput {
    readonly state: 'admitted' | ALDeliveryState;
}

interface AlmConformanceAssertInput extends AlmConformanceMessageStepInput {
    readonly field: 'status' | 'reason';
    readonly operator: 'equals' | 'contains';
    readonly expected: string;
}

interface AlmConformanceReceivedInput extends AlmConformanceMessageStepInput {
    readonly count: number;
    readonly absent: boolean;
}

interface AlmConformanceFaultInput extends AlmConformanceStepInput {
    readonly faultCarrier: AlmConformanceFaultCarrier;
}

interface AlmConformancePayloadWaitInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly payload: Readonly<Record<string, string>>;
    readonly absent: boolean;
}

interface AlmConformanceResultAssertionInput {
    readonly step: AlmConformanceStepInput;
    readonly name: string;
    readonly resultName: string;
    readonly field: string;
    readonly operator: 'equals' | 'matches' | 'gt';
    readonly expected: string | number | boolean;
}

interface AlmConformanceScenarioDefinition {
    readonly scenarioId: AlmConformanceScenario['scenarioId'];
    readonly scenarioKey: string;
    readonly tags: readonly ('smoke' | 'full')[];
    readonly carriers: readonly AlmConformanceCarrier[];
    readonly toSenderCommands: (sender: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
    readonly toReceiverCommands: (receiver: AlmConformanceStepInput) => readonly RallarBlackBoxTestCommand[];
}

const SMOKE_TAGS: readonly ('smoke' | 'full')[] = ['smoke', 'full'];
const FULL_TAGS: readonly ('smoke' | 'full')[] = ['full'];

/** `not-yet-in-sync` needs a carrier whose first hop is RTC: the receiver checks a room send's snapshot floor at RTC ingress. */
const RTC_CARRIERS: readonly AlmConformanceCarrier[] = ALM_CONFORMANCE_CARRIERS.filter((carrier) => carrier !== 'ws');
/** The only cell that connects both transports, so one envelope can reach the receiver over each. */
const FALLBACK_CARRIERS: readonly AlmConformanceCarrier[] = ['rtc-with-ws-fallback'];
const CROSS_CARRIER_ORDERS = ['rtc-then-ws', 'ws-then-rtc'] as const;
const NOT_YET_IN_SYNC_VARIANTS = ['delivered-after-refresh', 'expires'] as const;
/** The browser's default lifetime, stated so the send outlives the whole scenario window. */
const NON_EXPIRING_TTL_MS = 30_000;
/** A floor no group reaches within a run, so the receiver refuses every copy until the message expires. */
const UNREACHABLE_SNAPSHOT_VERSION = 999_999;
const INBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.inbound_diagnostics';
const OUTBOUND_DIAGNOSTICS_TOPIC = 'rallar.browser.alm.outbound_diagnostics';

const ENSURE_TIMEOUT_MS = 5_000;
/** A cold RTC handshake on a fresh server exceeds the message deadline; connect budgets are harness budgets. */
const CONNECT_TIMEOUT_MS = 45_000;
const CONNECT_READINESS_TIMEOUT_MS = 30_000;
const CONNECT_READINESS_INTERVAL_MS = 100;
/** Hosted conformance may need more than five seconds to admit a non-expiring send. */
const NON_EXPIRING_SEND_TIMEOUT_MS = 10_000;
const MESSAGE_CONTROL_TIMEOUT_MS = 5_000;
const FAULT_TIMEOUT_MS = 3_000;
const ASSERT_TIMEOUT_MS = 2_000;
const STATS_TIMEOUT_MS = 3_000;
const STORAGE_COUNTERS_TIMEOUT_MS = 3_000;
const RESPONSE_MARGIN_MS = 1_000;
const OBSERVE_TIMEOUT_BASE_MS = 2_000;
// Must clear the slowest observed outbound-admission latency (up to 5s on a loaded CI runner) with
// margin, and still leave most of the receiver's `deadlineMs - RESPONSE_MARGIN_MS` absence window
// after expiry, so the absence proves the ttl expired rather than racing the deadline itself. The
// expiring send's command budget is this ttl, so it also bounds how long admission may take.
const EXPIRY_TTL_MS = 7_500;
/**
 * The browser fills an omitted TTL with 30 seconds. The absence proof, the
 * document replacement, and one reserved-work lease consume that before the
 * fresh runtime can submit, so the reload original states a longer lifetime.
 */
const RELOAD_RECOVERY_MARGIN_MS = 60_000;
/** RTC-with-WS-fallback injects one fault per carrier before starting the expiring send. */
const MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS = FAULT_TIMEOUT_MS * 2;
const MINIMUM_POST_EXPIRY_OBSERVATION_MS = 2_500;
/** The absence window must contain pre-send faults, the message lifetime, and post-expiry proof. */
const MINIMUM_DEADLINE_MS = MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS +
    EXPIRY_TTL_MS +
    MINIMUM_POST_EXPIRY_OBSERVATION_MS +
    RESPONSE_MARGIN_MS;

/** The product only admits a user WS topic under `app.` or `room.`; the scenario scope stays in the typeId. */
const ALM_CONFORMANCE_TOPIC_ID = 'room.alm-conformance';

const OVERSIZED_PAYLOAD_BYTES = 70_000;
const OVERSIZED_PAYLOAD_FILLER = 'x'.repeat(OVERSIZED_PAYLOAD_BYTES);
const OVERSIZED_REJECTION_REASON = 'Payload exceeds';
const FAULT_REMAINING = 100;
const RESYNC_GAP_SEQ = 300;

const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
    {
        scenarioId: 'bounded-rejection',
        scenarioKey: 'bounded-rejection',
        tags: SMOKE_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toBoundedRejectionSenderCommands,
        toReceiverCommands: toBoundedRejectionReceiverCommands
    },
    {
        scenarioId: 'deadline-expiry',
        scenarioKey: 'deadline-expiry',
        tags: SMOKE_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toDeadlineExpirySenderCommands,
        toReceiverCommands: toDeadlineExpiryReceiverCommands
    },
    {
        scenarioId: 'delivery-baseline',
        scenarioKey: 'delivery-baseline',
        tags: SMOKE_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toDeliveryBaselineSenderCommands,
        toReceiverCommands: toDeliveryBaselineReceiverCommands
    },
    {
        scenarioId: 'delivery-lifecycle',
        scenarioKey: 'delivery-lifecycle',
        tags: SMOKE_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toDeliveryLifecycleSenderCommands,
        toReceiverCommands: toDeliveryLifecycleReceiverCommands
    },
    {
        scenarioId: 'delivery-reload',
        scenarioKey: 'delivery-reload',
        tags: FULL_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toDeliveryReloadSenderCommands,
        toReceiverCommands: toDeliveryReloadReceiverCommands
    },
    {
        scenarioId: 'ordering-resync',
        scenarioKey: 'ordering-resync',
        tags: FULL_TAGS,
        carriers: ALM_CONFORMANCE_CARRIERS,
        toSenderCommands: toOrderingResyncSenderCommands,
        toReceiverCommands: toOrderingResyncReceiverCommands
    },
    ...CROSS_CARRIER_ORDERS.map((order) => ({
        scenarioId: 'cross-carrier-duplicate' as const,
        scenarioKey: `cross-carrier-duplicate-${order}`,
        tags: FULL_TAGS,
        carriers: FALLBACK_CARRIERS,
        toSenderCommands: (sender: AlmConformanceStepInput) => toCrossCarrierDuplicateSenderCommands(sender, order),
        toReceiverCommands: (receiver: AlmConformanceStepInput) =>
            toCrossCarrierDuplicateReceiverCommands(receiver, order)
    })),
    ...NOT_YET_IN_SYNC_VARIANTS.map((variant) => ({
        scenarioId: 'not-yet-in-sync' as const,
        scenarioKey: `not-yet-in-sync-${variant}`,
        tags: FULL_TAGS,
        carriers: RTC_CARRIERS,
        toSenderCommands: (sender: AlmConformanceStepInput) => toNotYetInSyncSenderCommands(sender, variant),
        toReceiverCommands: (receiver: AlmConformanceStepInput) => toNotYetInSyncReceiverCommands(receiver, variant)
    }))
];

export function createAlmConformanceRecipes(
    input: CreateAlmConformanceRecipesInput
): readonly AlmConformanceScenario[] {
    if (input.deadlineMs < MINIMUM_DEADLINE_MS) {
        throw new RangeError(
            `createAlmConformanceRecipes requires deadlineMs of at least ${MINIMUM_DEADLINE_MS}.`
        );
    }

    return ALM_CONFORMANCE_SCENARIOS
        .filter((definition) => definition.carriers.includes(input.carrier))
        .map((definition) => toAlmConformanceScenario(input, definition));
}

function toAlmConformanceScenario(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition
): AlmConformanceScenario {
    const { scenarioId, scenarioKey } = definition;
    const sender: AlmConformanceStepInput = { input, scenarioId, scenarioKey, role: 'sender' };
    const receiver: AlmConformanceStepInput = { input, scenarioId, scenarioKey, role: 'receiver' };
    return {
        scenarioId,
        scenarioKey,
        tags: definition.tags,
        sender: toAlmConformanceRecipe({
            ...sender,
            commands: definition.toSenderCommands(sender)
        }),
        receiver: toAlmConformanceRecipe({
            ...receiver,
            commands: definition.toReceiverCommands(receiver)
        })
    };
}

function toBoundedRejectionReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toBoundedRejectionSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, filler: OVERSIZED_PAYLOAD_FILLER },
            delivery: {}
        }),
        toSendAssertCommand({
            ...sender,
            index: 1,
            field: 'status',
            operator: 'equals',
            expected: 'rejected'
        }),
        toSendAssertCommand({
            ...sender,
            index: 1,
            field: 'reason',
            operator: 'contains',
            expected: OVERSIZED_REJECTION_REASON
        }),
        toObserveCommand({ ...sender, index: 1, state: 'rejected' }),
        toCancelCommand({ ...sender, index: 1 }),
        {
            ...toObserveCommand({ ...sender, index: 1, state: 'rejected' }),
            commandId: toCommandId(sender, 'observe-rejected-after-cancel-1')
        }
    ];
}

function toDeadlineExpiryReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: true
    })];
}

function toDeadlineExpirySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toFaultCarriers(sender.input.carrier).map((faultCarrier) => toFaultCommand({ ...sender, faultCarrier })),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, carrier: sender.input.carrier },
            delivery: { ttlMs: EXPIRY_TTL_MS, ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state: 'expired' }),
        toResultAssertion({
            step: sender,
            name: 'assert-expired-1',
            resultName: 'observe-expired-1',
            field: 'state',
            operator: 'equals',
            expected: 'expired'
        })
    ];
}

function toDeliveryBaselineSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: {}
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toReceiptsCommand({ ...sender, index: 1 }),
        toStorageCountersCommand(sender, 'storage-counters'),
        toStorageCountersAssertCommand(sender)
    ];
}

function toDeliveryBaselineReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [toReceivedCommand({
        ...receiver,
        index: 1,
        count: 1,
        absent: false
    })];
}

/** Each retained specimen explicitly releases its own hold; recipe failure uses runtime cleanup. */
function toDeliveryLifecycleSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toSubmissionSpecimenCommands(sender),
        ...toRetainedCancellationCommands(sender),
        ...toSupersedenceCommands(sender),
        ...toSubmissionReceiptCommands(sender)
    ];
}

/** The native hold ends only with the old document; the fresh runtime restores the original durable work. */
function toDeliveryReloadSenderCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const reconnect = toConnectCommand(sender);
    return [
        toReloadHealthCommand(sender, 'health-before'),
        ...toHeldFaultCommands(sender, 'reload-hold', 'until-cleared'),
        toReloadOriginalSend(sender),
        ...toRetainedEvidenceCommands({ ...sender, index: 1 }),
        toStorageCountersCommand(sender, 'storage-counters-held'),
        ...(['al-admission', 'al-work'] as const).map((owner) =>
            toResultAssertion({
                step: sender,
                name: `assert-storage-${owner}`,
                resultName: 'storage-counters-held',
                field: `byOwner.${owner}`,
                operator: 'gt',
                expected: 0
            })
        ),
        toResultAssertion({
            step: sender,
            name: 'assert-storage-write',
            resultName: 'storage-counters-held',
            field: 'byKind.write',
            operator: 'gt',
            expected: 0
        }),
        {
            kind: 'agent.reload',
            commandId: toCommandId(sender, 'reload'),
            readyTimeoutMs: CONNECT_READINESS_TIMEOUT_MS,
            timeoutMs: CONNECT_TIMEOUT_MS
        },
        {
            ...reconnect,
            commandId: toCommandId(sender, 'reconnect'),
            rallar: { ...reconnect.rallar, username: '', password: '', restoreSession: true }
        },
        toObserveCommand({ ...sender, index: 1, state: 'unobservable' }),
        toResultAssertion({
            step: sender,
            name: 'assert-old-handle-unobservable',
            resultName: 'observe-unobservable-1',
            field: 'state',
            operator: 'equals',
            expected: 'unobservable'
        }),
        toStorageCountersCommand(sender, 'storage-counters-recovered')
    ];
}

function toReloadOriginalSend(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: 'delivery-reload', carrier: sender.input.carrier },
        delivery: {
            ack: 'receiver',
            ttlMs: toReloadSurvivalTtlMs(sender.input.deadlineMs),
            commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS
        }
    });
}

function toDeliveryReloadReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const payload = { marker: 'delivery-reload', carrier: receiver.input.carrier };
    return [
        toReloadHealthCommand(receiver, 'health-before'),
        toPayloadWait({ step: receiver, name: 'absent-before-reload', payload, absent: true }),
        toPayloadWait({ step: receiver, name: 'receive-original', payload, absent: false }),
        toReloadHealthCommand(receiver, 'health-after')
    ];
}

function toReloadHealthCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return { kind: 'health', commandId: toCommandId(step, name), timeoutMs: STATS_TIMEOUT_MS };
}

function toReloadCheckpoint(step: AlmConformanceStepInput): AlmReloadCheckpoint {
    const sender = { ...step, role: 'sender' as const };
    const receiver = { ...step, role: 'receiver' as const };
    return {
        key: `alm-${step.input.carrier}-delivery-reload`,
        senderPrefixEnd: toCommandId(sender, 'assert-storage-write'),
        senderReload: toCommandId(sender, 'reload'),
        senderSuffixEnd: toCommandId(sender, 'storage-counters-recovered'),
        receiverReadyEnd: toCommandId(receiver, 'health-before'),
        receiverAbsenceEnd: toCommandId(receiver, 'absent-before-reload'),
        receiverRecoveryEnd: toCommandId(receiver, 'health-after')
    };
}

/**
 * D28: the receiver's own wait is the local receipt for the submission, so the sender only proves
 * carrier-level submission here; `toSubmissionReceiptCommands` reads the sender's receipts and
 * releases the handle afterwards, once the whole scenario has elapsed.
 */
function toSubmissionSpecimenCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const state = 'transport-accepted';
    const observation = `observe-${state}-1`;
    const isWs = sender.input.carrier === 'ws';
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: toLifecyclePayload(sender, 'submission'),
            delivery: { ack: 'receiver' }
        }),
        toObserveCommand({ ...sender, index: 1, state }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-state-1',
            resultName: observation,
            field: 'state',
            operator: isWs ? 'equals' : 'matches',
            expected: isWs ? state : '^(transport-accepted|acknowledged)$'
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-1',
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: true
        })
    ];
}

/** Receipts and the handle's release are read after the whole scenario, per D28. */
function toSubmissionReceiptCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceiptsCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-confirmed-1',
            resultName: 'receipts-1',
            field: 'confirmedHopPeerIds.length',
            operator: sender.input.carrier === 'ws' ? 'equals' : 'gt',
            expected: 0
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-unconfirmed-1',
            resultName: 'receipts-1',
            field: 'unconfirmedHopPeerIds.length',
            operator: 'equals',
            expected: 0
        }),
        ...toSubmittedCancellationCommands(sender)
    ];
}

function toSubmittedCancellationCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toCancelCommand({ ...sender, index: 1 }),
        toResultAssertion({
            step: sender,
            name: 'assert-submitted-after-cancel-1',
            resultName: 'cancel-1',
            field: 'submitted',
            operator: 'equals',
            expected: true
        }),
        toResultAssertion({
            step: sender,
            name: 'assert-state-after-cancel-1',
            resultName: 'cancel-1',
            field: 'state',
            operator: 'matches',
            expected: sender.input.carrier === 'ws' ? '^(cancelled|transport-accepted)$' : '^acknowledged$'
        })
    ];
}

function toRetainedCancellationCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(sender, 'cancel-hold', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 2,
            payload: toLifecyclePayload(sender, 'cancellation'),
            delivery: { ack: 'receiver' }
        }),
        ...toRetainedEvidenceCommands({ ...sender, index: 2 }),
        toCancelCommand({ ...sender, index: 2 }),
        toResultAssertion({
            step: sender,
            name: 'assert-cancelled-2',
            resultName: 'cancel-2',
            field: 'state',
            operator: 'equals',
            expected: 'cancelled'
        }),
        ...toHeldFaultCommands(sender, 'cancel-release', 0)
    ];
}

function toSupersedenceCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toHeldFaultCommands(sender, 'supersede-hold', 'until-cleared'),
        toSendCommand({
            ...sender,
            index: 3,
            payload: toLifecyclePayload(sender, 'supersedence', 'old'),
            delivery: { ack: 'receiver' }
        }),
        ...toRetainedEvidenceCommands({ ...sender, index: 3 }),
        toSendCommand({
            ...sender,
            index: 4,
            payload: toLifecyclePayload(sender, 'supersedence', 'replacement'),
            delivery: { ack: 'receiver' }
        }),
        ...toAdmissionCommands({ ...sender, index: 4 }),
        toObserveCommand({ ...sender, index: 3, state: 'superseded' }),
        toResultAssertion({
            step: sender,
            name: 'assert-superseded-3',
            resultName: 'observe-superseded-3',
            field: 'state',
            operator: 'equals',
            expected: 'superseded'
        }),
        ...toHeldFaultCommands(sender, 'supersede-release', 0),
        ...toReplacementSubmittedCommands(sender)
    ];
}

/**
 * The receiver proves the replacement arrived. Hold release only makes that send possible, so the
 * sender stays up until the replacement is actually submitted.
 */
function toReplacementSubmittedCommands(sender: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    const state = 'transport-accepted';
    const observation = `observe-${state}-4`;
    return [
        toObserveCommand({ ...sender, index: 4, state }),
        toResultAssertion({
            step: sender,
            name: 'assert-replacement-submitted-4',
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: true
        })
    ];
}

function toRetainedEvidenceCommands(step: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const observation = `observe-admitted-${step.index}`;
    return [
        ...toAdmissionCommands(step),
        toResultAssertion({
            step: step,
            name: `assert-enqueued-${step.index}`,
            resultName: observation,
            field: 'enqueued',
            operator: 'equals',
            expected: true
        }),
        toResultAssertion({
            step: step,
            name: `assert-retained-${step.index}`,
            resultName: observation,
            field: 'state',
            operator: 'matches',
            expected: '^(accepted|queued)$'
        }),
        toResultAssertion({
            step: step,
            name: `assert-unsubmitted-${step.index}`,
            resultName: observation,
            field: 'submitted',
            operator: 'equals',
            expected: false
        })
    ];
}

function toDeliveryLifecycleReceiverCommands(receiver: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [
        toPayloadWait({
            step: receiver,
            name: 'receive-submission',
            payload: toLifecyclePayload(receiver, 'submission'),
            absent: false
        }),
        toPayloadWait({
            step: receiver,
            name: 'absent-cancelled',
            payload: toLifecyclePayload(receiver, 'cancellation'),
            absent: true
        }),
        toPayloadWait({
            step: receiver,
            name: 'receive-replacement',
            payload: toLifecyclePayload(receiver, 'supersedence', 'replacement'),
            absent: false
        }),
        toPayloadWait({
            step: receiver,
            name: 'absent-old',
            payload: toLifecyclePayload(receiver, 'supersedence', 'old'),
            absent: true
        })
    ];
}

function toLifecyclePayload(
    step: AlmConformanceStepInput,
    specimen: 'submission' | 'cancellation' | 'supersedence',
    revision?: 'old' | 'replacement'
): Readonly<Record<string, string>> {
    return { marker: 'delivery-lifecycle', specimen, carrier: step.input.carrier, ...(revision ? { revision } : {}) };
}

function toPayloadWait({ step, name, payload, absent }: AlmConformancePayloadWaitInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, name),
        match: {
            kind: 'message',
            connection: step.input.receiverConnection,
            payloadPath: 'data.payload',
            equals: payload
        },
        ...(absent ? { absent: true } : {}),
        timeoutMs: step.input.deadlineMs + (absent ? 0 : NON_EXPIRING_SEND_TIMEOUT_MS) - RESPONSE_MARGIN_MS
    };
}

function toHeldFaultCommands(
    step: AlmConformanceStepInput,
    name: string,
    remaining: 'until-cleared' | 0
): readonly RallarBlackBoxTestCommand[] {
    return toFaultCarriers(step.input.carrier).map((carrier) => ({
        kind: 'fault.inject',
        commandId: toCommandId(step, `${name}-${carrier}`),
        faultId: `hold-${carrier}-${toScenarioTypeId(step)}`,
        carrier,
        match: { typeId: toScenarioTypeId(step) },
        action: carrier === 'ws' ? 'not-ready' : 'drop',
        remaining,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, step.input.deadlineMs)
    }));
}

function toResultAssertion(
    { step, name, resultName, field, operator, expected }: AlmConformanceResultAssertionInput
): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(step, name),
        source: `resultCache.${toCommandId(step, resultName)}.value.${field}`,
        operator,
        expected,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/** Over ws the WS server is the relay that refuses the gapped send, so its NACK is the verdict, witnessed at the sender. */
function toOrderingResyncSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const orderingKey = `alm-${sender.input.carrier}-${sender.scenarioId}`;
    const commands = [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, seq: 1 },
            delivery: { reliability: 'at-least-once', orderingKey, seq: 1 }
        }),
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toSendCommand({
            ...sender,
            index: 2,
            payload: { marker: sender.scenarioId, seq: RESYNC_GAP_SEQ },
            delivery: { reliability: 'at-least-once', orderingKey, seq: RESYNC_GAP_SEQ }
        }),
        ...toAdmissionCommands({ ...sender, index: 2 })
    ];
    return sender.input.carrier === 'ws' ? [...commands, toRelayResyncNackWait(sender)] : commands;
}

/** The send holds no obligation, so the sender refuses the NACK; the refusal still names the gapped msgId. */
function toRelayResyncNackWait(sender: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const gappedMsgId = `{resultCache.${toCommandId(sender, 'send-2')}.value.msgId}`;
    return {
        kind: 'wait',
        commandId: toCommandId(sender, 'relay-resync-nack'),
        match: {
            kind: 'diagnostic',
            topic: OUTBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${AL_CONTROL_NACK_TYPE_ID}","targetMsgId":"${gappedMsgId}"`
        },
        timeoutMs: sender.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
    };
}

/** Over the RTC carriers the receiver is the hop that refuses the gapped send, so it proves its own verdict (D44). */
function toOrderingResyncReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const [delivered, absentSecond] = toSingleArrivalReceiverCommands(receiver);
    if (receiver.input.carrier === 'ws') {
        return [delivered, absentSecond];
    }
    return [
        delivered,
        toAdmissionOutcomeWait(receiver, {
            name: 'resync-outcome',
            contains: '"carrier":"rtc","outcome":"not-handled","reason":"resync-required"',
            timeoutMs: receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
        }),
        absentSecond
    ];
}

/**
 * One envelope over both carriers, which the product never does (it falls back only after an
 * `unroutable` verdict): the replay reuses the first handle's captured envelope on the other carrier.
 * The sender proves its first copy was submitted and the replay admitted, never the replayed handle's
 * acknowledgement (D28). The receiver's count proves the second copy was not delivered twice, and its
 * duplicate-outcome wait proves the second copy arrived and was refused, in both orders.
 */
function toCrossCarrierDuplicateSenderCommands(
    sender: AlmConformanceStepInput,
    order: (typeof CROSS_CARRIER_ORDERS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const [first, replay] = order === 'rtc-then-ws' ? (['rtc', 'ws'] as const) : (['ws', 'rtc'] as const);
    const firstSend = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioId, order },
        delivery: { ack: 'receiver', ttlMs: NON_EXPIRING_TTL_MS, commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS }
    });
    return [
        { ...firstSend, carrier: first },
        toObserveCommand({ ...sender, index: 1, state: 'transport-accepted' }),
        ...(['state', 'submitted'] as const).map((field) =>
            toResultAssertion({
                step: sender,
                name: `assert-${field}-1`,
                resultName: 'observe-transport-accepted-1',
                field,
                operator: field === 'state' ? 'matches' : 'equals',
                expected: field === 'state' ? '^(transport-accepted|acknowledged)$' : true
            })
        ),
        {
            kind: 'messages.send',
            commandId: toCommandId(sender, 'send-2'),
            connection: sender.input.senderConnection,
            replayOnCarrier: { handleId: toSendHandleId({ ...sender, index: 1 }), carrier: replay },
            timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, sender.input.deadlineMs)
        },
        toResultAssertion({
            step: sender,
            name: 'assert-replay-admitted-2',
            resultName: 'send-2',
            field: 'verdict',
            operator: 'equals',
            expected: 'admitted'
        }),
        toReceiptsCommand({ ...sender, index: 1 })
    ];
}

/**
 * The receiver refused the pair's second copy. rtc-then-ws pins that copy to WS: RTC `transport-accepted` is the
 * receiver's own hop ACK, so the RTC copy committed first. ws-then-rtc accepts either carrier, since WS
 * `transport-accepted` is only the server's: it reads the pair's latest `admission-outcome`, which is the second
 * arrival's. Both run after the absence window, when the outcome is already in the event buffer, so a short budget
 * suffices. A receiver stays one linear transcript for the reload identity join, so the either-carrier case is a wait
 * and two assertions rather than a composite.
 */
function toCrossCarrierDuplicateReceiverCommands(
    receiver: AlmConformanceStepInput,
    order: (typeof CROSS_CARRIER_ORDERS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const arrivals = toSingleArrivalReceiverCommands(receiver);
    if (order === 'rtc-then-ws') {
        return [
            ...arrivals,
            toAdmissionOutcomeWait(receiver, {
                name: 'duplicate-outcome-ws',
                contains: '"carrier":"ws","outcome":"not-handled","reason":"duplicate"',
                timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
            })
        ];
    }
    const latest = toAdmissionOutcomeWait(receiver, {
        name: 'duplicate-outcome-latest',
        contains: '"carrier":"',
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, receiver.input.deadlineMs)
    });
    return [
        ...arrivals,
        latest,
        ...([['outcome', 'not-handled'], ['reason', 'duplicate']] as const).map(([field, expected]) =>
            toResultAssertion({
                step: receiver,
                name: `assert-duplicate-outcome-${field}`,
                resultName: 'duplicate-outcome-latest',
                field: `event.payload.data.${field}`,
                operator: 'equals',
                expected
            })
        )
    ];
}

/**
 * The pair's `admission-outcome` event, matched in its emitted key order (`typeId`, then `carrier`, `outcome`,
 * `reason`); the inbound diagnostics event carries no connection to route on.
 */
function toAdmissionOutcomeWait(
    step: AlmConformanceStepInput,
    outcome: Readonly<{ name: string; contains: string; timeoutMs: number; }>
): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(step, outcome.name),
        match: {
            kind: 'diagnostic',
            topic: INBOUND_DIAGNOSTICS_TOPIC,
            payloadPath: 'data',
            contains: `"typeId":"${toScenarioTypeId(step)}",${outcome.contains}`
        },
        timeoutMs: outcome.timeoutMs
    };
}

/**
 * A send above the receiver's room snapshot. The receiver refuses it at admission and writes nothing; its NACK
 * schedules the sender's retries (D35). `delivered-after-refresh` states a floor one past the sender's own version,
 * so it proves NACK → retry → delivery once the group version advances; the sender proves only its own hop evidence
 * (D28). Today no plain-member write advances that version, so the variant is a named red at the receiver's
 * `received-1` (ruling e). `expires` states a floor no group reaches, so every copy is refused until it expires.
 */
function toNotYetInSyncSenderCommands(
    sender: AlmConformanceStepInput,
    variant: (typeof NOT_YET_IN_SYNC_VARIANTS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const expires = variant === 'expires';
    const send = toSendCommand({
        ...sender,
        index: 1,
        payload: { marker: sender.scenarioId, variant },
        delivery: {
            ack: 'receiver',
            reliability: 'at-least-once',
            ...(expires
                ? { ttlMs: EXPIRY_TTL_MS, minSnapshotVersion: { absolute: UNREACHABLE_SNAPSHOT_VERSION } }
                : {
                    ttlMs: NON_EXPIRING_TTL_MS,
                    commandTimeoutMs: NON_EXPIRING_SEND_TIMEOUT_MS,
                    minSnapshotVersion: { aboveCurrentBy: 1 }
                })
        }
    });
    const state = expires ? 'expired' : 'transport-accepted';
    return [
        send,
        ...toAdmissionCommands({ ...sender, index: 1 }),
        toObserveCommand({ ...sender, index: 1, state }),
        toResultAssertion({
            step: sender,
            name: `assert-${state}-1`,
            resultName: `observe-${state}-1`,
            field: 'state',
            operator: 'matches',
            expected: expires ? '^expired$' : '^(transport-accepted|acknowledged)$'
        })
    ];
}

/**
 * The refusal comes first: over RTC, with the receiver's own not-yet-in-sync reason. Then one delivery, or absence
 * for the rest of the message's lifetime and past it.
 */
function toNotYetInSyncReceiverCommands(
    receiver: AlmConformanceStepInput,
    variant: (typeof NOT_YET_IN_SYNC_VARIANTS)[number]
): readonly RallarBlackBoxTestCommand[] {
    const refusal = toAdmissionOutcomeWait(receiver, {
        name: 'not-yet-in-sync-outcome',
        contains: '"carrier":"rtc","outcome":"rejected","reason":"not-yet-in-sync',
        timeoutMs: receiver.input.deadlineMs + NON_EXPIRING_SEND_TIMEOUT_MS - RESPONSE_MARGIN_MS
    });
    if (variant === 'delivered-after-refresh') {
        return [refusal, toReceivedCommand({ ...receiver, index: 1, count: 1, absent: false })];
    }
    const windowMs = EXPIRY_TTL_MS + MINIMUM_POST_EXPIRY_OBSERVATION_MS;
    return [
        refusal,
        {
            ...toReceivedCommand({ ...receiver, index: 1, count: 1, absent: true }),
            windowMs,
            timeoutMs: windowMs + RESPONSE_MARGIN_MS
        }
    ];
}

/** The typed receiver subscribes to both transports, so a second delivery of one message counts as two. */
function toSingleArrivalReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({
            ...receiver,
            index: 1,
            count: 1,
            absent: false
        }),
        toReceivedCommand({
            ...receiver,
            index: 2,
            count: 2,
            absent: true
        })
    ];
}

function toAlmConformanceRecipe(recipe: AlmConformanceRecipeInput): RallarBlackBoxTestRecipe {
    const carrier = recipe.input.carrier;
    return {
        schemaVersion: 1,
        recipeId: `alm-${carrier}-${recipe.scenarioKey}-${recipe.role}`,
        name: `ALM conformance ${recipe.scenarioKey} ${recipe.role} over ${carrier}`,
        continueOnFailure: false,
        metadata: {
            profile: 'alm-conformance',
            carrier,
            scenarioId: recipe.scenarioId,
            group: toRoomRef(recipe.input.group),
            ...(recipe.scenarioId === 'delivery-reload'
                ? { almReloadCheckpoints: [{ ...toReloadCheckpoint(recipe) }] }
                : {})
        },
        commands: [
            toEnsureGroupCommand(recipe),
            toEnsureMemberCommand(recipe),
            toConnectCommand(recipe),
            ...toConnectedStorageCountersCommands(recipe),
            ...recipe.commands,
            toStatsCommand(recipe)
        ]
    };
}

function toEnsureGroupCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const group = step.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(step, 'ensure-group'),
        timeoutMs: toBudgetMs(ENSURE_TIMEOUT_MS, step.input.deadlineMs),
        metadata: {
            purpose: 'Ensure the backend group exists before the ALM carrier connects.',
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'POST',
            path: `${toStatePrefix(group)}/groups/requests/${toEnsureRequestId(step, 'group')}`,
            body: {
                groupId: group.groupId,
                displayName: group.groupId,
                kind: 'room',
                joinMode: 'open'
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201, 409]
        }
    };
}

function toEnsureMemberCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const group = step.input.group;
    return {
        kind: 'http.request',
        commandId: toCommandId(step, 'ensure-member'),
        timeoutMs: toBudgetMs(ENSURE_TIMEOUT_MS, step.input.deadlineMs),
        metadata: {
            purpose: 'Ensure the logged-in browser client is an active group member ' +
                'before the ALM carrier connects.',
            idempotent: true,
            group: toRoomRef(group)
        },
        request: {
            method: 'PUT',
            path: `${toStatePrefix(group)}/groups/${group.groupId}/members/{auth.clientId}` +
                `/requests/${toEnsureRequestId(step, 'member')}`,
            body: {
                status: 'active'
            }
        },
        response: {
            body: 'json',
            acceptedStatusCodes: [200, 201]
        }
    };
}

function toConnectCommand(step: AlmConformanceStepInput): RallarBlackBoxTestRtcConnectCommand {
    const input = step.input;
    const typeId = toScenarioTypeId(step);
    return {
        kind: 'rtc.connect',
        commandId: toCommandId(step, 'connect'),
        connection: toConnectionName(step),
        actor: '{auth.clientId}',
        roomId: input.group.groupId,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomRef: toRoomRef(input.group),
        transport: input.carrier === 'ws' ? 'messages.ws' : 'messages.rtc',
        rallar: { typeId, topicId: ALM_CONFORMANCE_TOPIC_ID },
        timeoutMs: CONNECT_TIMEOUT_MS,
        ...(input.carrier === 'ws' ? {} : {
            readiness: {
                minReadyPeers: 1,
                timeoutMs: CONNECT_READINESS_TIMEOUT_MS,
                intervalMs: CONNECT_READINESS_INTERVAL_MS
            }
        })
    };
}

function toSendCommand(send: AlmConformanceSendInput): RallarBlackBoxTestMessagesSendCommand {
    const input = send.input;
    const typeId = toScenarioTypeId(send);
    const { commandTimeoutMs, ...delivery } = send.delivery;
    return {
        kind: 'messages.send',
        commandId: toCommandId(send, `send-${send.index}`),
        connection: input.senderConnection,
        carrier: input.carrier,
        typeId,
        topicId: ALM_CONFORMANCE_TOPIC_ID,
        payload: send.payload,
        handleId: toSendHandleId(send),
        timeoutMs: toBudgetMs(
            commandTimeoutMs ?? delivery.ttlMs ?? NON_EXPIRING_SEND_TIMEOUT_MS,
            input.deadlineMs
        ),
        ...(input.carrier === 'ws' ? {} : { roomRef: toRoomRef(input.group) }),
        ...delivery,
        ...toCarrierAckQos(input.carrier, delivery.ack)
    };
}

/**
 * The RTC overlay refuses `receiver` until it tracks logical receipts (S2c-ii), so every rtc or rtc-with-ws-fallback
 * recipe send that asks for receiver asks for hop by name, whichever carrier it starts on, and keeps reading hop
 * receipts. A ws recipe send keeps the logical receiver.
 */
function toCarrierAckQos(
    carrier: AlmConformanceCarrier,
    ack: AlmConformanceSendDelivery['ack']
): Pick<RallarBlackBoxTestMessagesSendCommand, 'qos'> {
    return ack === 'receiver' && carrier !== 'ws' ? { qos: { ack: { algo: 'hop' } } } : {};
}

/** The absence window plus the time a reloaded owner needs before it can submit. */
function toReloadSurvivalTtlMs(deadlineMs: number): number {
    return deadlineMs - RESPONSE_MARGIN_MS + RELOAD_RECOVERY_MARGIN_MS;
}

function toObserveCommand(observe: AlmConformanceObserveInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.observe',
        commandId: toCommandId(observe, `observe-${observe.state}-${observe.index}`),
        connection: observe.input.senderConnection,
        handleId: toSendHandleId(observe),
        state: observe.state === 'admitted' ? AL_DELIVERY_ADMITTED_STATES : [observe.state],
        timeoutMs: toBudgetMs(toObserveBudgetMs(observe.state), observe.input.deadlineMs)
    };
}

/** Expiry and carrier acceptance can outlast admission on a loaded runner. Other states are local. */
function toObserveBudgetMs(state: AlmConformanceObserveInput['state']): number {
    return state === 'expired' || state === 'acknowledged' || state === 'transport-accepted'
        ? NON_EXPIRING_SEND_TIMEOUT_MS
        : OBSERVE_TIMEOUT_BASE_MS + RESPONSE_MARGIN_MS;
}

/** A terminal wait also resolves for rejection or failure; the recipe must prove successful admission. */
function toAdmissionCommands(admission: AlmConformanceMessageStepInput): readonly RallarBlackBoxTestCommand[] {
    const observation = toObserveCommand({ ...admission, state: 'admitted' });
    return [
        observation,
        {
            kind: 'assert',
            commandId: toCommandId(admission, `assert-admitted-${admission.index}`),
            source: `resultCache.${observation.commandId}.value.state`,
            operator: 'matches',
            expected: '^(accepted|queued|transport-accepted|acknowledged)$',
            timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, admission.input.deadlineMs)
        }
    ];
}

function toCancelCommand(cancel: AlmConformanceMessageStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.cancel',
        commandId: toCommandId(cancel, `cancel-${cancel.index}`),
        connection: cancel.input.senderConnection,
        handleId: toSendHandleId(cancel),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, cancel.input.deadlineMs)
    };
}

function toReceiptsCommand(receipts: AlmConformanceMessageStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.receipts',
        commandId: toCommandId(receipts, `receipts-${receipts.index}`),
        connection: receipts.input.senderConnection,
        handleId: toSendHandleId(receipts),
        timeoutMs: toBudgetMs(MESSAGE_CONTROL_TIMEOUT_MS, receipts.input.deadlineMs)
    };
}

function toStorageCountersCommand(step: AlmConformanceStepInput, name: string): RallarBlackBoxTestCommand {
    return {
        kind: 'storage.counters',
        commandId: toCommandId(step, name),
        reset: false,
        timeoutMs: toBudgetMs(STORAGE_COUNTERS_TIMEOUT_MS, step.input.deadlineMs)
    };
}

/**
 * Pre-send evidence. A sender whose send exhausts its budget stops the recipe before the
 * post-receipts counters run, so this reading is the only IndexedDB operation count a timed-out
 * scenario leaves behind, and the pair brackets the operations one typed send spends.
 */
function toConnectedStorageCountersCommands(
    step: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return step.role === 'sender' ? [toStorageCountersCommand(step, 'storage-counters-connected')] : [];
}

/** The spec's own acceptance criterion: an admitted ALM send leaves AL-owned IndexedDB work behind. */
function toStorageCountersAssertCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'assert',
        commandId: toCommandId(step, 'assert-storage-counters-total'),
        source: `resultCache.${toCommandId(step, 'storage-counters')}.value.total`,
        operator: 'gt',
        expected: 0,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, step.input.deadlineMs)
    };
}

function toSendAssertCommand(assertion: AlmConformanceAssertInput): RallarBlackBoxTestCommand {
    const sendCommandId = toCommandId(assertion, `send-${assertion.index}`);
    return {
        kind: 'assert',
        commandId: toCommandId(assertion, `assert-${assertion.field}-${assertion.index}`),
        source: `resultCache.${sendCommandId}.value.${assertion.field}`,
        operator: assertion.operator,
        expected: assertion.expected,
        timeoutMs: toBudgetMs(ASSERT_TIMEOUT_MS, assertion.input.deadlineMs)
    };
}

/**
 * Positive observation starts before the sender's prologue, so it also owns the complete
 * non-expiring send budget. Absence proof retains the requested evidence deadline.
 */
function toReceivedCommand(received: AlmConformanceReceivedInput): RallarBlackBoxTestMessagesReceivedCommand {
    const timeoutMs = received.input.deadlineMs + (received.absent ? 0 : NON_EXPIRING_SEND_TIMEOUT_MS);
    return {
        kind: 'messages.received',
        commandId: toCommandId(received, `received-${received.index}`),
        connection: received.input.receiverConnection,
        typeId: toScenarioTypeId(received),
        count: received.count,
        absent: received.absent,
        windowMs: timeoutMs - RESPONSE_MARGIN_MS,
        timeoutMs
    };
}

function toFaultCommand(fault: AlmConformanceFaultInput): RallarBlackBoxTestCommand {
    const typeId = toScenarioTypeId(fault);
    return {
        kind: 'fault.inject',
        commandId: toCommandId(fault, `fault-${fault.faultCarrier}`),
        faultId: `drop-${fault.faultCarrier}-${typeId}`,
        carrier: fault.faultCarrier,
        match: { typeId },
        action: 'drop',
        remaining: FAULT_REMAINING,
        timeoutMs: toBudgetMs(FAULT_TIMEOUT_MS, fault.input.deadlineMs)
    };
}

function toStatsCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    return {
        kind: 'stats',
        commandId: toCommandId(step, 'stats'),
        timeoutMs: toBudgetMs(STATS_TIMEOUT_MS, step.input.deadlineMs)
    };
}

function toFaultCarriers(
    carrier: AlmConformanceCarrier
): readonly AlmConformanceFaultCarrier[] {
    return carrier === 'rtc-with-ws-fallback' ? ['rtc', 'ws'] : [carrier];
}

function toScenarioTypeId(step: AlmConformanceStepInput): string {
    return `${step.input.typeId}.${step.input.carrier}.${step.scenarioKey}`;
}

function toCommandId(step: AlmConformanceStepInput, name: string): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-${step.role}-${name}`;
}

function toSendHandleId(step: AlmConformanceMessageStepInput): string {
    return `alm-${step.input.carrier}-${step.scenarioKey}-send-${step.index}`;
}

function toEnsureRequestId(
    step: AlmConformanceStepInput,
    operation: 'group' | 'member'
): string {
    return `alm-conformance-{runtimeIdentity}-${step.input.carrier}-${step.scenarioKey}` +
        `-${step.role}-${operation}`;
}

function toConnectionName(step: AlmConformanceStepInput): string {
    return step.role === 'sender' ? step.input.senderConnection : step.input.receiverConnection;
}

function toStatePrefix(group: RallarBlackBoxDistributedGroupRef): string {
    return `/api/state/apps/${group.applicationId}/workspaces/${group.workspaceId}`;
}

function toRoomRef(group: RallarBlackBoxDistributedGroupRef): RallarBlackBoxTestRecord {
    return {
        applicationId: group.applicationId,
        workspaceId: group.workspaceId,
        groupId: group.groupId
    };
}

function toBudgetMs(desiredMs: number, deadlineMs: number): number {
    return Math.min(desiredMs, deadlineMs);
}
