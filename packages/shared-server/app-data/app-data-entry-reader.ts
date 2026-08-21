import type { AppDataEntry, AppDataRepositoryLike } from './AppDataRepository.ts';
import { isAppDataPageRepository } from './AppDataRepository.ts';

export const APP_DATA_ENTRY_READ_PAGE_SIZE = 1_000;

export async function* readAppDataEntries(
    repository: AppDataRepositoryLike,
    namespace: string,
    storeName: string,
    keyPrefix?: string,
    pageSize: number = APP_DATA_ENTRY_READ_PAGE_SIZE
): AsyncGenerator<AppDataEntry> {
    if (!isAppDataPageRepository(repository)) {
        for (const entry of await repository.findEntries(namespace, storeName, keyPrefix)) {
            yield entry;
        }
        return;
    }

    const limit = Math.max(1, Math.floor(pageSize));
    let afterKey: string | undefined;

    while (true) {
        const page = await repository.findEntriesPage(namespace, storeName, {
            keyPrefix,
            afterKey,
            limit
        });
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
