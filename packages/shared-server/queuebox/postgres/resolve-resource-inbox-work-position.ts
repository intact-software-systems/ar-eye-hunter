import { Temporal } from '@js-temporal/polyfill';
import { Either } from '@shared/resilience/Either.ts';

import type { PSqlResourceInboxReservationRepository } from './p-sql-resource-inbox-reservation-repository.ts';

export function resolveResourceInboxWorkPosition(
    position: string | null
): Either<TypeError, PSqlResourceInboxReservationRepository.WorkPosition | null> {
    if (position === null) {
        return Either.ofRight(null);
    }
    if (position.length > 128) {
        return Either.ofLeft(
            new TypeError('PostgreSQL queue work cursor exceeds its timestamp and row identity bound')
        );
    }
    const value = position.split('/');
    if (value.length !== 2) {
        return Either.ofLeft(
            new TypeError('PostgreSQL queue work cursor requires a timestamp and positive row identity')
        );
    }
    const issues: string[] = [];
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/u.test(value[0])) {
        issues.push('PostgreSQL queue work cursor timestamp is invalid');
    }
    else {
        try {
            Temporal.PlainDateTime.from(value[0]);
        }
        catch {
            issues.push('PostgreSQL queue work cursor timestamp is invalid');
        }
    }
    if (!/^[1-9]\d{0,18}$/u.test(value[1]) || BigInt(value[1]) > 9_223_372_036_854_775_807n) {
        issues.push('PostgreSQL queue work cursor requires a positive row identity within bigint range');
    }
    return issues.length > 0
        ? Either.ofLeft(new TypeError(issues.join('; ')))
        : Either.ofRight({ createdAt: value[0], rowId: BigInt(value[1]) });
}
