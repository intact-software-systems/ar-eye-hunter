import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeNumber, decodeText } from './decode-artifact-json-values.ts';

/** A recipe's receiver delivery threshold; each bound is absent when the command metadata does not set it. */
export interface ReceiverDeliverySpec {
    readonly expectedInboundMessages?: number;
    readonly minExpectedInboundMessages?: number;
    readonly minReceiveRatio?: number;
}

/** Absent when the metadata sets no receiver delivery bound, either directly or under receiverDelivery. */
export function decodeReceiverDeliverySpec(metadata: unknown): ReceiverDeliverySpec | undefined {
    if (!isJsonRecordValue(metadata)) {
        return undefined;
    }
    const nested = metadata.receiverDelivery;
    const source = isJsonRecordValue(nested) && Object.keys(nested).length > 0 ? nested : metadata;
    const expectedInboundMessages = decodeNumber(source.expectedInboundMessages);
    const minExpectedInboundMessages = decodeNumber(source.minExpectedInboundMessages);
    const minReceiveRatio = decodeNumber(source.minReceiveRatio);
    if (
        expectedInboundMessages === undefined &&
        minExpectedInboundMessages === undefined &&
        minReceiveRatio === undefined
    ) {
        return undefined;
    }
    return {
        expectedInboundMessages,
        minExpectedInboundMessages,
        minReceiveRatio
    };
}

/**
 * The receiver delivery bounds the manifest recipes set per command id, including commands nested in
 * composite commands and their groups. The manifest's inner structure is read leniently.
 */
export function decodeReceiverDeliverySpecsByCommandId(manifest: unknown): ReadonlyMap<string, ReceiverDeliverySpec> {
    if (!isJsonRecordValue(manifest) || !Array.isArray(manifest.recipes)) {
        return new Map();
    }
    return new Map(
        manifest.recipes.flatMap((selection) =>
            isJsonRecordValue(selection) && isJsonRecordValue(selection.recipe)
                ? decodeCommandSpecEntries(selection.recipe.commands)
                : []
        )
    );
}

function decodeCommandSpecEntries(commands: unknown): readonly (readonly [string, ReceiverDeliverySpec])[] {
    if (!Array.isArray(commands)) {
        return [];
    }
    return commands.flatMap((command) => {
        if (!isJsonRecordValue(command)) {
            return [];
        }
        const commandId = decodeText(command.commandId);
        const spec = decodeReceiverDeliverySpec(command.metadata);
        const groups = Array.isArray(command.groups) ? command.groups : [];
        return [
            ...(commandId !== undefined && spec !== undefined ? [[commandId, spec] as const] : []),
            ...decodeCommandSpecEntries(command.commands),
            ...groups.flatMap((group) => isJsonRecordValue(group) ? decodeCommandSpecEntries(group.commands) : [])
        ];
    });
}
