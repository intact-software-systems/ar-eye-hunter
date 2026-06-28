import type { RallarBlackBoxGeoLocation } from '@shared-test/rallar-bb-test/distributed-run.ts';

export type FleetWorldMapLocationSource =
    | 'agent'
    | 'datacenter-lookup'
    | 'region-lookup';

export type FleetWorldMapLocation = RallarBlackBoxGeoLocation & Readonly<{
    label: string;
    precision: 'exact' | 'approximate';
    source: FleetWorldMapLocationSource;
}>;

export type FleetWorldMapLocationInput = Readonly<{
    location?: RallarBlackBoxGeoLocation;
    region?: string;
    provider?: string;
    datacenter?: string;
}>;

const DATACENTER_LOCATIONS: Readonly<Record<string, FleetWorldMapLocation>> = {
    'hetzner/fsn1': {
        latitude: 52.5333,
        longitude: 13.3833,
        label: 'Hetzner FSN1, Germany',
        precision: 'approximate',
        source: 'datacenter-lookup',
    },
    'hetzner/nbg1': {
        latitude: 49.4521,
        longitude: 11.0767,
        label: 'Hetzner NBG1, Germany',
        precision: 'approximate',
        source: 'datacenter-lookup',
    },
    'hetzner/hel1': {
        latitude: 60.1699,
        longitude: 24.9384,
        label: 'Hetzner HEL1, Finland',
        precision: 'approximate',
        source: 'datacenter-lookup',
    },
    'hetzner/ash': {
        latitude: 39.0438,
        longitude: -77.4874,
        label: 'Hetzner ASH, US East',
        precision: 'approximate',
        source: 'datacenter-lookup',
    },
    'hetzner/hil': {
        latitude: 45.5229,
        longitude: -122.9898,
        label: 'Hetzner HIL, US West',
        precision: 'approximate',
        source: 'datacenter-lookup',
    },
} as const;

const REGION_LOCATIONS: Readonly<Record<string, FleetWorldMapLocation>> = {
    'eu-north': {
        latitude: 60.0,
        longitude: 18.0,
        label: 'Europe north',
        precision: 'approximate',
        source: 'region-lookup',
    },
    'eu-central': {
        latitude: 50.8,
        longitude: 10.3,
        label: 'Europe central',
        precision: 'approximate',
        source: 'region-lookup',
    },
    'eu-west': {
        latitude: 53.0,
        longitude: -7.5,
        label: 'Europe west',
        precision: 'approximate',
        source: 'region-lookup',
    },
    'us-east': {
        latitude: 39.5,
        longitude: -77.0,
        label: 'US east',
        precision: 'approximate',
        source: 'region-lookup',
    },
    'us-west': {
        latitude: 45.5,
        longitude: -122.6,
        label: 'US west',
        precision: 'approximate',
        source: 'region-lookup',
    },
} as const;

export function resolveFleetWorldMapLocation(
    input: FleetWorldMapLocationInput,
): FleetWorldMapLocation | undefined {
    const explicit = explicitFleetLocation(input.location);
    if (explicit) {
        return explicit;
    }

    const provider = normalizeKey(input.provider);
    const datacenter = normalizeKey(input.datacenter);
    if (provider && datacenter) {
        const datacenterLocation = DATACENTER_LOCATIONS[`${provider}/${datacenter}`];
        if (datacenterLocation) {
            return datacenterLocation;
        }
    }

    const region = normalizeKey(input.region);
    return region ? REGION_LOCATIONS[region] : undefined;
}

function explicitFleetLocation(
    location: RallarBlackBoxGeoLocation | undefined,
): FleetWorldMapLocation | undefined {
    if (
        location === undefined ||
        !Number.isFinite(location.latitude) ||
        !Number.isFinite(location.longitude) ||
        location.latitude < -90 ||
        location.latitude > 90 ||
        location.longitude < -180 ||
        location.longitude > 180
    ) {
        return undefined;
    }

    return {
        latitude: location.latitude,
        longitude: location.longitude,
        label: location.label ?? 'Agent location',
        precision: location.precision ?? 'exact',
        source: 'agent',
    };
}

function normalizeKey(value: string | undefined): string | undefined {
    const normalized = value?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : undefined;
}
