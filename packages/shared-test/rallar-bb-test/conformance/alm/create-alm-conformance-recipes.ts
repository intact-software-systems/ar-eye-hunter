import type { RallarBlackBoxDistributedGroupRef } from '../../distributed-run.ts';
import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestJsonValue,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../../types.ts';

import type { AlmConformanceCarrier } from './alm-conformance-carriers.ts';

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
        | 'deadline-expiry'
        | 'delivery-baseline'
        | 'ordering-resync';
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    readonly tags: readonly ('smoke' | 'full')[];
}

type AlmConformanceRole = 'sender' | 'receiver';

type AlmConformanceFaultCarrier = 'ws' | 'rtc';

interface AlmConformanceStepInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly scenarioId: AlmConformanceScenario['scenarioId'];
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
    readonly reliability?: 'at-least-once';
    readonly orderingKey?: string;
    readonly seq?: number;
}

interface AlmConformanceSendInput extends AlmConformanceMessageStepInput {
    readonly payload: RallarBlackBoxTestJsonValue;
    readonly delivery: AlmConformanceSendDelivery;
}

interface AlmConformanceObserveInput extends AlmConformanceMessageStepInput {
    readonly state: 'accepted' | 'rejected';
}

interface AlmConformanceAssertInput extends AlmConformanceMessageStepInput {
    readonly field: 'status' | 'reason';
    readonly operator: 'equals' | 'contains';
    readonly expected: string;
}

interface AlmConformanceReceivedInput extends AlmConformanceMessageStepInput {
    readonly count: number;
    readonly absent: boolean;
    readonly windowMs: number;
}

interface AlmConformanceFaultInput extends AlmConformanceStepInput {
    readonly faultCarrier: AlmConformanceFaultCarrier;
}

const SMOKE_TAGS: readonly ('smoke' | 'full')[] = ['smoke', 'full'];
const FULL_TAGS: readonly ('smoke' | 'full')[] = ['full'];

const ENSURE_TIMEOUT_MS = 5_000;
const CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_READINESS_TIMEOUT_MS = 10_000;
const CONNECT_READINESS_INTERVAL_MS = 100;
const SEND_TIMEOUT_MS = 5_000;
const FAULT_TIMEOUT_MS = 3_000;
const ASSERT_TIMEOUT_MS = 2_000;
const STATS_TIMEOUT_MS = 3_000;
const RESPONSE_MARGIN_MS = 1_000;
const OBSERVE_WINDOW_MS = 2_000;
const RECEIVE_WINDOW_MS = 2_000;
const EXPIRY_RECEIVE_WINDOW_MS = 2_500;

const OVERSIZED_PAYLOAD_BYTES = 70_000;
const OVERSIZED_PAYLOAD_FILLER = 'x'.repeat(OVERSIZED_PAYLOAD_BYTES);
const OVERSIZED_REJECTION_REASON = 'Payload exceeds';
const EXPIRY_TTL_MS = 1_000;
const FAULT_REMAINING = 100;
const RESYNC_GAP_SEQ = 300;

export function createAlmConformanceRecipes(
    input: CreateAlmConformanceRecipesInput
): readonly AlmConformanceScenario[] {
    return [
        toBoundedRejectionScenario(input),
        toDeadlineExpiryScenario(input),
        toDeliveryBaselineScenario(input),
        toOrderingResyncScenario(input)
    ];
}

function toBoundedRejectionScenario(
    input: CreateAlmConformanceRecipesInput
): AlmConformanceScenario {
    const scenarioId = 'bounded-rejection';
    const sender: AlmConformanceStepInput = { input, scenarioId, role: 'sender' };
    const receiver: AlmConformanceStepInput = { input, scenarioId, role: 'receiver' };
    return {
        scenarioId,
        tags: SMOKE_TAGS,
        sender: toAlmConformanceRecipe({
            ...sender,
            commands: toBoundedRejectionSenderCommands(sender)
        }),
        receiver: toAlmConformanceRecipe({
            ...receiver,
            commands: [toReceivedCommand({
                ...receiver,
                index: 1,
                count: 1,
                absent: true,
                windowMs: RECEIVE_WINDOW_MS
            })]
        })
    };
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
        toObserveCommand({ ...sender, index: 1, state: 'rejected' })
    ];
}

function toDeadlineExpiryScenario(
    input: CreateAlmConformanceRecipesInput
): AlmConformanceScenario {
    const scenarioId = 'deadline-expiry';
    const sender: AlmConformanceStepInput = { input, scenarioId, role: 'sender' };
    const receiver: AlmConformanceStepInput = { input, scenarioId, role: 'receiver' };
    return {
        scenarioId,
        tags: FULL_TAGS,
        sender: toAlmConformanceRecipe({
            ...sender,
            commands: toDeadlineExpirySenderCommands(sender)
        }),
        receiver: toAlmConformanceRecipe({
            ...receiver,
            commands: [toReceivedCommand({
                ...receiver,
                index: 1,
                count: 1,
                absent: true,
                windowMs: EXPIRY_RECEIVE_WINDOW_MS
            })]
        })
    };
}

function toDeadlineExpirySenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        ...toFaultCarriers(sender.input.carrier).map((faultCarrier) => toFaultCommand({ ...sender, faultCarrier })),
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId },
            delivery: { ttlMs: EXPIRY_TTL_MS }
        }),
        toObserveCommand({ ...sender, index: 1, state: 'accepted' })
    ];
}

function toDeliveryBaselineScenario(
    input: CreateAlmConformanceRecipesInput
): AlmConformanceScenario {
    const scenarioId = 'delivery-baseline';
    const sender: AlmConformanceStepInput = { input, scenarioId, role: 'sender' };
    const receiver: AlmConformanceStepInput = { input, scenarioId, role: 'receiver' };
    return {
        scenarioId,
        tags: SMOKE_TAGS,
        sender: toAlmConformanceRecipe({
            ...sender,
            commands: [
                toSendCommand({
                    ...sender,
                    index: 1,
                    payload: { marker: scenarioId },
                    delivery: {}
                }),
                toObserveCommand({ ...sender, index: 1, state: 'accepted' })
            ]
        }),
        receiver: toAlmConformanceRecipe({
            ...receiver,
            commands: [toReceivedCommand({
                ...receiver,
                index: 1,
                count: 1,
                absent: false,
                windowMs: RECEIVE_WINDOW_MS
            })]
        })
    };
}

function toOrderingResyncScenario(
    input: CreateAlmConformanceRecipesInput
): AlmConformanceScenario {
    const scenarioId = 'ordering-resync';
    const sender: AlmConformanceStepInput = { input, scenarioId, role: 'sender' };
    const receiver: AlmConformanceStepInput = { input, scenarioId, role: 'receiver' };
    return {
        scenarioId,
        tags: FULL_TAGS,
        sender: toAlmConformanceRecipe({
            ...sender,
            commands: toOrderingResyncSenderCommands(sender)
        }),
        receiver: toAlmConformanceRecipe({
            ...receiver,
            commands: toOrderingResyncReceiverCommands(receiver)
        })
    };
}

function toOrderingResyncSenderCommands(
    sender: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    const orderingKey = `alm-${sender.input.carrier}-${sender.scenarioId}`;
    return [
        toSendCommand({
            ...sender,
            index: 1,
            payload: { marker: sender.scenarioId, seq: 1 },
            delivery: { reliability: 'at-least-once', orderingKey, seq: 1 }
        }),
        toObserveCommand({ ...sender, index: 1, state: 'accepted' }),
        toSendCommand({
            ...sender,
            index: 2,
            payload: { marker: sender.scenarioId, seq: RESYNC_GAP_SEQ },
            delivery: { reliability: 'at-least-once', orderingKey, seq: RESYNC_GAP_SEQ }
        }),
        toObserveCommand({ ...sender, index: 2, state: 'accepted' })
    ];
}

function toOrderingResyncReceiverCommands(
    receiver: AlmConformanceStepInput
): readonly RallarBlackBoxTestCommand[] {
    return [
        toReceivedCommand({
            ...receiver,
            index: 1,
            count: 1,
            absent: false,
            windowMs: RECEIVE_WINDOW_MS
        }),
        toReceivedCommand({
            ...receiver,
            index: 2,
            count: 2,
            absent: true,
            windowMs: RECEIVE_WINDOW_MS
        })
    ];
}

function toAlmConformanceRecipe(recipe: AlmConformanceRecipeInput): RallarBlackBoxTestRecipe {
    const carrier = recipe.input.carrier;
    return {
        recipeId: `alm-${carrier}-${recipe.scenarioId}-${recipe.role}`,
        name: `ALM conformance ${recipe.scenarioId} ${recipe.role} over ${carrier}`,
        continueOnFailure: false,
        metadata: {
            profile: 'alm-conformance',
            carrier,
            scenarioId: recipe.scenarioId,
            group: toRoomRef(recipe.input.group)
        },
        commands: [
            toEnsureGroupCommand(recipe),
            toEnsureMemberCommand(recipe),
            toConnectCommand(recipe),
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

function toConnectCommand(step: AlmConformanceStepInput): RallarBlackBoxTestCommand {
    const input = step.input;
    return {
        kind: 'rtc.connect',
        commandId: toCommandId(step, 'connect'),
        connection: toConnectionName(step),
        actor: '{auth.clientId}',
        roomId: input.group.groupId,
        applicationId: input.group.applicationId,
        workspaceId: input.group.workspaceId,
        roomRef: toRoomRef(input.group),
        transport: 'realtime',
        timeoutMs: toBudgetMs(CONNECT_TIMEOUT_MS, input.deadlineMs),
        ...(input.carrier === 'ws' ? {} : {
            readiness: {
                minReadyPeers: 1,
                timeoutMs: toBudgetMs(CONNECT_READINESS_TIMEOUT_MS, input.deadlineMs),
                intervalMs: CONNECT_READINESS_INTERVAL_MS
            }
        })
    };
}

function toSendCommand(send: AlmConformanceSendInput): RallarBlackBoxTestCommand {
    const input = send.input;
    return {
        kind: 'messages.send',
        commandId: toCommandId(send, `send-${send.index}`),
        connection: input.senderConnection,
        carrier: input.carrier,
        typeId: input.typeId,
        payload: send.payload,
        handleId: toSendHandleId(send),
        timeoutMs: toBudgetMs(SEND_TIMEOUT_MS, input.deadlineMs),
        ...(input.carrier === 'ws' ? {} : { roomRef: toRoomRef(input.group) }),
        ...send.delivery
    };
}

function toObserveCommand(observe: AlmConformanceObserveInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.observe',
        commandId: toCommandId(observe, `observe-${observe.index}`),
        connection: observe.input.senderConnection,
        handleId: toSendHandleId(observe),
        state: [observe.state],
        timeoutMs: toBudgetMs(
            OBSERVE_WINDOW_MS + RESPONSE_MARGIN_MS,
            observe.input.deadlineMs
        )
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

function toReceivedCommand(received: AlmConformanceReceivedInput): RallarBlackBoxTestCommand {
    return {
        kind: 'messages.received',
        commandId: toCommandId(received, `received-${received.index}`),
        connection: received.input.receiverConnection,
        typeId: received.input.typeId,
        count: received.count,
        absent: received.absent,
        windowMs: received.windowMs,
        timeoutMs: toBudgetMs(
            received.windowMs + RESPONSE_MARGIN_MS,
            received.input.deadlineMs
        )
    };
}

function toFaultCommand(fault: AlmConformanceFaultInput): RallarBlackBoxTestCommand {
    const typeId = fault.input.typeId;
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

function toCommandId(step: AlmConformanceStepInput, name: string): string {
    return `alm-${step.input.carrier}-${step.scenarioId}-${step.role}-${name}`;
}

function toSendHandleId(step: AlmConformanceMessageStepInput): string {
    return `alm-${step.input.carrier}-${step.scenarioId}-send-${step.index}`;
}

function toEnsureRequestId(
    step: AlmConformanceStepInput,
    operation: 'group' | 'member'
): string {
    return `alm-conformance-{runId}-${step.input.carrier}-${step.scenarioId}` +
        `-${step.role}-${operation}-{runtimeIdentity}`;
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
