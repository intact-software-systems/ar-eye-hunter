import type { RallarBlackBoxControlAgentIdentity, RallarBlackBoxGeoLocation } from '../distributed-run.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeControlAgentCapabilities } from './control-agent-capabilities.ts';

export function decodeControlAgentIdentity(value: unknown): RallarBlackBoxControlAgentIdentity | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }

    const identity: RallarBlackBoxControlAgentIdentity = {
        principalId: decodeNonEmptyText(value.principalId),
        clientId: decodeNonEmptyText(value.clientId),
        username: decodeNonEmptyText(value.username),
        sessionId: decodeNonEmptyText(value.sessionId),
        clientInstanceId: decodeNonEmptyText(value.clientInstanceId),
        applicationId: decodeNonEmptyText(value.applicationId),
        workspaceId: decodeNonEmptyText(value.workspaceId),
        groupId: decodeNonEmptyText(value.groupId),
        providerMode: decodeNonEmptyText(value.providerMode),
        browserLabel: decodeNonEmptyText(value.browserLabel),
        sessionLabel: decodeNonEmptyText(value.sessionLabel),
        region: decodeNonEmptyText(value.region),
        provider: decodeNonEmptyText(value.provider),
        datacenter: decodeNonEmptyText(value.datacenter),
        hostId: decodeNonEmptyText(value.hostId),
        agentPoolId: decodeNonEmptyText(value.agentPoolId),
        deploymentId: decodeNonEmptyText(value.deploymentId),
        browserName: decodeNonEmptyText(value.browserName),
        browserVersion: decodeNonEmptyText(value.browserVersion),
        os: decodeNonEmptyText(value.os),
        tags: decodeTags(value.tags),
        location: decodeGeoLocation(value.location),
        capabilities: decodeControlAgentCapabilities(value.capabilities).right,
        updatedAtEpochMs: typeof value.updatedAtEpochMs === 'number' ? value.updatedAtEpochMs : undefined
    };

    return Object.values(identity).some((entry) => entry !== undefined) ? identity : undefined;
}

function decodeNonEmptyText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function decodeGeoLocation(value: unknown): RallarBlackBoxGeoLocation | undefined {
    if (!isJsonRecordValue(value)) {
        return undefined;
    }
    const { latitude, longitude } = value;
    if (!isCoordinate(latitude, 90) || !isCoordinate(longitude, 180)) {
        return undefined;
    }

    return {
        latitude,
        longitude,
        label: decodeNonEmptyText(value.label),
        precision: value.precision === 'approximate' ? 'approximate' : 'exact'
    };
}

function isCoordinate(value: unknown, limit: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}

function decodeTags(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const tags = value
        .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
        .map((entry) => entry.trim());
    return tags.length > 0 ? tags : undefined;
}
