import { openIndexedDbWithStore } from '../persistence/open-indexed-db.ts';
import { NEVER_EXPIRE_AT_TIMESTAMP } from '../persistence/PersistenceProvider.ts';
import { decodeALAdmissionStoredValue } from './al-admission-backend.ts';
import { decodeALAdmissionValue } from './al-admission-decoder.ts';
import { decodeALAdmissionNumber } from './al-admission-value-validation.ts';

export const AL_ADMISSION_REVISION_KEY = '__rallar_al_admission_revision__';
export const AL_ADMISSION_EXPIRY_INDEX_NAME = 'expireAtTimestamp';

const INITIAL_INDEXED_DB_ADMISSION_REVISION = {
    key: AL_ADMISSION_REVISION_KEY,
    value: 0,
    expireAtTimestamp: NEVER_EXPIRE_AT_TIMESTAMP
} as const;

export async function openIndexedDbAdmissionDatabase(
    dbName: string,
    storeName: string
): Promise<IDBDatabase> {
    return await openIndexedDbWithStore(dbName, {
        name: storeName,
        keyPath: 'key',
        indexes: [{
            name: AL_ADMISSION_EXPIRY_INDEX_NAME,
            keyPath: 'expireAtTimestamp'
        }],
        initialRecords: [INITIAL_INDEXED_DB_ADMISSION_REVISION]
    });
}

export function decodeIndexedDbAdmissionRevision(value: IDBRequest['result']): number {
    if (value === undefined) {
        throw new TypeError('IndexedDB admission revision row is required');
    }
    const stored = decodeALAdmissionValue(
        value,
        AL_ADMISSION_REVISION_KEY,
        decodeALAdmissionStoredValue
    );
    return decodeALAdmissionValue(stored.value, AL_ADMISSION_REVISION_KEY, decodeALAdmissionNumber);
}
