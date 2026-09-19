import type { RallarBlackBoxTestResult } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';
import { decodeAssertResultValue, decodeWaitResultValue } from './decode-composite-result-values.ts';
import { decodeFirstNonBlankText, toDistributedRunPayloadSummary } from './distributed-run-payload-summary.ts';

export function toCompositeResultDetail(
    result: RallarBlackBoxTestResult,
    displayValue: unknown,
    errorSummary: string | undefined
): string | undefined {
    if (errorSummary) {
        return errorSummary;
    }

    if (result.kind === 'assert') {
        const value = decodeAssertResultValue(result.value);
        if (value) {
            return [
                `actual ${toDistributedRunPayloadSummary(value.actual)}`,
                `exists ${value.exists}`
            ].join(' - ');
        }
    }

    if (result.kind === 'wait') {
        const value = decodeWaitResultValue(result.value);
        if (value?.event) {
            return `event ${toDistributedRunPayloadSummary(value.event)}`;
        }
    }

    if (result.kind === 'loop' || result.kind === 'parallel') {
        return undefined;
    }

    return toCompositeValueSummary(displayValue);
}

export function toCompositeValueSummary(value: unknown): string | undefined {
    if (value === undefined) {
        return undefined;
    }
    const summary = toDistributedRunPayloadSummary(value);
    return summary.length > 0 ? summary : undefined;
}

export function toCompositeErrorSummary(error: unknown): string | undefined {
    if (error === undefined) {
        return undefined;
    }
    const record = decodeRecord(error);
    const code = decodeFirstNonBlankText(record.code);
    const message = decodeFirstNonBlankText(record.message);
    if (code || message) {
        return [code, message].filter(Boolean).join(': ');
    }
    return toDistributedRunPayloadSummary(error);
}
