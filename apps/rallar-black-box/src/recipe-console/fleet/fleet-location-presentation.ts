import type { FleetGeographyLocation } from '@shared-test/rallar-bb-test/fleet-geography.ts';

export function fleetLocationProvenance(
    location: FleetGeographyLocation
): string {
    return `${location.source.replaceAll('-', ' ')} · ${location.precision}`;
}
