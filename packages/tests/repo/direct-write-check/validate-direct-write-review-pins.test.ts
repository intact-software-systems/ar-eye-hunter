import { describe, expect, it } from 'vitest';

import { validateDirectWriteReviewPins } from '../../../../scripts/direct-write-check/validate-direct-write-review-pins.mjs';

const STORE = 'alm-inbound-admission';
const SURFACE_ID = 'packages/shared/alm/inbound/al-inbound-admission-store.ts#ALInboundAdmissionStore.admit';
const OPENER_ID = 'packages/shared-server/maintenance/expiry-worker.ts#ExpiryWorker.sweep';

describe('direct-write review pins', () => {
    it('accepts a registry whose stores, approvals, transport surfaces and class counts are the pinned ones', () => {
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
        const registry = registryWith({ extraStore: 'alm-displayed-record' });

        expect(validateDirectWriteReviewPins(registry, pins())).toEqual([
            'stores: the registry holds [alm-displayed-record under-review, alm-inbound-admission under-review], ' +
            'the review pins hold [alm-inbound-admission under-review]'
        ]);
    });

    it('refuses a transport-direct surface the pins do not hold, which widens a store, and a pinned one that is gone', () => {
        const widened = registryWith({ extraWrite: `${SURFACE_ID}Again` });
        const narrowed = registryWith({ withoutWrite: true });

        expect(validateDirectWriteReviewPins(widened, pins())).toEqual([
            `admissionBackendWrites ${SURFACE_ID}Again: a transport-direct surface the review pins do not hold`,
            'classes: the registry holds {"downstream-work":1,"transport-direct":2}, ' +
            'the review pins hold {"downstream-work":1,"transport-direct":1}'
        ]);
        expect(validateDirectWriteReviewPins(narrowed, pins())).toEqual([
            `admissionBackendWrites ${SURFACE_ID}: a pinned transport-direct surface the registry does not hold`,
            'classes: the registry holds {"downstream-work":1}, ' +
            'the review pins hold {"downstream-work":1,"transport-direct":1}'
        ]);
    });

    it('refuses a surface added or given another class, by its count per class', () => {
        const registry = registryWith({ openerClass: 'passive-statement' });

        expect(validateDirectWriteReviewPins(registry, pins())).toEqual([
            'classes: the registry holds {"passive-statement":1,"transport-direct":1}, ' +
            'the review pins hold {"downstream-work":1,"transport-direct":1}'
        ]);
    });

    it('refuses pins that are not the expected shape', () => {
        expect(validateDirectWriteReviewPins(registryWith({}), { approvedStoreIds: [] })).toEqual([
            'the review pins must hold approvedStoreIds, stores, transportDirectSurfaces and classCounts'
        ]);
    });
});

interface RegistryOverrides {
    readonly review?: Readonly<Record<string, string>>;
    readonly extraStore?: string;
    readonly extraWrite?: string;
    readonly withoutWrite?: boolean;
    readonly openerClass?: string;
}

function registryWith(overrides: RegistryOverrides) {
    const store = (id: string) => ({ id, class: 'transport-direct', review: overrides.review ?? { state: 'under-review' } });
    const write = (id: string) => ({ id, class: 'transport-direct', stores: [STORE] });
    return {
        stores: [store(STORE), ...(overrides.extraStore === undefined ? [] : [store(overrides.extraStore)])],
        admissionBackendWrites: [
            ...(overrides.withoutWrite === true ? [] : [write(SURFACE_ID)]),
            ...(overrides.extraWrite === undefined ? [] : [write(overrides.extraWrite)])
        ],
        transactionOpeners: [{ id: OPENER_ID, class: overrides.openerClass ?? 'downstream-work' }]
    };
}

function pins() {
    return {
        approvedStoreIds: [],
        stores: [{ id: STORE, state: 'under-review' }],
        transportDirectSurfaces: [`admissionBackendWrites ${SURFACE_ID}`],
        classCounts: { 'downstream-work': 1, 'transport-direct': 1 }
    };
}
