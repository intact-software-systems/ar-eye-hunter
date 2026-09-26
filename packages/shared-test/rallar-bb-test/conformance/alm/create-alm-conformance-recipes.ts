import type {
    RallarBlackBoxTestCommand,
    RallarBlackBoxTestRecipe
} from '../../rallar-black-box-test-contracts.ts';

import {
    EXPIRY_TTL_MS,
    MINIMUM_POST_EXPIRY_OBSERVATION_MS,
    RESPONSE_MARGIN_MS
} from './alm-conformance-budgets.ts';
import { FAULT_TIMEOUT_MS } from './alm-conformance-fault-commands.ts';
import { toStorageCountersCommand } from './alm-conformance-message-commands.ts';
import type {
    AlmConformanceScenarioDefinition,
    AlmConformanceScenarioId,
    AlmConformanceStepInput,
    AlmConformanceTag,
    CreateAlmConformanceRecipesInput
} from './alm-conformance-scenario-definition.ts';
import {
    toConnectCommand,
    toEnsureGroupCommand,
    toEnsureMemberCommand,
    toStatsCommand
} from './alm-conformance-session-commands.ts';
import { toRoomRef } from './alm-conformance-step-identities.ts';
import { boundedRejection } from './scenarios/bounded-rejection.ts';
import { crossCarrierDuplicate } from './scenarios/cross-carrier-duplicate.ts';
import { deadlineExpiry } from './scenarios/deadline-expiry.ts';
import { deliveryBaseline } from './scenarios/delivery-baseline.ts';
import { deliveryLifecycle } from './scenarios/delivery-lifecycle.ts';
import { deliveryReload, toReloadCheckpoint } from './scenarios/delivery-reload.ts';
import { notYetInSync } from './scenarios/not-yet-in-sync.ts';
import { orderingResync } from './scenarios/ordering-resync.ts';

export interface AlmConformanceScenario {
    readonly scenarioId: AlmConformanceScenarioId;
    /** Every recipe, command, handle and type id the pair mints derives from it; distinct per recipe pair. */
    readonly scenarioKey: string;
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    readonly tags: readonly AlmConformanceTag[];
}

interface AlmConformanceRecipeInput extends AlmConformanceStepInput {
    readonly commands: readonly RallarBlackBoxTestCommand[];
}

/** RTC-with-WS-fallback injects one fault per carrier before starting the expiring send. */
const MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS = FAULT_TIMEOUT_MS * 2;
/** The absence window must contain pre-send faults, the message lifetime, and post-expiry proof. */
const MINIMUM_DEADLINE_MS = MAX_DEADLINE_EXPIRY_FAULT_BUDGET_MS +
    EXPIRY_TTL_MS +
    MINIMUM_POST_EXPIRY_OBSERVATION_MS +
    RESPONSE_MARGIN_MS;

const ALM_CONFORMANCE_SCENARIOS: readonly AlmConformanceScenarioDefinition[] = [
    boundedRejection,
    deadlineExpiry,
    deliveryBaseline,
    deliveryLifecycle,
    deliveryReload,
    orderingResync,
    ...crossCarrierDuplicate,
    ...notYetInSync
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
