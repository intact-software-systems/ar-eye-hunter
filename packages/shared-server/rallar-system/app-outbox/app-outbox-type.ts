export const AppOutboxType = {
    GROUP_PRESENCE_SUMMARY: 'GROUP_PRESENCE_SUMMARY',
    RTC_TOPOLOGY_RECOMPUTE: 'RTC_TOPOLOGY_RECOMPUTE',
    FORMATION_TIMER: 'FORMATION_TIMER',
    TOPOLOGY_PROMOTION: 'TOPOLOGY_PROMOTION'
} as const;

export type AppOutboxType = (typeof AppOutboxType)[keyof typeof AppOutboxType];
