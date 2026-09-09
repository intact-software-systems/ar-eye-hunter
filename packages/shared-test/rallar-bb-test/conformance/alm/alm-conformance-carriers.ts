export const ALM_CONFORMANCE_CARRIERS = ['ws', 'rtc', 'rtc-with-ws-fallback'] as const;

export type AlmConformanceCarrier = typeof ALM_CONFORMANCE_CARRIERS[number];
