import { describe, expect, it } from 'vitest';

import { validateDirectWriteReviewPins } from '../../../../scripts/direct-write-check/validate-direct-write-review-pins.mjs';

const STORE = 'alm-inbound-admission';
const WRITE_ID = 'packages/shared/alm/inbound/al-inbound-admission-store.ts#ALInboundAdmissionStore.admit';
const PRUNE_ID = 'packages/shared-server/admin/admin-prune-page-worker.ts#AdminPrunePageWorker.processReservedEntry';
const SESSION_ID = 'packages/shared-server/auth/auth-session-persistence.ts#AuthSessionPersistence';

describe('direct-write review pins', () => {
    it('accepts a registry whose stores, approvals, surfaces and classes are the pinned ones', () => {
        expect(validateDirectWriteReviewPins(registryWith({}), pins())).toEqual([]);
    });

    it('refuses an approval the pins do not hold, though the approval itself is complete', () => {
        const registry = registryWith({ review: { state: 'approved', question: 'This writes outside AppInbox?' } });

        expect(validateDirectWriteReviewPins(registry, pins())).toEqual([
            'stores: the registry approves [alm-inbound-admission], the review pins approve []',
            'stores: the registry holds [alm-inbound-admission approved], the review pins hold [alm-inbound-admission under-review]'
        ]);
    });

    it('refuses a store that is not pinned, under review or not', () => {
        expect(validateDirectWriteReviewPins(registryWith({ extraStore: 'alm-displayed-record' }), pins())).toEqual([
            'stores: the registry holds [alm-displayed-record under-review, alm-inbound-admission under-review], ' +
            'the review pins hold [alm-inbound-admission under-review]'
        ]);
    });

    it('refuses a surface the pins do not hold, which widens a store, and a pinned one that is gone', () => {
        const widened = registryWith({ extraWrite: `${WRITE_ID}Again` });
        const narrowed = registryWith({ withoutWrite: true });

        expect(validateDirectWriteReviewPins(widened, pins())).toEqual([
            `admissionBackendWrites ${WRITE_ID}Again: a surface the review pins do not hold`
        ]);
        expect(validateDirectWriteReviewPins(narrowed, pins())).toEqual([
            `admissionBackendWrites ${WRITE_ID}: a pinned surface the registry does not hold`
        ]);
    });

    it('refuses two surfaces that swap classes, though the number in each class stays the same', () => {
        const registry = registryWith({ pruneClass: 'no-production-caller', sessionClass: 'downstream-work' });

        expect(validateDirectWriteReviewPins(registry, pins())).toEqual([
            `repositoryWriteCallers ${SESSION_ID}: class downstream-work, the review pins hold no-production-caller`,
            `transactionOpeners ${PRUNE_ID}: class no-production-caller, the review pins hold downstream-work`
        ]);
    });

    it('refuses a transport-direct surface whose count or stores moved, which widens a store under review', () => {
        const registry = registryWith({ writeCount: 2 });

        expect(validateDirectWriteReviewPins(registry, pins())).toEqual([
            `admissionBackendWrites ${WRITE_ID}: the registry holds {"count":2,"stores":["alm-inbound-admission"]}, ` +
            'the review pins hold {"count":1,"stores":["alm-inbound-admission"]}'
        ]);
    });

    it('refuses pins that are not the expected shape', () => {
        expect(validateDirectWriteReviewPins(registryWith({}), { approvedStoreIds: [] })).toEqual([
            'the review pins must hold approvedStoreIds, stores and surfaces'
        ]);
    });
});

interface RegistryOverrides {
    readonly review?: Readonly<Record<string, string>>;
    readonly extraStore?: string;
    readonly extraWrite?: string;
    readonly withoutWrite?: boolean;
    readonly writeCount?: number;
    readonly pruneClass?: string;
    readonly sessionClass?: string;
}

function registryWith(overrides: RegistryOverrides) {
    const store = (id: string) => ({ id, class: 'transport-direct', review: overrides.review ?? { state: 'under-review' } });
    const write = (id: string) => ({
        id,
        class: 'transport-direct',
        stores: [STORE],
        count: overrides.writeCount ?? 1,
        basis: 'A write through the port, read in the named file.'
    });
    return {
        stores: [store(STORE), ...(overrides.extraStore === undefined ? [] : [store(overrides.extraStore)])],
        admissionBackendWrites: [
            ...(overrides.withoutWrite === true ? [] : [write(WRITE_ID)]),
            ...(overrides.extraWrite === undefined ? [] : [write(overrides.extraWrite)])
        ],
        transactionOpeners: [{ id: PRUNE_ID, class: overrides.pruneClass ?? 'downstream-work', count: 1 }],
        repositoryWriteCallers: [{ id: SESSION_ID, class: overrides.sessionClass ?? 'no-production-caller', count: 4 }]
    };
}

function pins() {
    return {
        approvedStoreIds: [],
        stores: [{ id: STORE, state: 'under-review' }],
        surfaces: {
            [`admissionBackendWrites ${WRITE_ID}`]: { class: 'transport-direct', count: 1, stores: [STORE] },
            [`repositoryWriteCallers ${SESSION_ID}`]: { class: 'no-production-caller' },
            [`transactionOpeners ${PRUNE_ID}`]: { class: 'downstream-work' }
        }
    };
}
