import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe,
    RallarBlackBoxTestRecord
} from '../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    RESPONSE_MARGIN_MS
} from './alm-conformance-budgets.ts';
import { FAULT_TIMEOUT_MS } from './alm-conformance-fault-commands.ts';
import type { AlmConformanceReceiptRoles } from './alm-conformance-receipt-commands.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type {
    AlmConformanceContinuationDefinition,
    AlmConformanceLaneFamily,
    AlmConformanceMessages,
    AlmConformanceOwnerEnd,
    AlmConformanceRecipeGate,
    AlmConformanceRoomTopology,
    AlmConformanceScenarioDefinition,
    AlmConformanceScenarioId,
    AlmConformanceStepInput,
    AlmConformanceTag,
    CreateAlmConformanceRecipesInput
} from './alm-conformance-scenario-definition.ts';
import { toStatsCommand } from './alm-conformance-session-commands.ts';
import {
    toCommandId,
    toRoomRef,
    toSendHandleId
} from './alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';
import {
    toAlmConformanceCellParts,
    type AlmConformanceCellParts,
    type AlmConformanceCellPartsInput
} from './cell/alm-conformance-cell-parts.ts';
import { toAlmCellCommandPrefix } from './cell/to-alm-cell-command-prefix.ts';
import { toAlmCellSettledBody } from './cell/to-alm-cell-settled-body.ts';
import { toCellHistoryMarkedCommands } from './cell/to-cell-history-marked-commands.ts';
import { resolveAlmConformancePrincipals } from './resolve-alm-conformance-principals.ts';
import { fixedListDelivery } from './scenarios/audiences/fixed-list-delivery.ts';
import { principalDelivery } from './scenarios/audiences/principal-delivery.ts';
import { worldRouting } from './scenarios/audiences/world-routing.ts';
import { boundedRejection } from './scenarios/bounded-rejection.ts';
import { claimExpiresReclaims } from './scenarios/claim/claim-expires-reclaims.ts';
import { claimFirstWins } from './scenarios/claim/claim-first-wins.ts';
import { claimRefusedOnRtc } from './scenarios/claim/claim-refused-on-rtc.ts';
import { backpressureDeferred } from './scenarios/congestion/backpressure-deferred.ts';
import { backpressureHandsOver } from './scenarios/congestion/backpressure-hands-over.ts';
import { backpressureRefused } from './scenarios/congestion/backpressure-refused.ts';
import { crossCarrierDuplicate } from './scenarios/cross-carrier-duplicate.ts';
import { deadlineExpiry } from './scenarios/deadline-expiry.ts';
import { deliveryBaseline } from './scenarios/delivery-baseline.ts';
import { deliveryLifecycle } from './scenarios/delivery-lifecycle.ts';
import { deliveryReload } from './scenarios/delivery-reload.ts';
import { durableOptIn } from './scenarios/durable-opt-in.ts';
import { durableTakeover } from './scenarios/durable-takeover.ts';
import { bufferedTrackDrains } from './scenarios/fairness/buffered-track-drains.ts';
import { churnBoundedTracks } from './scenarios/fairness/churn-bounded-tracks.ts';
import { ownShareUnderInbound } from './scenarios/fairness/own-share-under-inbound.ts';
import { fallbackWithinDeadline } from './scenarios/fallback-within-deadline.ts';
import { grantedRtcDelivered } from './scenarios/granted-rtc/granted-rtc-delivered.ts';
import { grantedRtcForgedSender } from './scenarios/granted-rtc/granted-rtc-forged-sender.ts';
import { grantedRtcListDelivered } from './scenarios/granted-rtc/granted-rtc-list-delivered.ts';
import { grantedRtcListLaneRoles } from './scenarios/granted-rtc/granted-rtc-list-lane-roles.ts';
import { grantedRtcListNonHolder } from './scenarios/granted-rtc/granted-rtc-list-non-holder.ts';
import { grantedRtcMissingProof } from './scenarios/granted-rtc/granted-rtc-missing-proof.ts';
import { grantedRtcNotSubscribed } from './scenarios/granted-rtc/granted-rtc-not-subscribed.ts';
import { grantedRtcOrderedRelay } from './scenarios/granted-rtc/granted-rtc-ordered-relay.ts';
import { grantedRtcPrincipalDelivered } from './scenarios/granted-rtc/granted-rtc-principal-delivered.ts';
import { grantedRtcPublishRefused } from './scenarios/granted-rtc/granted-rtc-publish-refused.ts';
import { grantedRtcReceiptedDelivered } from './scenarios/granted-rtc/granted-rtc-receipted-delivered.ts';
import { grantedRtcRelayOnly } from './scenarios/granted-rtc/granted-rtc-relay-only.ts';
import { grantedRtcRevokedPublisher } from './scenarios/granted-rtc/granted-rtc-revoked-publisher.ts';
import { grantedRtcUnicastDelivered } from './scenarios/granted-rtc/granted-rtc-unicast-delivered.ts';
import { leaderConfirms } from './scenarios/leader-ack/leader-confirms.ts';
import { leaderOutsideList } from './scenarios/leader-ack/leader-outside-list.ts';
import { noLeaderRefused } from './scenarios/leader-ack/no-leader-refused.ts';
import { checkpointLag } from './scenarios/local-checkpoint/checkpoint-lag.ts';
import { checkpointRecovery } from './scenarios/local-checkpoint/checkpoint-recovery.ts';
import { flushOnHide } from './scenarios/local-checkpoint/flush-on-hide.ts';
import { fencedCatchUp } from './scenarios/membership-fence/fenced-catch-up.ts';
import { fencedDelivery } from './scenarios/membership-fence/fenced-delivery.ts';
import { fencedRejection } from './scenarios/membership-fence/fenced-rejection.ts';
import { noFallbackAfterDeadline } from './scenarios/no-fallback-after-deadline.ts';
import { notYetInSync } from './scenarios/not-yet-in-sync.ts';
import { orderingResync } from './scenarios/ordering-resync.ts';
import { pacedCancel } from './scenarios/publication/paced-cancel.ts';
import { pacedCapacity } from './scenarios/publication/paced-capacity.ts';
import { pacedExpiry } from './scenarios/publication/paced-expiry.ts';
import { pacedFairness } from './scenarios/publication/paced-fairness.ts';
import { pacedIsolationLists } from './scenarios/publication/paced-isolation-lists.ts';
import { pacedIsolationResources } from './scenarios/publication/paced-isolation-resources.ts';
import { pacedLatest } from './scenarios/publication/paced-latest.ts';
import { pacedNewestN } from './scenarios/publication/paced-newest-n.ts';
import { orderingGapRepair } from './scenarios/range-repair/ordering-gap-repair.ts';
import { repairExhausted } from './scenarios/range-repair/repair-exhausted.ts';
import { receiptExhaustedFallback } from './scenarios/receipt-exhausted-fallback.ts';
import { receiptedAudience } from './scenarios/receipted-audience.ts';
import { receiptedRelayPath } from './scenarios/relay-path/receipted-relay-path.ts';
import { replyCorrelated } from './scenarios/reply/reply-correlated.ts';
import { replyFirstWins } from './scenarios/reply/reply-first-wins.ts';
import { replyTimeoutLate } from './scenarios/reply/reply-timeout-late.ts';
import { replyUndelivered } from './scenarios/reply/reply-undelivered.ts';
import { serverCommand } from './scenarios/server-command.ts';
import { serverOrderedEntry } from './scenarios/server-ordered-entry.ts';
import { serverOriginated } from './scenarios/server-originated.ts';
import { storageUnavailable } from './scenarios/storage-unavailable.ts';
import { subscriptionDelivery } from './scenarios/topic-subscription/subscription-delivery.ts';
import { subscriptionOrderedEntry } from './scenarios/topic-subscription/subscription-ordered-entry.ts';
import { subscriptionOrderedOmission } from './scenarios/topic-subscription/subscription-ordered-omission.ts';
import { subscriptionOrderedReconnect } from './scenarios/topic-subscription/subscription-ordered-reconnect.ts';
import { subscriptionRevokeDisconnected } from './scenarios/topic-subscription/subscription-revoke-disconnected.ts';
import { subscriptionSuccessor } from './scenarios/topic-subscription/subscription-successor.ts';
import { subscriptionTokenCount } from './scenarios/topic-subscription/subscription-token-count.ts';
import { unicastFallback } from './scenarios/unicast-fallback.ts';
import { capacityAge } from './scenarios/volatile-bound/capacity-age.ts';
import { capacityTracks } from './scenarios/volatile-bound/capacity-tracks.ts';
import { capacity } from './scenarios/volatile-bound/capacity.ts';
import { volatileDefault } from './scenarios/volatile-default.ts';
import { wsUnicastReceipt } from './scenarios/ws-unicast-receipt.ts';

export interface AlmConformanceScenario {
    readonly scenarioId: AlmConformanceScenarioId;
    /** Every recipe, command, handle and type id the pair mints derives from it; distinct per recipe pair. */
    readonly scenarioKey: string;
    readonly roles: readonly AlmConformanceRole[];
    readonly laneFamily: AlmConformanceLaneFamily;
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    /** The second recipient's recipe; undefined exactly when `roles` does not declare `recipient-b`. */
    readonly recipientB: RallarBlackBoxTestRecipe | undefined;
    /** The sender's second page's recipe; undefined exactly when `roles` does not declare `successor`. */
    readonly successor: RallarBlackBoxTestRecipe | undefined;
    /** The second session of the sender's principal; undefined exactly when `roles` does not declare `sibling`. */
    readonly sibling: RallarBlackBoxTestRecipe | undefined;
    /** The second producer's recipe; undefined exactly when `roles` does not declare `publisher-b`. */
    readonly publisherB: RallarBlackBoxTestRecipe | undefined;
    /**
     * Each declared role's recipe in its parts, so a combined recipe shares one prologue and runs each body. A role
     * recipe of a `barriered` cell also holds its cell's barriers: one after its prologue, one after its arming run.
     */
    readonly partsByRole: Readonly<Partial<Record<AlmConformanceRole, AlmConformanceCellParts>>>;
    readonly tags: readonly AlmConformanceTag[];
    /** The owner's command after which the lane starts the successor; undefined starts it once the owner page ended. */
    readonly successorGate: AlmConformanceScenarioGate | undefined;
    /** How the lane ends the owner page before its successor runs; undefined exactly when `roles` declares no successor. */
    readonly ownerEnd: AlmConformanceOwnerEnd | undefined;
    /** Whether the cell reshapes its room's topology; the lane plan orders a shared room by it. */
    readonly roomTopology: AlmConformanceRoomTopology;
    /** One role's later recipe; undefined when every role runs one. */
    readonly continuation: AlmConformanceContinuation | undefined;
}

/** A command of `role`'s recipe, after which the lane starts a recipe it holds back. */
export interface AlmConformanceScenarioGate {
    readonly role: AlmConformanceRole;
    readonly commandId: string;
}

/**
 * A recipe the lane starts on `role`'s agent, on its open connection, once that role's first recipe ended and the
 * gate's command passed.
 */
export interface AlmConformanceContinuation {
    readonly role: AlmConformanceRole;
    readonly gate: AlmConformanceScenarioGate;
    readonly recipe: RallarBlackBoxTestRecipe;
}

interface AlmRecipeDiagnosticSelection {
    readonly almDiagnostics: boolean;
    readonly deliveryDiagnostics: boolean;
}

interface AlmConformanceRecipeInput extends AlmConformanceCellPartsInput {
    /** Set only on the sender of a scenario that pins its receipt identity. */
    readonly receiptRoles: AlmConformanceReceiptRoles | undefined;
    /** Set on both roles of a scenario whose sender reloads its page. */
    readonly reloadCheckpoint: AlmReloadCheckpoint | undefined;
    /** Set only on the sender of a scenario at least one of whose origins must relay its send. */
    readonly relayedReceiptOrigins: readonly AlmConformanceRole[] | undefined;
    /** Set only on the sender of a scenario none of whose receipts may confirm that role. */
    readonly unconfirmedReceiptRole: AlmConformanceRole | undefined;
}

interface AlmConformanceRoleCell {
    readonly recipe: RallarBlackBoxTestRecipe;
    readonly parts: AlmConformanceCellParts;
}

/** RTC-with-WS-fallback injects one fault per carrier before starting the expiring send. */
const MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS = FAULT_TIMEOUT_MS * 2;
/** The absence window must contain pre-send faults, the message lifetime, and post-expiry proof. */
const MINIMUM_DEADLINE_MS = MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS +
    EXPIRY_TTL_MS +
    MINIMUM_POST_EXPIRY_OBSERVATION_MS +
    RESPONSE_MARGIN_MS;

/**
 * `volatileDefault` is declared first. Its storage window opens with a reset, so only durable work an earlier cell
 * left on a timer inside that window could count against its zero; a shuffled lane order or the hosted combined
 * recipe, which hoists every `delivery-reload` ahead of it, may expose that.
 */
const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
    volatileDefault,
    boundedRejection,
    deadlineExpiry,
    deliveryBaseline,
    deliveryLifecycle,
    durableOptIn,
    deliveryReload,
    storageUnavailable,
    checkpointRecovery,
    checkpointLag,
    orderingResync,
    orderingGapRepair,
    repairExhausted,
    ...crossCarrierDuplicate,
    notYetInSync,
    fallbackWithinDeadline,
    receiptExhaustedFallback,
    noFallbackAfterDeadline,
    wsUnicastReceipt,
    unicastFallback,
    serverCommand,
    serverOriginated,
    serverOrderedEntry,
    capacity,
    capacityAge,
    capacityTracks,
    replyCorrelated,
    replyTimeoutLate,
    replyUndelivered,
    pacedLatest,
    pacedNewestN,
    pacedExpiry,
    pacedCapacity,
    pacedFairness,
    pacedCancel,
    pacedIsolationResources,
    pacedIsolationLists,
    grantedRtcDelivered,
    grantedRtcMissingProof,
    grantedRtcPublishRefused,
    grantedRtcReceiptedDelivered,
    grantedRtcRevokedPublisher,
    grantedRtcUnicastDelivered,
    backpressureHandsOver,
    backpressureRefused,
    backpressureDeferred,
    ownShareUnderInbound,
    bufferedTrackDrains,
    churnBoundedTracks,
    ...receiptedAudience,
    fencedDelivery,
    fencedCatchUp,
    fencedRejection,
    principalDelivery,
    fixedListDelivery,
    worldRouting,
    grantedRtcPrincipalDelivered,
    leaderConfirms,
    noLeaderRefused,
    leaderOutsideList,
    claimFirstWins,
    claimExpiresReclaims,
    claimRefusedOnRtc,
    replyFirstWins,
    durableTakeover,
    flushOnHide,
    subscriptionDelivery,
    subscriptionTokenCount,
    subscriptionRevokeDisconnected,
    subscriptionOrderedEntry,
    subscriptionOrderedOmission,
    subscriptionOrderedReconnect,
    subscriptionSuccessor,
    grantedRtcForgedSender,
    grantedRtcNotSubscribed,
    grantedRtcListDelivered,
    grantedRtcListNonHolder,
    grantedRtcListLaneRoles,
    receiptedRelayPath,
    grantedRtcRelayOnly,
    grantedRtcOrderedRelay
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
        .filter((definition) =>
            definition.carriers.includes(input.carrier) && input.laneFamilies.includes(definition.laneFamily) &&
            (definition.principalRoles ?? []).every((role) => input.principalIdsByRole[role] !== undefined)
        )
        .map((definition) =>
            toAlmConformanceScenario(input, definition, { almDiagnostics: true, deliveryDiagnostics: false })
        );
}

/** Independent pages own the entire diagnostic history of each specialised delivery run. */
export function createAlmDeliveryDiagnosticsRecipes(
    input: CreateAlmConformanceRecipesInput,
    almDiagnostics: boolean
): AlmConformanceScenario {
    return toAlmConformanceScenario(input, {
        ...deliveryBaseline,
        scenarioKey: almDiagnostics ? 'delivery-diagnostics-on' : 'delivery-diagnostics-off'
    }, { almDiagnostics, deliveryDiagnostics: true });
}

export function toAlmConformanceRoleRecipe(
    scenario: AlmConformanceScenario,
    role: AlmConformanceRole
): RallarBlackBoxTestRecipe | undefined {
    switch (role) {
        case 'recipient-b':
            return scenario.recipientB;
        case 'publisher-b':
            return scenario.publisherB;
        default:
            return scenario[role];
    }
}

function toAlmConformanceScenario(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition,
    diagnostics: AlmRecipeDiagnosticSelection
): AlmConformanceScenario {
    const cells = toRoleCells(input, definition, diagnostics);
    const toDeclaredRecipe = (role: AlmConformanceRole) => cells.get(role)?.recipe;
    const scenario: AlmConformanceScenario = {
        scenarioId: definition.scenarioId,
        scenarioKey: definition.scenarioKey,
        roles: definition.roles,
        laneFamily: definition.laneFamily,
        tags: definition.tags,
        sender: toRequiredRecipe(definition, toDeclaredRecipe('sender')),
        receiver: toRequiredRecipe(definition, toDeclaredRecipe('receiver')),
        recipientB: toDeclaredRecipe('recipient-b'),
        successor: toDeclaredRecipe('successor'),
        sibling: toDeclaredRecipe('sibling'),
        publisherB: toDeclaredRecipe('publisher-b'),
        partsByRole: Object.fromEntries([...cells].map(([role, cell]) => [role, cell.parts])),
        successorGate: undefined,
        ownerEnd: definition.roles.includes('successor') ? definition.ownerEnd ?? 'close' : undefined,
        roomTopology: definition.roomTopology ?? 'kept',
        continuation: undefined
    };
    return { ...scenario, ...toHeldBackRecipes(input, definition, scenario) };
}

function toRequiredRecipe(
    definition: AlmConformanceScenarioDefinition,
    recipe: RallarBlackBoxTestRecipe | undefined
): RallarBlackBoxTestRecipe {
    if (recipe === undefined) {
        throw new Error(`${definition.scenarioKey} must declare both the sender and the receiver.`);
    }
    return recipe;
}

/** The recipes the lane holds back until a command of a role recipe passed: the successor, and a continuation. */
function toHeldBackRecipes(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition,
    scenario: AlmConformanceScenario
): Pick<AlmConformanceScenario, 'successorGate' | 'continuation'> {
    const toGate = (gate: AlmConformanceRecipeGate) => toScenarioGate({ input, definition, scenario, gate });
    return {
        successorGate: definition.successorGate && toGate(definition.successorGate),
        continuation: definition.continuation && {
            role: definition.continuation.role,
            gate: toGate(definition.continuation.gate),
            recipe: toContinuationRecipe(input, definition, definition.continuation)
        }
    };
}

function toStepInput(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition,
    role: AlmConformanceRole
): AlmConformanceStepInput {
    return {
        input,
        scenarioId: definition.scenarioId,
        scenarioKey: definition.scenarioKey,
        role,
        roles: definition.roles,
        messages: toDefinitionMessages(definition),
        connect: definition.connect
    };
}

function toDefinitionMessages(definition: AlmConformanceScenarioDefinition): AlmConformanceMessages {
    return definition.startGrants === undefined
        ? { messageSelector: definition.messageSelector, topic: definition.topic }
        : { messageSelector: definition.messageSelector, startGrants: definition.startGrants };
}

interface ToScenarioGateInput {
    readonly input: CreateAlmConformanceRecipesInput;
    readonly definition: AlmConformanceScenarioDefinition;
    /** The scenario's role recipes, one of which must hold the gate's command. */
    readonly scenario: AlmConformanceScenario;
    readonly gate: AlmConformanceRecipeGate;
}

/**
 * A gate names a command of its role's recipe; one that names none would hold its recipe back to the lane's timeout.
 */
function toScenarioGate(gateInput: ToScenarioGateInput): AlmConformanceScenarioGate {
    const { input, definition, scenario, gate } = gateInput;
    const commandId = toCommandId(toStepInput(input, definition, gate.role), gate.commandName);
    const recipe = toAlmConformanceRoleRecipe(scenario, gate.role);
    if (!recipe?.commands.some((command) => command.commandId === commandId)) {
        throw new Error(`${recipe?.recipeId ?? gate.role} names no ${commandId} command for its gate.`);
    }
    return { role: gate.role, commandId };
}

/**
 * The role's later steps run on the connection its first recipe opened, so the recipe carries no prologue; its own
 * stats read ends the recipe. Its waits read the cell's history, the role's first recipe included.
 */
function toContinuationRecipe(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition,
    continuation: AlmConformanceContinuationDefinition
): RallarBlackBoxTestRecipe {
    const step = toStepInput(input, definition, continuation.role);
    const recipe: RallarBlackBoxTestRecipe = {
        schemaVersion: 1,
        recipeId: `${toAlmCellCommandPrefix(input.carrier, definition.scenarioKey)}-${continuation.role}-continuation`,
        name: `ALM conformance ${definition.scenarioKey} ${continuation.role} continuation over ${input.carrier}`,
        continueOnFailure: false,
        metadata: {
            profile: 'alm-conformance',
            carrier: input.carrier,
            scenarioId: definition.scenarioId,
            group: toRoomRef(input.group)
        },
        commands: toCellHistoryMarkedCommands(step, [
            ...continuation.toCommands(step),
            toStatsCommand(step, 'continuation-stats')
        ])
    };
    return resolveAlmConformancePrincipals(recipe, input.principalIdsByRole);
}

/** Every declared role's cell; a role's settle reads the other roles' parts, so all parts come first. */
function toRoleCells(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition,
    diagnostics: AlmRecipeDiagnosticSelection
): ReadonlyMap<AlmConformanceRole, AlmConformanceRoleCell> {
    const recipeInputs = definition.roles.map((role) => {
        const step = toStepInput(input, definition, role);
        const commands = role === 'sender' || role === 'successor' || role === 'publisher-b'
            ? definition.toSenderCommands(step)
            : definition.toRecipientCommands(step);
        const recipeInput: AlmConformanceRecipeInput = {
            ...step,
            ...diagnostics,
            commands,
            receiptRoles: role === 'sender' ? definition.toReceiptRoles?.(input.carrier) : undefined,
            reloadCheckpoint: definition.toReloadCheckpoint?.(step),
            relayedReceiptOrigins: role === 'sender' ? definition.relayedReceiptOrigins : undefined,
            unconfirmedReceiptRole: role === 'sender' ? definition.unconfirmedReceiptRole : undefined
        };
        return { recipeInput, parts: toAlmConformanceCellParts(recipeInput) };
    });
    const partsByRole = new Map(recipeInputs.map(({ recipeInput, parts }) => [recipeInput.role, parts]));
    return new Map(recipeInputs.map(({ recipeInput, parts }) => [
        recipeInput.role,
        toRoleCell(recipeInput, parts, toAlmCellSettledBody(recipeInput, partsByRole))
    ]));
}

/** The role's recipe, its prologue then its settled body, and its parts, all with the role's principals resolved. */
function toRoleCell(
    recipeInput: AlmConformanceRecipeInput,
    parts: AlmConformanceCellParts,
    settledBody: readonly RallarBlackBoxTestCommand[]
): AlmConformanceRoleCell {
    const toResolvedRecipe = (commands: readonly RallarBlackBoxTestCommand[]) =>
        resolveAlmConformancePrincipals(
            toAlmConformanceRecipe(recipeInput, commands),
            recipeInput.input.principalIdsByRole
        );
    const recipe = toResolvedRecipe([...parts.prologue, ...settledBody]);
    const resolvedParts = toResolvedRecipe([...parts.prologue, ...parts.startState, ...parts.body]).commands;
    const startStateEnd = parts.prologue.length + parts.startState.length;
    return {
        recipe,
        parts: {
            prologue: resolvedParts.slice(0, parts.prologue.length),
            startState: resolvedParts.slice(parts.prologue.length, startStateEnd),
            body: resolvedParts.slice(startStateEnd)
        }
    };
}

function toAlmConformanceRecipe(
    recipe: AlmConformanceRecipeInput,
    commands: readonly RallarBlackBoxTestCommand[]
): RallarBlackBoxTestRecipe {
    const carrier = recipe.input.carrier;
    return {
        schemaVersion: 1,
        recipeId: `${toAlmCellCommandPrefix(carrier, recipe.scenarioKey)}-${recipe.role}`,
        name: recipe.deliveryDiagnostics
            ? `ALM delivery diagnostics ${recipe.almDiagnostics ? 'On' : 'Off'} ${recipe.role} over ${carrier}`
            : `ALM conformance ${recipe.scenarioKey} ${recipe.role} over ${carrier}`,
        continueOnFailure: false,
        metadata: toAlmConformanceRecipeMetadata(recipe),
        commands
    };
}

function toAlmConformanceRecipeMetadata(recipe: AlmConformanceRecipeInput): RallarBlackBoxTestRecord {
    return {
        profile: recipe.deliveryDiagnostics ? 'alm-delivery-diagnostics' : 'alm-conformance',
        ...(recipe.deliveryDiagnostics
            ? { almDiagnostics: recipe.almDiagnostics, freshRuntimeRequired: true }
            : {}),
        carrier: recipe.input.carrier,
        scenarioId: recipe.scenarioId,
        group: toRoomRef(recipe.input.group),
        ...(recipe.reloadCheckpoint === undefined
            ? {}
            : { almReloadCheckpoints: [{ ...recipe.reloadCheckpoint }] }),
        ...(recipe.receiptRoles === undefined
            ? {}
            : { almReceiptRoles: [toReceiptRolesMetadata(recipe, recipe.receiptRoles)] }),
        ...(recipe.relayedReceiptOrigins === undefined
            ? {}
            : { almRelayedReceiptOrigins: toRelayedReceiptOriginsMetadata(recipe, recipe.relayedReceiptOrigins) }),
        ...(recipe.unconfirmedReceiptRole === undefined
            ? {}
            : { almUnconfirmedReceiptRole: recipe.unconfirmedReceiptRole })
    };
}

/** Names the send whose receipt the roles describe, so a combined recipe carries one entry per scenario. */
function toReceiptRolesMetadata(
    step: AlmConformanceStepInput,
    roles: AlmConformanceReceiptRoles
): RallarBlackBoxTestRecord {
    return {
        handleId: toSendHandleId({ ...step, index: 1 }),
        confirmed: roles.confirmed,
        unconfirmed: roles.unconfirmed,
        outsideAudience: roles.outsideAudience
    };
}

/** Names the first send of each origin, the handle whose ending receipt shows whether that send was relayed. */
function toRelayedReceiptOriginsMetadata(
    step: AlmConformanceStepInput,
    origins: readonly AlmConformanceRole[]
): readonly RallarBlackBoxTestRecord[] {
    return origins.map((role) => ({ role, handleId: toSendHandleId({ ...step, role, index: 1 }) }));
}
