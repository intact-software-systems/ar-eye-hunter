export const GRUMPY_TOWN_SCOPE = { applicationId: 'grumpy-town', workspaceId: 'default' } as const;
export const townApiBaseUrl = import.meta.env.VITE_RALLAR_API_BASE_URL || location.origin;
// Leaves 3.75 seconds for a mobile clock sample to widen while the room can still renew safely.
export const townGroupPresence = { leaseMs: 11_000, renewalIntervalMs: 1_000, requestTimeoutMs: 2_000, retryMs: 250 };
