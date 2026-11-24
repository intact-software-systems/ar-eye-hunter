export const CCA_SCOPE = { applicationId: 'cca-2d', workspaceId: 'default' } as const;
export const townApiBaseUrl = import.meta.env.VITE_RALLAR_API_BASE_URL ||
    (import.meta.env.DEV ? 'http://localhost:8084' : location.origin);
