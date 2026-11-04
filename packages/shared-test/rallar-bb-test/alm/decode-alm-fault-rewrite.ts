import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxTestFaultRewrite } from '../rallar-black-box-test-contracts.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';

const REWRITE_OFF_RTC_MESSAGE = 'fault.inject.action.rewrite is offered on the rtc carrier only.';
const REWRITE_SHAPE_MESSAGE =
    'fault.inject.action.rewrite must be "strip-proof" or an object naming forgeSender.principal.';

/** Whether a transport fault's action asks for a rewrite, which {@link decodeAlmFaultRewrite} then judges. */
export function isAlmFaultRewriteAction(action: unknown): action is Readonly<Record<'rewrite', unknown>> {
    return isJsonRecordValue(action) && 'rewrite' in action;
}

/**
 * Only an RTC frame is rewritten, so a rewrite on any other carrier is refused; it names `strip-proof` or exactly one
 * forged principal, which the page resolves to that principal's live session and registered key at injection.
 */
export function decodeAlmFaultRewrite(
    carrier: unknown,
    action: Readonly<Record<'rewrite', unknown>>
): Either<string, RallarBlackBoxTestFaultRewrite> {
    if (carrier !== 'rtc') {
        return Either.ofLeft(REWRITE_OFF_RTC_MESSAGE);
    }
    const { rewrite } = action;
    if (!hasExactKeys(action, ['rewrite'])) {
        return Either.ofLeft(REWRITE_SHAPE_MESSAGE);
    }
    if (rewrite === 'strip-proof') {
        return Either.ofRight(rewrite);
    }
    const forged = hasExactKeys(rewrite, ['forgeSender']) ? rewrite.forgeSender : undefined;
    const principal = hasExactKeys(forged, ['principal']) ? forged.principal : undefined;
    return typeof principal === 'string' && /\S/.test(principal)
        ? Either.ofRight({ forgeSender: { principal } })
        : Either.ofLeft(REWRITE_SHAPE_MESSAGE);
}

function hasExactKeys<K extends string>(value: unknown, keys: readonly K[]): value is Readonly<Record<K, unknown>> {
    return isJsonRecordValue(value) && Object.keys(value).length === keys.length &&
        keys.every((key) => key in value);
}
