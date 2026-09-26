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
import { toRoomRef, toSendHandleId } from './alm-conformance-step-identities.ts';
import { boundedRejection } from './scenarios/bounded-rejection.ts';
import { crossCarrierDuplicate } from './scenarios/cross-carrier-duplicate.ts';
import { deadlineExpiry } from './scenarios/deadline-expiry.ts';
import { deliveryBaseline } from './scenarios/delivery-baseline.ts';
import { deliveryLifecycle } from './scenarios/delivery-lifecycle.ts';
import { deliveryReload, toReloadCheckpoint } from './scenarios/delivery-reload.ts';
import { notYetInSync } from './scenarios/not-yet-in-sync.ts';
import { orderingResync } from './scenarios/ordering-resync.ts';
import { receiptedAudience } from './scenarios/receipted-audience.ts';

export interface AlmConformanceScenario {
    readonly scenarioId: AlmConformanceScenarioId;
    /** Every recipe, command, handle and type id the pair mints derives from it; distinct per recipe pair. */
    readonly scenarioKey: string;
    readonly roles: readonly AlmConformanceRole[];
    readonly sender: RallarBlackBoxTestRecipe;
    readonly receiver: RallarBlackBoxTestRecipe;
    /** The second recipient's recipe; undefined exactly when `roles` does not declare `recipient-b`. */
    readonly recipientB: RallarBlackBoxTestRecipe | undefined;
    readonly tags: readonly AlmConformanceTag[];
}

interface AlmConformanceRecipeInput extends AlmConformanceStepInput {
    readonly commands: readonly RallarBlackBoxTestCommand[];
    /** Set only on the sender of a scenario that pins its receipt identity. */
    readonly receiptRoles: AlmConformanceReceiptRoles | undefined;
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
    ...notYetInSync,
    ...receiptedAudience
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

/** Three agents run only the scenarios that declare three roles; every other scenario runs on two (D45). */
export function isThreeAgentScenario(scenario: AlmConformanceScenario): boolean {
    return scenario.roles.length === 3;
}

export function toAlmConformanceRoleRecipe(
    scenario: AlmConformanceScenario,
    role: AlmConformanceRole
): RallarBlackBoxTestRecipe | undefined {
    return role === 'recipient-b' ? scenario.recipientB : scenario[role];
}

function toAlmConformanceScenario(
    input: CreateAlmConformanceRecipesInput,
    definition: AlmConformanceScenarioDefinition
): AlmConformanceScenario {
    const toRoleRecipe = (role: AlmConformanceRole): RallarBlackBoxTestRecipe => {
        const step: AlmConformanceStepInput = {
            input,
            scenarioId: definition.scenarioId,
            scenarioKey: definition.scenarioKey,
            role,
            roles: definition.roles
        };
        const commands = role === 'sender' ? definition.toSenderCommands(step) : definition.toRecipientCommands(step);
        const receiptRoles = role === 'sender' ? definition.toReceiptRoles?.(input.carrier) : undefined;
        return toAlmConformanceRecipe({ ...step, commands, receiptRoles });
    };
    return {
        scenarioId: definition.scenarioId,
        scenarioKey: definition.scenarioKey,
        roles: definition.roles,
        tags: definition.tags,
        sender: toRoleRecipe('sender'),
        receiver: toRoleRecipe('receiver'),
        recipientB: definition.roles.includes('recipient-b') ? toRoleRecipe('recipient-b') : undefined
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
                : {}),
            ...(recipe.receiptRoles === undefined
                ? {}
                : { almReceiptRoles: [toReceiptRolesMetadata(recipe, recipe.receiptRoles)] })
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
