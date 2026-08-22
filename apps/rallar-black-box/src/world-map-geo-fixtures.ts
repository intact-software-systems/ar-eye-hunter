import type { RallarBlackBoxGeoLocation } from '@shared-test/rallar-bb-test/distributed-run.ts';
import {
    resolveFleetGeographyDocumentedLocation,
    type FleetGeographyDocumentedLocationInput
} from '@shared-test/rallar-bb-test/fleet-geography.ts';

export type FleetWorldMapLocationSource =
    | 'agent'
    | 'datacenter-lookup'
    | 'region-lookup';

export type FleetWorldMapLocation =
    & RallarBlackBoxGeoLocation
    & Readonly<{
        label: string;
        precision: 'exact' | 'approximate';
        source: FleetWorldMapLocationSource;
    }>;

export type FleetWorldMapLocationInput = FleetGeographyDocumentedLocationInput;

export function resolveFleetWorldMapLocation(
    input: FleetWorldMapLocationInput
): FleetWorldMapLocation | undefined {
    const location = resolveFleetGeographyDocumentedLocation(input);
    return location
        ? {
            ...location,
            source: location.source === 'explicit'
                ? 'agent'
                : location.source
        }
        : undefined;
}
