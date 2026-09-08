import {
    createCountingIndexedDbOperationObserver,
    createPassThroughIndexedDbOperationObserver
} from '@shared/persistence/indexed-db-operation-observer.ts';
import { describe, expect, it } from 'vitest';

describe('IndexedDB operation observer', () => {
    it('counts operations by owner and kind', () => {
        const observer = createCountingIndexedDbOperationObserver();
        observer.observe({ owner: 'al-admission', kind: 'read' });
        observer.observe({ owner: 'al-admission', kind: 'write' });
        observer.observe({ owner: 'al-work', kind: 'work-page' });

        expect(observer.getCounts()).toEqual({
            total: 3,
            byOwner: { 'al-admission': 2, 'al-work': 1 },
            byKind: { read: 1, write: 1, 'work-page': 1 }
        });
    });

    it('resets to zero and keeps counting afterwards', () => {
        const observer = createCountingIndexedDbOperationObserver();
        observer.observe({ owner: 'al-work', kind: 'work-reserve' });
        observer.reset();
        observer.observe({ owner: 'al-work', kind: 'work-release' });

        expect(observer.getCounts()).toEqual({
            total: 1,
            byOwner: { 'al-admission': 0, 'al-work': 1 },
            byKind: { 'work-release': 1 }
        });
    });

    it('pass-through observer accepts operations without state', () => {
        const observer = createPassThroughIndexedDbOperationObserver();
        expect(() => observer.observe({ owner: 'al-admission', kind: 'list' })).not.toThrow();
    });
});
