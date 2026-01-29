export type IceConfig = {
    readonly iceServers: readonly RTCIceServer[];
    readonly expiresAtEpochMs: number;
};

function httpBaseUrl(): string {
    const env = (import.meta as any).env;
    const raw = (env?.VITE_API_BASE_URL as string) || '';
    return raw.length > 0 ? raw : '';
}

export async function fetchIceConfig(): Promise<IceConfig> {
    const base = httpBaseUrl();
    const res = await fetch(`${base}/api/webrtc/ice`);
    if (!res.ok) throw new Error(`ICE config fetch failed: ${res.status}`);
    return (await res.json()) as IceConfig;
}