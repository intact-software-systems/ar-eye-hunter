import { Either } from '@shared/resilience/Either.ts';

import { validateEventHistoryPolicy, type RallarBlackBoxEventHistoryPolicy } from '../runtime/event-history.ts';

export interface EventHistoryLaunch {
    readonly policy: RallarBlackBoxEventHistoryPolicy | undefined;
}

/** URL and environment text share one translation before canonical policy validation. */
export function decodeEventHistoryLaunch(
    mode: string | undefined,
    maxEvents: string | undefined
): Either<readonly string[], EventHistoryLaunch> {
    if (mode === undefined && maxEvents === undefined) {
        return Either.ofRight({ policy: undefined });
    }
    const policy = {
        mode,
        ...(maxEvents === undefined ? {} : { maxEvents: /^\d+$/.test(maxEvents) ? Number(maxEvents) : Number.NaN })
    };
    const issues = validateEventHistoryPolicy(policy);
    return issues.length > 0
        ? Either.ofLeft(issues)
        : Either.ofRight({ policy: policy as RallarBlackBoxEventHistoryPolicy });
}
