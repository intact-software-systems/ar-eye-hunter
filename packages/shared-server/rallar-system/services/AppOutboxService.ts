export const AppOutboxType = {
    GROUP_PRESENCE_SUMMARY: 'GROUP_PRESENCE_SUMMARY',
    RTC_TOPOLOGY_RECOMPUTE: 'RTC_TOPOLOGY_RECOMPUTE',
} as const;

export type AppOutboxType = (typeof AppOutboxType)[keyof typeof AppOutboxType];
