import type { Either } from '@shared/resilience/Either.ts';
import type { ControlRequestFailure } from '../../../control-run-manager/control-request-failure.ts';

/**
 * A control-server fact the distributed refresh decorates its run list with. The refresh owns the
 * list it already read, so neither an expected failure nor a transport rejection may end it: both
 * leave the fact absent and the panel publishes the list with that detail missing.
 */
export async function readAvailableControlValue<Value>(
    read: Promise<Either<ControlRequestFailure, Value>>
): Promise<Value | undefined> {
    return await read.then((outcome) => outcome.right).catch(() => undefined);
}
