export function fleetRegionProviderKey(
    region: string,
    provider: string | undefined,
): string {
    return JSON.stringify([region, provider ?? null]);
}
