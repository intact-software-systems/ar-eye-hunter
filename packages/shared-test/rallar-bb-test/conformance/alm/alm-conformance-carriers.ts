export const ALM_CONFORMANCE_CARRIERS = ['ws', 'rtc', 'rtc-with-ws-fallback'] as const;

export type AlmConformanceCarrier = typeof ALM_CONFORMANCE_CARRIERS[number];

/** The only cell with a second carrier to hand an admitted message to (D56). */
export const ALM_CONFORMANCE_FALLBACK_CARRIERS: readonly AlmConformanceCarrier[] = [
    'rtc-with-ws-fallback'
];

/**
 * The carriers on which one hop carries a whole ordering track. A hand-over (D56) moves one message of a track
 * to WS, whose relay never saw the track's other messages and gates the one it received as its own gap.
 */
export const ALM_CONFORMANCE_SINGLE_HOP_CARRIERS: readonly AlmConformanceCarrier[] = ['ws', 'rtc'];
