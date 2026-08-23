import type { ApiV1MeteredIceConfiguration } from '../configuration/api-v1-configuration.ts';

export async function getMeteredIceCandidates(
    configuration: ApiV1MeteredIceConfiguration
): Promise<Response> {
    // Metered docs:
    // GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=...(&region=...)
    // Returns ICE server entries with STUN/TURN URLs and short-lived credentials.
    const url = new URL(
        `https://${configuration.appName}.metered.live/api/v1/turn/credentials`
    );
    url.searchParams.set('apiKey', configuration.apiKey);
    if (configuration.region.length > 0) {
        url.searchParams.set('region', configuration.region);
    }

    return await fetch(url.toString(), { method: 'GET' });
}
