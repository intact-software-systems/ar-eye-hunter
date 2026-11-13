import type { RallarBlackBoxTestRecipe } from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isAlmConformanceRole, type AlmConformanceRole } from '../alm-conformance-roles.ts';
import { resolveAlmEndingReceiptResult } from './assess-alm-acknowledged-identity.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';

export interface AlmRelayedReceiptInput {
    /** The sender recipe carries the pin. */
    readonly sender: RecordedAlmConformanceParticipant;
    readonly participants: readonly RecordedAlmConformanceParticipant[];
}

/** One origin of the cell and the handle of its first send. */
interface AlmRelayedReceiptOrigin {
    readonly role: AlmConformanceRole;
    readonly handleId: string;
}

/** A leaf of a three-page path reaches both other pages through its one next hop, the middle. */
const RELAYED_RECIPIENT_COUNT = 2;
const RELAYED_HOP_COUNT = 1;

/** The sender recipe names the origins whose sends one relay must cover in `metadata.almRelayedReceiptOrigins`. */
export function hasAlmRelayedReceiptPin(recipe: RallarBlackBoxTestRecipe): boolean {
    return recipe.metadata?.almRelayedReceiptOrigins !== undefined;
}

/**
 * A cell that pins a relayed receipt fails unless the ending receipt read of at least one origin confirms both of its
 * recipients through one hop: two direct sends prove nothing about the relay.
 */
export function assessAlmRelayedReceipt(input: AlmRelayedReceiptInput): readonly string[] {
    const recipe = input.sender.participant.recipe;
    const origins = recipe.metadata?.almRelayedReceiptOrigins;
    if (origins === undefined) {
        return [];
    }
    const cell = typeof recipe.metadata?.scenarioId === 'string' ? recipe.metadata.scenarioId : recipe.recipeId;
    if (!Array.isArray(origins) || origins.length === 0 || !origins.every(isAlmRelayedReceiptOrigin)) {
        return [`${cell}: the relayed receipt pin does not name each origin by its role and send handle.`];
    }
    return origins.some((origin) => isRelayedReceipt(origin, input.participants))
        ? []
        : [`${cell}: no ending receipt of an origin confirms both recipients through one hop, so no send was relayed.`];
}

function isRelayedReceipt(
    origin: AlmRelayedReceiptOrigin,
    participants: readonly RecordedAlmConformanceParticipant[]
): boolean {
    const participant = participants.find((candidate) => candidate.participant.role === origin.role);
    const value = participant ? resolveAlmEndingReceiptResult(participant, origin.handleId)?.value : undefined;
    return isJsonRecordValue(value) && Array.isArray(value.confirmedRecipientPeerIds) &&
        Array.isArray(value.confirmedHopPeerIds) &&
        value.confirmedRecipientPeerIds.length === RELAYED_RECIPIENT_COUNT &&
        value.confirmedHopPeerIds.length === RELAYED_HOP_COUNT;
}

function isAlmRelayedReceiptOrigin(value: unknown): value is AlmRelayedReceiptOrigin {
    return isJsonRecordValue(value) && typeof value.role === 'string' && isAlmConformanceRole(value.role) &&
        typeof value.handleId === 'string';
}
