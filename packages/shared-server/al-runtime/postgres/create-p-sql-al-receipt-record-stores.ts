import { toALReceiptRecordNamespace } from '@shared/alm/receipt-record/al-receipt-record-keys.ts';
import type { ALReceiptRecordStores } from '@shared/alm/receipt-record/al-receipt-record-stores.ts';

import type { PSqlRuntimeStateRepository } from '../../runtime-state/postgres/p-sql-runtime-state-repository.ts';
import {
    toServerWsQBoxALRuntimeStoreId,
    type CreatePSqlALRuntimeStoresInput
} from './create-p-sql-al-runtime-stores.ts';
import { PSqlAdmissionWorkBackend } from './p-sql-admission-work-backend.ts';

export function createPSqlALReceiptRecordStores(
    input: Pick<CreatePSqlALRuntimeStoresInput, 'repository' | 'namespace' | 'nowMs'>
): ALReceiptRecordStores {
    const namespace = toALReceiptRecordNamespace(input.namespace);
    return {
        backend: new PSqlAdmissionWorkBackend({ sql: input.repository.sql, namespace, nowMs: input.nowMs }),
        namespace
    };
}

export function createServerWsQBoxALReceiptRecordStores(
    name: string,
    repository: PSqlRuntimeStateRepository
): ALReceiptRecordStores {
    return createPSqlALReceiptRecordStores({
        repository,
        namespace: toServerWsQBoxALRuntimeStoreId(name),
        nowMs: Date.now
    });
}
