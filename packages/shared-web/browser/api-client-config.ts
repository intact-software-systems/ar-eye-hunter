export type RallarApiClientConfig = Readonly<{
    apiBaseUrl?: string;
}>;

let apiBaseUrl = '';

export function configureApiClient(config: RallarApiClientConfig): void {
    apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? '');
}

export function readApiBaseUrl(): string {
    return apiBaseUrl;
}

export function normalizeApiBaseUrl(baseUrl: string): string {
    return baseUrl.trim().replace(/\/+$/, '');
}
