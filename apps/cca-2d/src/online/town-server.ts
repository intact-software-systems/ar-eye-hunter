export const CCA_SCOPE = { applicationId: 'cca-2d', workspaceId: 'default' } as const;
export const townApiBaseUrl = import.meta.env.VITE_RALLAR_API_BASE_URL || location.origin;
export const townGroupPresence = { leaseMs: 8_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 500 };
