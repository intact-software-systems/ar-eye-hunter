import { Either } from '@shared/resilience/Either.ts';

import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

/**
 * `strip-proof` deletes the frame's publication proof. `forgeSender` names a principal by id: the page writes that
 * principal's one live session as the frame's sender and its registered key id into the proof, keeping the signature.
 */
export type AlmFaultRewrite = Readonly<{ forgeSender: Readonly<{ principal: string; }>; }> | 'strip-proof';

const REWRITE_OFF_RTC_MESSAGE = 'fault.inject.action.rewrite is offered on the rtc carrier only.';
const REWRITE_SHAPE_MESSAGE =
    'fault.inject.action.rewrite must be "strip-proof" or an object naming forgeSender.principal.';

/**
 * Right `null` when the fault's action names no rewrite, so the caller judges it as any other transport fault (an
 * `Either` never holds `undefined`). Only an RTC frame is rewritten, so a rewrite on any other carrier is refused; it
 * names `strip-proof` or exactly one forged principal, which the page resolves to that principal's live session and
 * registered key at injection.
 */
export function decodeAlmFaultRewrite(fault: unknown): Either<string, AlmFaultRewrite | null> {
    if (!isJsonRecordValue(fault) || !isJsonRecordValue(fault.action) || !('rewrite' in fault.action)) {
        return Either.ofRight(null);
    }
    const { carrier, action } = fault;
    if (carrier !== 'rtc') {
        return Either.ofLeft(REWRITE_OFF_RTC_MESSAGE);
    }
    const { rewrite } = action;
    if (!hasOnlyKeys(action, ['rewrite'])) {
        return Either.ofLeft(REWRITE_SHAPE_MESSAGE);
    }
    if (rewrite === 'strip-proof') {
        return Either.ofRight(rewrite);
    }
    const forged = isJsonRecordValue(rewrite) && hasOnlyKeys(rewrite, ['forgeSender'])
        ? rewrite.forgeSender
        : undefined;
    const principal = isJsonRecordValue(forged) && hasOnlyKeys(forged, ['principal']) ? forged.principal : undefined;
    return typeof principal === 'string' && /\S/.test(principal)
        ? Either.ofRight({ forgeSender: { principal } })
        : Either.ofLeft(REWRITE_SHAPE_MESSAGE);
}

function hasOnlyKeys(record: object, keys: readonly string[]): boolean {
    return Object.keys(record).length === keys.length && keys.every((key) => key in record);
}
