function toEnvOrThrow(name: string): string {
    const v = Deno.env.get(name);
    if (!v || v.length === 0) {
        throw new Error(`Missing env var: ${name}`);
    }

    return v;
}

export async function getIceCandidates(): Promise<Response> {
    const appName = toEnvOrThrow('METERED_APP_NAME');
    const apiKey = toEnvOrThrow('METERED_API_KEY');

    const region = Deno.env.get('METERED_REGION') ?? '';

    // Metered docs:
    // GET https://<appname>.metered.live/api/v1/turn/credentials?apiKey=...(&region=...)
    // Returns an array of iceServers entries (stun/turn urls + username/credential).  [oai_citation:1‡Metered](https://www.metered.ca/docs/turn-rest-api/get-credential/)
    const url = new URL(`https://${appName}.metered.live/api/v1/turn/credentials`);
    url.searchParams.set('apiKey', apiKey);
    if (region.length > 0) {
        url.searchParams.set('region', region);
    }

    return await fetch(url.toString(), { method: 'GET' });
}
