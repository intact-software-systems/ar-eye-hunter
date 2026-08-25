import type { AppDataEntry, AppDataRepository } from './app-data-repository.ts';

export interface ReadAppDataEntriesInput {
    readonly repository: AppDataRepository;
    readonly namespace: string;
    readonly storeName: string;
    readonly keyPrefix?: string;
    readonly pageSize?: number;
}

export const APP_DATA_ENTRY_READ_PAGE_SIZE = 1_000;

export async function* readAppDataEntries(
    input: ReadAppDataEntriesInput
): AsyncGenerator<AppDataEntry> {
    const limit = Math.max(1, Math.floor(input.pageSize ?? APP_DATA_ENTRY_READ_PAGE_SIZE));
    let afterKey: string | undefined;

    while (true) {
        const page = await input.repository.findEntriesPage({
            namespace: input.namespace,
            storeName: input.storeName,
            keyPrefix: input.keyPrefix,
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
