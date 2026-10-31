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
import { toStorageCountersCommand } from './alm-conformance-message-commands.ts';
import type { AlmConformanceReceiptRoles } from './alm-conformance-receipt-commands.ts';
import type { AlmConformanceRole } from './alm-conformance-roles.ts';
import type {
    AlmConformanceLaneFamily,
    AlmConformanceScenarioDefinition,
    AlmConformanceScenarioId,
    AlmConformanceStepInput,
    AlmConformanceTag,
    CreateAlmConformanceRecipesInput
} from './alm-conformance-scenario-definition.ts';
import {
    toConnectCommand,
    toEnsureGroupCommand,
    toSelfMembershipCommand,
    toStatsCommand
} from './alm-conformance-session-commands.ts';
import {
    toCommandId,
    toConnectionName,
    toRoomRef,
    toSendHandleId
} from './alm-conformance-step-identities.ts';
import type { AlmReloadCheckpoint } from './alm-reload-pair.ts';
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
import { replyCorrelated } from './scenarios/reply/reply-correlated.ts';
import { replyFirstWins } from './scenarios/reply/reply-first-wins.ts';
import { replyTimeoutLate } from './scenarios/reply/reply-timeout-late.ts';
import { replyUndelivered } from './scenarios/reply/reply-undelivered.ts';
import { serverCommand } from './scenarios/server-command.ts';
import { serverOriginated } from './scenarios/server-originated.ts';
import { storageUnavailable } from './scenarios/storage-unavailable.ts';
import { subscriptionDelivery } from './scenarios/topic-subscription/subscription-delivery.ts';
import { subscriptionReconnect } from './scenarios/topic-subscription/subscription-reconnect.ts';
import { subscriptionRevokeHeld } from './scenarios/topic-subscription/subscription-revoke-held.ts';
import { subscriptionSuccessor } from './scenarios/topic-subscription/subscription-successor.ts';
import { subscriptionTokenCount } from './scenarios/topic-subscription/subscription-token-count.ts';
import { unicastFallback } from './scenarios/unicast-fallback.ts';
import { capacityAge } from './scenarios/volatile-bound/capacity-age.ts';
import { capacityTracks } from './scenarios/volatile-bound/capacity-tracks.ts';
import { capacity } from './scenarios/volatile-bound/capacity.ts';
import { volatileDefault } from './scenarios/volatile-default.ts';
import { wsUnicastReceipt } from './scenarios/ws-unicast-receipt.ts';
import { toOwnerLeaseLapseWait } from './to-pause-command.ts';

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
    readonly tags: readonly AlmConformanceTag[];
}

interface AlmRecipeDiagnosticSelection {
    readonly almDiagnostics: boolean;
    readonly deliveryDiagnostics: boolean;
}

interface AlmConformanceRecipeInput extends AlmConformanceStepInput {
    readonly commands: readonly RallarBlackBoxTestCommand[];
    readonly almDiagnostics: boolean;
    readonly deliveryDiagnostics: boolean;
    /** Set only on the sender of a scenario that pins its receipt identity. */
    readonly receiptRoles: AlmConformanceReceiptRoles | undefined;
    /** Set on both roles of a scenario whose sender reloads its page. */
    readonly reloadCheckpoint: AlmReloadCheckpoint | undefined;
}

const ALM_DIAGNOSTIC_TOPICS = [
    'rallar.browser.alm.outbound_diagnostics',
    'rallar.browser.alm.inbound_diagnostics',
    'rallar.browser.alm.storage',
    'rallar.browser.alm.storage_reset'
];

/** RTC-with-WS-fallback injects one fault per carrier before starting the expiring send. */
const MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS = FAULT_TIMEOUT_MS * 2;
/** The absence window must contain pre-send faults, the message lifetime, and post-expiry proof. */
const MINIMUM_DEADLINE_MS = MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS +
    EXPIRY_TTL_MS +
    MINIMUM_POST_EXPIRY_OBSERVATION_MS +
    RESPONSE_MARGIN_MS;

/**
 * `volatileDefault` runs first on its pages, before any scenario leaves durable work there. The hosted
 * combined recipe hoists every `delivery-reload` ahead of it, so there it runs after durable work.
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
    subscriptionRevokeHeld,
    subscriptionReconnect,
    subscriptionSuccessor
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
            definition.carriers.includes(input.carrier) && input.laneFamilies.includes(definition.laneFamily)
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
    const toRoleRecipe = (role: AlmConformanceRole): RallarBlackBoxTestRecipe => {
        const step: AlmConformanceStepInput = {
            input,
            scenarioId: definition.scenarioId,
            scenarioKey: definition.scenarioKey,
            role,
            roles: definition.roles,
            messageSelector: definition.messageSelector
        };
        const commands = role === 'sender' || role === 'successor' || role === 'publisher-b'
            ? definition.toSenderCommands(step)
            : definition.toRecipientCommands(step);
        const receiptRoles = role === 'sender' ? definition.toReceiptRoles?.(input.carrier) : undefined;
        const reloadCheckpoint = definition.toReloadCheckpoint?.(step);
        return resolveAlmConformancePrincipals(
            toAlmConformanceRecipe({ ...step, ...diagnostics, commands, receiptRoles, reloadCheckpoint }),
            input.principalIdsByRole
        );
    };
    return {
        scenarioId: definition.scenarioId,
        scenarioKey: definition.scenarioKey,
        roles: definition.roles,
        laneFamily: definition.laneFamily,
        tags: definition.tags,
        sender: toRoleRecipe('sender'),
        receiver: toRoleRecipe('receiver'),
        recipientB: definition.roles.includes('recipient-b') ? toRoleRecipe('recipient-b') : undefined,
        successor: definition.roles.includes('successor') ? toRoleRecipe('successor') : undefined,
        sibling: definition.roles.includes('sibling') ? toRoleRecipe('sibling') : undefined,
        publisherB: definition.roles.includes('publisher-b') ? toRoleRecipe('publisher-b') : undefined
    };
}

function toAlmConformanceRecipe(recipe: AlmConformanceRecipeInput): RallarBlackBoxTestRecipe {
    const carrier = recipe.input.carrier;
    const connect = toConnectCommand(recipe);
    const profile = recipe.deliveryDiagnostics ? 'alm-delivery-diagnostics' : 'alm-conformance';
    return {
        schemaVersion: 1,
        recipeId: `alm-${carrier}-${recipe.scenarioKey}-${recipe.role}`,
        name: recipe.deliveryDiagnostics
            ? `ALM delivery diagnostics ${recipe.almDiagnostics ? 'On' : 'Off'} ${recipe.role} over ${carrier}`
            : `ALM conformance ${recipe.scenarioKey} ${recipe.role} over ${carrier}`,
        continueOnFailure: false,
        metadata: {
            profile,
            ...(recipe.deliveryDiagnostics
                ? { almDiagnostics: recipe.almDiagnostics, freshRuntimeRequired: true }
                : {}),
            carrier,
            scenarioId: recipe.scenarioId,
            group: toRoomRef(recipe.input.group),
            ...(recipe.reloadCheckpoint === undefined
                ? {}
                : { almReloadCheckpoints: [{ ...recipe.reloadCheckpoint }] }),
            ...(recipe.receiptRoles === undefined
                ? {}
                : { almReceiptRoles: [toReceiptRolesMetadata(recipe, recipe.receiptRoles)] })
        },
        commands: [
            ...(recipe.deliveryDiagnostics ? toFreshDiagnosticHistoryCommands(recipe) : []),
            toEnsureGroupCommand(recipe),
            toSelfMembershipCommand(recipe, 'active'),
            ...(recipe.role === 'successor' ? [toOwnerLeaseLapseWait(recipe)] : []),
            { ...connect, rallar: { ...connect.rallar, almDiagnostics: recipe.almDiagnostics } },
            ...(recipe.deliveryDiagnostics ? [toAppliedDiagnosticsWait(recipe)] : []),
            ...toConnectedStorageCountersCommands(recipe),
            ...recipe.commands,
            toStatsCommand(recipe, 'stats'),
            ...(recipe.deliveryDiagnostics ? toDeliveryDiagnosticEvidenceCommands(recipe) : [])
        ]
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
    return step.role === 'sender' ? [toStorageCountersCommand(step, 'storage-counters-connected', false)] : [];
}

/** Names the send whose receipt the roles describe, so a combined recipe carries one entry per scenario. */
function toReceiptRolesMetadata(
    step: AlmConformanceStepInput,
    roles: AlmConformanceReceiptRoles
): RallarBlackBoxTestRecord {
    return {
        handleId: toSendHandleId({ ...step, index: 1 }),
        confirmed: roles.confirmed,
        unconfirmed: roles.unconfirmed
    };
}

function toFreshDiagnosticHistoryCommands(step: AlmConformanceStepInput): readonly RallarBlackBoxTestCommand[] {
    return [...ALM_DIAGNOSTIC_TOPICS, 'rallar.browser.connect.phase_completed'].map((topic) => ({
        kind: 'wait',
        commandId: toCommandId(step, `fresh-${topic.split('.').at(-1)}`),
        match: { kind: 'diagnostic', topic },
        absent: true,
        timeoutMs: 0
    }));
}

function toAppliedDiagnosticsWait(recipe: AlmConformanceRecipeInput): RallarBlackBoxTestCommand {
    return {
        kind: 'wait',
        commandId: toCommandId(recipe, 'applied-diagnostics'),
        match: {
            kind: 'diagnostic',
            connection: toConnectionName(recipe),
            topic: 'rallar.browser.connect.phase_completed',
            payloadFields: { 'data.phase': 'rallar-connect', 'data.almDiagnostics': recipe.almDiagnostics }
        },
        timeoutMs: 0
    };
}

function toDeliveryDiagnosticEvidenceCommands(recipe: AlmConformanceRecipeInput): readonly RallarBlackBoxTestCommand[] {
    const topics = recipe.almDiagnostics
        ? [
            recipe.role === 'sender'
                ? 'rallar.browser.alm.outbound_diagnostics'
                : 'rallar.browser.alm.inbound_diagnostics'
        ]
        : ALM_DIAGNOSTIC_TOPICS;
    return topics.map((topic) => ({
        kind: 'wait',
        commandId: toCommandId(recipe, `diagnostic-${topic.split('.').at(-1)}`),
        match: { kind: 'diagnostic', topic },
        ...(recipe.almDiagnostics ? {} : { absent: true }),
        // Delivery and the receiver's authored negative-control window bound this already retained interval.
        timeoutMs: 0
    }));
}
