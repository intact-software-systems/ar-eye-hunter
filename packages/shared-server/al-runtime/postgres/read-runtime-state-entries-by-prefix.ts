import type { RuntimeStateEntry } from '@shared-server/runtime-state/runtime-state-repository.ts';
import {
    isRuntimeStatePrefixPageRepositoryLike,
    type RuntimeStateTransactionalRepositoryLike
} from '@shared-server/runtime-state/runtime-state-repository.ts';

export const RUNTIME_STATE_PREFIX_READ_PAGE_SIZE = 1_000;

export async function* readRuntimeStateEntriesByPrefix(
    repository: RuntimeStateTransactionalRepositoryLike,
    namespace: string,
    prefix: string,
    pageSize: number = RUNTIME_STATE_PREFIX_READ_PAGE_SIZE
): AsyncGenerator<RuntimeStateEntry> {
    if (!isRuntimeStatePrefixPageRepositoryLike(repository)) {
        for (const entry of await repository.findEntriesByPrefix(namespace, prefix)) {
            yield entry;
        }
        return;
    }

    const limit = Math.max(1, Math.floor(pageSize));
    let afterKey: string | undefined;

    while (true) {
        const page = await repository.findEntriesByPrefixPage(
            namespace,
            prefix,
            {
                afterKey,
                limit
            }
        );
        if (page.length === 0) {
            return;
        }

        for (const entry of page) {
            yield entry;
        }

        afterKey = page[page.length - 1]?.key;
        if (page.length < limit || afterKey === undefined) {
            return;
        }
    }
}
