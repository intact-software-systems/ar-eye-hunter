import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** Whatever a JavaScript caller put in a field of a definition: nothing has checked it yet. */
export type UncheckedChannelOption = object | string | number | boolean | null;

/** What a channel definition says of its order, as a JavaScript caller may pass it: anything, or nothing, in each field. */
export interface EdgeOrderChannelInput {
    readonly durability?: string;
    readonly order?: string;
    readonly onOrderGap?: UncheckedChannelOption;
    readonly orderGapWaitMs?: UncheckedChannelOption;
    readonly orderEntryWindowMs?: UncheckedChannelOption;
}

/** One option only an edge-ordered channel takes: what it is called and how a value that is not one is refused. */
interface EdgeOrderChannelOption {
    readonly path: string;
    readonly value: UncheckedChannelOption | undefined;
    readonly isValid: boolean;
    readonly invalidCode: string;
    readonly invalidMessage: string;
}

/**
 * Edge order lives in memory at the two ends, so its channel is volatile. A granted topic takes it as a members topic
 * does: the stamp is inside the payload the publisher proof signs, and a session that elects late enters each stream
 * like any late joiner. A live channel takes it too: nothing retries its values, so the newest wins. The gap handler
 * and the two waits belong to an edge-ordered channel only.
 */
export function validateEdgeOrderChannel(definition: EdgeOrderChannelInput): readonly RallarValidationIssue[] {
    const options = toEdgeOrderChannelOptions(definition).filter((option) => option.value !== undefined);
    if (definition.order === undefined) {
        return options.map((option) => ({
            path: option.path,
            code: 'unsupported',
            message: 'Only an edge-ordered channel takes this option.'
        }));
    }
    const refusal = definition.order === 'edge' ? resolveEdgeOrderChannelRefusal(definition) : undefined;
    return [
        ...(definition.order === 'edge'
            ? []
            : [{ path: '$.order', code: 'invalid-order', message: 'Order must be edge.' }]),
        ...(refusal === undefined ? [] : [{ path: '$.order', code: 'unsupported', message: refusal }]),
        ...options
            .filter((option) => !option.isValid)
            .map((option) => ({ path: option.path, code: option.invalidCode, message: option.invalidMessage }))
    ];
}

function toEdgeOrderChannelOptions(definition: EdgeOrderChannelInput): readonly EdgeOrderChannelOption[] {
    return [
        {
            path: '$.onOrderGap',
            value: definition.onOrderGap,
            isValid: typeof definition.onOrderGap === 'function',
            invalidCode: 'invalid-order-gap-handler',
            invalidMessage: 'onOrderGap must be a function.'
        },
        {
            path: '$.orderGapWaitMs',
            value: definition.orderGapWaitMs,
            isValid: isWholeMilliseconds(definition.orderGapWaitMs),
            invalidCode: 'invalid-order-gap-wait',
            invalidMessage: 'orderGapWaitMs must be a whole number of milliseconds, 0 or more.'
        },
        {
            path: '$.orderEntryWindowMs',
            value: definition.orderEntryWindowMs,
            isValid: isWholeMilliseconds(definition.orderEntryWindowMs),
            invalidCode: 'invalid-order-entry-window',
            invalidMessage: 'orderEntryWindowMs must be a whole number of milliseconds, 0 or more.'
        }
    ];
}

function isWholeMilliseconds(value: UncheckedChannelOption | undefined): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function resolveEdgeOrderChannelRefusal(definition: EdgeOrderChannelInput): string | undefined {
    return definition.durability !== undefined && definition.durability !== 'volatile'
        ? 'An edge-ordered channel is volatile: its order lives in memory only.'
        : undefined;
}
