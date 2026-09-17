import { Either } from '@shared/resilience/Either.ts';

import type { RallarBlackBoxControlAgentIdentity, RallarBlackBoxGeoLocation } from '../distributed-run.ts';
import { toControlAgentCapabilities } from '../distributed/control-agent-capabilities.ts';
import { decodeRallarBlackBoxGeoLocation } from '../distributed/decode-control-agent-identity.ts';
import type { RallarBlackBoxTestConfig, RallarBlackBoxTestRecord } from '../rallar-black-box-test-contracts.ts';
import { decodeRecord } from '../runtime/decode-runtime-result-values.ts';

export interface ToControlAgentIdentityInput {
    /** Absent before the agent loads a test configuration. */
    readonly config: RallarBlackBoxTestConfig | undefined;
    readonly agentId: string;
    /** Absent when the page exposes no user agent. */
    readonly userAgent: string | undefined;
    /** Absent when the configuration names no readable fleet location. */
    readonly location: RallarBlackBoxGeoLocation | undefined;
    readonly atEpochMs: number;
}

/** The configuration sections the identity reads, each an empty record when the configuration has none. */
interface IdentityConfigRecords {
    readonly config: RallarBlackBoxTestConfig;
    readonly rallar: RallarBlackBoxTestRecord;
    readonly defaults: RallarBlackBoxTestRecord;
    readonly control: RallarBlackBoxTestRecord;
    readonly fleet: RallarBlackBoxTestRecord;
}

type RallarIdentityFacts = Pick<
    RallarBlackBoxControlAgentIdentity,
    | 'principalId'
    | 'clientId'
    | 'username'
    | 'sessionId'
    | 'clientInstanceId'
    | 'applicationId'
    | 'workspaceId'
    | 'groupId'
    | 'providerMode'
>;

type FleetIdentityFacts = Pick<
    RallarBlackBoxControlAgentIdentity,
    | 'region'
    | 'provider'
    | 'datacenter'
    | 'hostId'
    | 'agentPoolId'
    | 'deploymentId'
    | 'browserName'
    | 'browserVersion'
    | 'os'
    | 'tags'
>;

/** A configured fleet location must decode completely; the agent never fills in a missing precision. */
export function decodeControlAgentFleetLocation(
    config: RallarBlackBoxTestConfig | undefined
): Either<string, Pick<RallarBlackBoxControlAgentIdentity, 'location'>> {
    const location = decodeRecord(config?.fleet).location;
    return location === undefined
        ? Either.ofRight({})
        : decodeRallarBlackBoxGeoLocation(location).mapRight((decoded) => ({ location: decoded }));
}

/** Reads only the keys configuration producers write; the principal is the configured actor. */
export function toControlAgentIdentity(input: ToControlAgentIdentityInput): RallarBlackBoxControlAgentIdentity {
    if (input.config === undefined) {
        return { sessionLabel: input.agentId, updatedAtEpochMs: input.atEpochMs };
    }

    const records: IdentityConfigRecords = {
        config: input.config,
        rallar: decodeRecord(input.config.rallar),
        defaults: decodeRecord(input.config.defaults),
        control: decodeRecord(input.config.control),
        fleet: decodeRecord(input.config.fleet)
    };
    const rallarFacts = toRallarIdentityFacts(records);
    return {
        ...rallarFacts,
        browserLabel: decodeTrimmedText(input.userAgent),
        sessionLabel: toPrincipalSessionLabel(rallarFacts) ?? input.agentId,
        ...toFleetIdentityFacts(records.fleet),
        location: input.location,
        capabilities: toControlAgentCapabilities({
            config: input.config,
            providerMode: rallarFacts.providerMode,
            apiBaseUrl: decodeTrimmedText(input.config.apiBaseUrl) ?? decodeTrimmedText(records.rallar.apiBaseUrl)
        }),
        updatedAtEpochMs: input.atEpochMs
    };
}

function toRallarIdentityFacts({ config, rallar, defaults, control }: IdentityConfigRecords): RallarIdentityFacts {
    const principalId = decodeTrimmedText(config.actor);
    return {
        principalId,
        clientId: principalId,
        username: decodeTrimmedText(rallar.username) ?? principalId,
        sessionId: decodeTrimmedText(config.sessionId),
        clientInstanceId: principalId,
        applicationId: decodeTrimmedText(defaults.applicationId) ?? decodeTrimmedText(rallar.applicationId),
        workspaceId: decodeTrimmedText(defaults.workspaceId) ?? decodeTrimmedText(rallar.workspaceId),
        groupId: decodeTrimmedText(defaults.groupId) ?? decodeTrimmedText(config.roomId),
        providerMode: decodeTrimmedText(control.providerMode)
    };
}

function toFleetIdentityFacts(fleet: RallarBlackBoxTestRecord): FleetIdentityFacts {
    return {
        region: decodeTrimmedText(fleet.region),
        provider: decodeTrimmedText(fleet.provider),
        datacenter: decodeTrimmedText(fleet.datacenter),
        hostId: decodeTrimmedText(fleet.hostId),
        agentPoolId: decodeTrimmedText(fleet.agentPoolId),
        deploymentId: decodeTrimmedText(fleet.deploymentId),
        browserName: decodeTrimmedText(fleet.browserName),
        browserVersion: decodeTrimmedText(fleet.browserVersion),
        os: decodeTrimmedText(fleet.os),
        tags: decodeTags(fleet.tags)
    };
}

function toPrincipalSessionLabel(facts: RallarIdentityFacts): string | undefined {
    return facts.sessionId && facts.principalId ? `${facts.principalId}:${facts.sessionId}` : undefined;
}

function decodeTrimmedText(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function decodeTags(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value)) {
        return undefined;
    }
    const tags = value.flatMap((entry) => {
        const tag = decodeTrimmedText(entry);
        return tag === undefined ? [] : [tag];
    });
    return tags.length > 0 ? tags : undefined;
}
