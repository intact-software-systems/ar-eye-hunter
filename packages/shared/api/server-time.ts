/** A fresh observation from the configured Rallar server, never a cacheable configuration value. */
export interface ServerTimeResponse {
    readonly serverPeerId: string;
    readonly serverNowEpochMs: number;
}
