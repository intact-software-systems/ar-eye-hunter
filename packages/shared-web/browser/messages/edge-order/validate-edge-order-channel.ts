import type { RallarValidationIssue } from '@shared/api/rallar-validation.ts';

/** What a channel definition says of its order, as a JavaScript caller may pass it: anything, or nothing, in each field. */
export interface EdgeOrderChannelInput {
    readonly purpose?: string;
    readonly access?: string;
    readonly durability?: string;
    readonly order?: string;
    readonly onOrderGap?: unknown;
    readonly orderGapWaitMs?: unknown;
    readonly orderEntryWindowMs?: unknown;
}

/** One option only an edge-ordered channel takes: what it is called and how a value that is not one is refused. */
interface EdgeOrderChannelOption {
    readonly path: string;
    readonly value: unknown;
    readonly isValid: boolean;
    readonly invalidCode: string;
    readonly invalidMessage: string;
}

/**
 * Edge order lives in memory at the two ends and waits only for a send that is retried, so its channel is a
 * volatile command or notification channel. A granted topic is refused until its wrapped payload is proven through
 * the publisher proof and the `subscribe` election; a session that elects late is a late joiner like any other. The
 * gap handler and the two waits belong to an edge-ordered channel only.
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

function isWholeMilliseconds(value: unknown): boolean {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function resolveEdgeOrderChannelRefusal(definition: EdgeOrderChannelInput): string | undefined {
    if (definition.purpose === 'live') {
        return 'A live channel is not edge-ordered: nothing retries its sends.';
    }
    if (definition.access === 'granted') {
        return 'A granted channel is not edge-ordered yet: its signed payload is not proven with the order wrapper.';
    }
    return definition.durability !== undefined && definition.durability !== 'volatile'
        ? 'An edge-ordered channel is volatile: its order lives in memory only.'
        : undefined;
}
