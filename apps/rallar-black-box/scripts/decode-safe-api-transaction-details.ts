import { isApiTimingRecord, isNonNegativeApiTimingNumber } from './to-safe-api-ws-receipt-observation.ts';

/** The closed fields of a transaction line: the wait from its begin call to its callback entry. Anything else is dropped. */
export function decodeSafeApiTransactionDetails(
    operation: string,
    details: unknown
): Readonly<Record<string, number>> {
    if (
        operation === 'transaction' && isApiTimingRecord(details) && isNonNegativeApiTimingNumber(details.beginWaitMs)
    ) {
        return { beginWaitMs: details.beginWaitMs };
    }
    return {};
}
