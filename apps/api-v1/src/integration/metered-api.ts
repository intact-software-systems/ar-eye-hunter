import type { ApiV1MeteredIceConfiguration } from '../configuration/api-v1-configuration.ts';

export async function getIceCandidates(
    configuration: ApiV1MeteredIceConfiguration
): Promise<Response> {
    // Metered docs:
    // GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=...(&region=...)
    // Returns an array of iceServers entries (stun/turn urls + username/credential).  [oai_citation:1‡Metered](https://www.metered.ca/docs/turn-rest-api/get-credential/)
    const url = new URL(
        `https://${configuration.appName}.metered.live/api/v1/turn/credentials`
    );
    url.searchParams.set('apiKey', configuration.apiKey);
    if (configuration.region.length > 0) {
        url.searchParams.set('region', configuration.region);
    }

    return await fetch(url.toString(), { method: 'GET' });
}
