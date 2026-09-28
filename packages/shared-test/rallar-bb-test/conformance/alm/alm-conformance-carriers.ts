export const ALM_CONFORMANCE_CARRIERS = ['ws', 'rtc', 'rtc-with-ws-fallback'] as const;

export type AlmConformanceCarrier = typeof ALM_CONFORMANCE_CARRIERS[number];

/** The only cell with a second carrier to hand an admitted message to (D56). */
export const ALM_CONFORMANCE_FALLBACK_CARRIERS: readonly AlmConformanceCarrier[] = [
    'rtc-with-ws-fallback'
];
