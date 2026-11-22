import type { RallarBlackBoxTestRecipe } from '../../../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../../../schema/json-schema-validation.ts';
import { isAlmConformanceRole, type AlmConformanceRole } from '../alm-conformance-roles.ts';
import type { RecordedAlmConformanceParticipant } from './assess-alm-conformance-identity.ts';
import { toAlmJsonPathValue, toRecordedAlmResultValue } from './to-recorded-alm-result-value.ts';

export interface AlmRelayedGapRenewalInput {
    /** The sender recipe carries the pin. */
    readonly sender: RecordedAlmConformanceParticipant;
    readonly participants: readonly RecordedAlmConformanceParticipant[];
}

/** One origin of the cell, the request number it waits for, and its waits for that request from each receiver. */
interface AlmRelayedGapRenewalOrigin {
    readonly role: AlmConformanceRole;
    readonly requestNumber: number;
    readonly waitCommandIds: readonly string[];
}

/** The sender recipe names the origins whose gap request waits a relay must answer in `almRelayedGapRenewalOrigins`. */
export function hasAlmRelayedGapRenewalPin(recipe: RallarBlackBoxTestRecipe): boolean {
    return recipe.metadata?.almRelayedGapRenewalOrigins !== undefined;
}

/**
 * A cell that pins a relayed gap renewal fails unless at least one origin's recorded wait admitted the numbered request
 * from a peer other than the receiver it speaks for: requests every receiver sent itself prove nothing about the relay.
 */
export function assessAlmRelayedGapRenewal(input: AlmRelayedGapRenewalInput): readonly string[] {
    const recipe = input.sender.participant.recipe;
    const origins = recipe.metadata?.almRelayedGapRenewalOrigins;
    if (origins === undefined) {
        return [];
    }
    const cell = typeof recipe.metadata?.scenarioId === 'string' ? recipe.metadata.scenarioId : recipe.recipeId;
    if (!Array.isArray(origins) || origins.length === 0 || !origins.every(isAlmRelayedGapRenewalOrigin)) {
        return [
            `${cell}: the relayed gap renewal pin does not name each origin by its role, request number and waits.`
        ];
    }
    const requestNumbers = [...new Set(origins.map((origin) => origin.requestNumber))].join(' or ');
    return origins.some((origin) => isRelayedRequest(origin, input.participants))
        ? []
        : [`${cell}: no origin admitted a gap request numbered ${requestNumbers} through a relay, so no renewal was relayed.`];
}

function isRelayedRequest(
    origin: AlmRelayedGapRenewalOrigin,
    participants: readonly RecordedAlmConformanceParticipant[]
): boolean {
    const participant = participants.find((candidate) => candidate.participant.role === origin.role);
    return participant !== undefined && origin.waitCommandIds.some((commandId) => {
        const wait = participant.participant.recipe.commands.find((command) => command.commandId === commandId);
        const value = toRecordedAlmResultValue(participant, wait);
        const nack = toAlmJsonPathValue(value, 'event.payload.data');
        return isJsonRecordValue(value) && value.matched === true && isJsonRecordValue(nack) &&
            nack.nackGapRequestNumber === origin.requestNumber && typeof nack.nackFromPeerId === 'string' &&
            typeof nack.nackLogicalRecipientPeerId === 'string' &&
            nack.nackFromPeerId !== nack.nackLogicalRecipientPeerId;
    });
}

function isAlmRelayedGapRenewalOrigin(value: unknown): value is AlmRelayedGapRenewalOrigin {
    return isJsonRecordValue(value) && typeof value.role === 'string' && isAlmConformanceRole(value.role) &&
        typeof value.requestNumber === 'number' && Number.isInteger(value.requestNumber) && value.requestNumber > 0 &&
        Array.isArray(value.waitCommandIds) && value.waitCommandIds.length > 0 &&
        value.waitCommandIds.every((commandId) => typeof commandId === 'string');
}
