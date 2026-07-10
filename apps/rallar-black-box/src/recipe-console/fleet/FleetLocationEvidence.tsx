import type { FleetGeographyLocation } from
    '@shared-test/rallar-bb-test/fleet-geography.ts';
import { fleetLocationProvenance } from './fleet-location-presentation.ts';

export function FleetLocationEvidence({
    location,
}: Readonly<{ location: FleetGeographyLocation }>) {
    return (
        <span data-fleet-location-evidence>
            <bdi dir="auto">{location.label}</bdi> ·{' '}
            {coordinate(location.latitude)}°, {coordinate(location.longitude)}° ·{' '}
            {fleetLocationProvenance(location)}
        </span>
    );
}

function coordinate(value: number): string {
    return value.toLocaleString('en-US', {
        maximumFractionDigits: 6,
        useGrouping: false,
    });
}
