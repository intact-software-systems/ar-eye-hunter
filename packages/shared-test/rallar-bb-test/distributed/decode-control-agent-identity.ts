import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxControlAgentIdentity } from '../distributed-run.ts';
import { isJsonRecordValue } from '../schema/json-schema-validation.ts';
import { decodeControlAgentCapabilities } from './control-agent-capabilities.ts';

const OPTIONAL_IDENTITY_TEXTS = [
    'principalId',
    'clientId',
    'username',
    'sessionId',
    'clientInstanceId',
    'applicationId',
    'workspaceId',
    'groupId',
    'providerMode',
    'browserLabel',
    'region',
    'provider',
    'datacenter',
    'hostId',
    'agentPoolId',
    'deploymentId',
    'browserName',
    'browserVersion',
    'os'
] as const satisfies readonly (keyof RallarBlackBoxControlAgentIdentity)[];

type OptionalIdentityTexts = Partial<Record<typeof OPTIONAL_IDENTITY_TEXTS[number], string>>;

interface DecodedIdentityParts {
    readonly facts:
        & OptionalIdentityTexts
        & Pick<RallarBlackBoxControlAgentIdentity, 'sessionLabel' | 'updatedAtEpochMs' | 'tags'>;
    readonly location: Either<string, Pick<RallarBlackBoxControlAgentIdentity, 'location'>>;
    readonly capabilities: Either<string, Pick<RallarBlackBoxControlAgentIdentity, 'capabilities'>>;
}

const GEO_LOCATION_ISSUE = 'identity.location must carry latitude, longitude and an exact or approximate precision';

/** The identity an agent reports; a present but unreadable fact rejects the identity instead of reading as absent. */
export function decodeControlAgentIdentity(value: unknown): Either<string, RallarBlackBoxControlAgentIdentity> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('identity must be a JSON object');
    }
    const { sessionLabel, updatedAtEpochMs, tags } = value;
    if (!isNonEmptyText(sessionLabel)) {
        return Either.ofLeft('identity.sessionLabel must be a non-empty string');
    }
    if (typeof updatedAtEpochMs !== 'number' || !Number.isFinite(updatedAtEpochMs)) {
        return Either.ofLeft('identity.updatedAtEpochMs must be a finite number');
    }
    if (tags !== undefined && !(Array.isArray(tags) && tags.every(isNonEmptyText))) {
        return Either.ofLeft('identity.tags must list non-empty strings when present');
    }
    const location = decodeOptionalGeoLocation(value.location);
    const capabilities = decodeOptionalCapabilities(value.capabilities);
    return decodeOptionalIdentityTexts(value).flatMap(
        (issue) => Either.ofLeft(issue),
        (texts) =>
            toDecodedIdentity({
                facts: { ...texts, sessionLabel, updatedAtEpochMs, ...(tags === undefined ? {} : { tags }) },
                location,
                capabilities
            })
    );
}

function toDecodedIdentity(parts: DecodedIdentityParts): Either<string, RallarBlackBoxControlAgentIdentity> {
    return parts.location.flatMap(
        (issue) => Either.ofLeft(issue),
        (location) => parts.capabilities.mapRight((capabilities) => ({ ...parts.facts, ...location, ...capabilities }))
    );
}

function decodeOptionalIdentityTexts(value: unknown): Either<string, OptionalIdentityTexts> {
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft('identity must be a JSON object');
    }
    const texts: OptionalIdentityTexts = {};
    for (const key of OPTIONAL_IDENTITY_TEXTS) {
        const text = value[key];
        if (text === undefined) {
            continue;
        }
        if (!isNonEmptyText(text)) {
            return Either.ofLeft(`identity.${key} must be a non-empty string when present`);
        }
        texts[key] = text;
    }
    return Either.ofRight(texts);
}

function decodeOptionalGeoLocation(
    value: unknown
): Either<string, Pick<RallarBlackBoxControlAgentIdentity, 'location'>> {
    if (value === undefined) {
        return Either.ofRight({});
    }
    if (!isJsonRecordValue(value)) {
        return Either.ofLeft(GEO_LOCATION_ISSUE);
    }
    const { latitude, longitude, label, precision } = value;
    return isCoordinate(latitude, 90) &&
            isCoordinate(longitude, 180) &&
            (precision === 'exact' || precision === 'approximate') &&
            (label === undefined || isNonEmptyText(label))
        ? Either.ofRight({ location: { latitude, longitude, ...(label === undefined ? {} : { label }), precision } })
        : Either.ofLeft(GEO_LOCATION_ISSUE);
}

function decodeOptionalCapabilities(
    value: unknown
): Either<string, Pick<RallarBlackBoxControlAgentIdentity, 'capabilities'>> {
    return value === undefined
        ? Either.ofRight({})
        : decodeControlAgentCapabilities(value)
            .mapBoth((issue) => `identity.${issue}`, (capabilities) => ({ capabilities }));
}

function isCoordinate(value: unknown, limit: number): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= -limit && value <= limit;
}

function isNonEmptyText(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}
