import { validateAppInboxCommandIdentity } from '@shared-server/rallar-system/app-inbox/app-inbox-command-identity.ts';
import type { AppInboxFailure } from '@shared-server/rallar-system/app-inbox/app-inbox-failure.ts';
import { normalizeAppInboxOptions } from '@shared-server/rallar-system/app-inbox/app-inbox-options.ts';
import { AppInboxResultWaiter } from '@shared-server/rallar-system/app-inbox/client/app-inbox-result-waiter.ts';
import type { ResourceEntry } from '@shared/queuebox/ResourceEntry.ts';
import type { Either } from '@shared/resilience/Either.ts';

export interface ReadCompletedAppInboxResultInput<Result> {
    readonly statusRepository: AppInboxResultWaiter.StatusRepository;
    readonly resultRepository: AppInboxResultWaiter.ResultRepository;
    readonly entry: ResourceEntry;
    readonly decodeResult: AppInboxResultWaiter.ResultDecoder<Result>;
}

/**
 * Reads the durable result of an entry a test enqueued through a production method that
 * does not wait, using the production result waiter on the entry's own key.
 */
export async function readCompletedAppInboxResult<Result>(
    input: ReadCompletedAppInboxResultInput<Result>
): Promise<Either<AppInboxFailure, Result>> {
    const identity = validateAppInboxCommandIdentity(input.entry);
    if (!identity.valid) {
        throw new TypeError('The enqueued AppInbox entry carries no readable command');
    }
    const waiter = new AppInboxResultWaiter(
        { statusRepository: input.statusRepository, resultRepository: input.resultRepository },
        { serviceId: 'app-inbox-test-result-reader', options: normalizeAppInboxOptions({}) }
    );
    return await waiter.waitForResult(identity.command, input.entry.key, input.decodeResult);
}
