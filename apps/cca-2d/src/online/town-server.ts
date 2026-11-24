export const CCA_SCOPE = { applicationId: 'cca-2d', workspaceId: 'default' } as const;
export const townApiBaseUrl = import.meta.env.VITE_RALLAR_API_BASE_URL || location.origin;
// Leaves four seconds for a mobile clock sample to widen while the room can still renew safely.
export const townGroupPresence = { leaseMs: 9_000, renewalIntervalMs: 1_000, requestTimeoutMs: 1_250, retryMs: 250 };
