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

interface IdentityConfigRecords {
    readonly config: RallarBlackBoxTestConfig;
    readonly rallar: RallarBlackBoxTestRecord;
    readonly defaults: RallarBlackBoxTestRecord;
    readonly browser: RallarBlackBoxTestRecord;
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

export function toControlAgentIdentity(input: ToControlAgentIdentityInput): RallarBlackBoxControlAgentIdentity {
    if (input.config === undefined) {
        return { sessionLabel: input.agentId, updatedAtEpochMs: input.atEpochMs };
    }

    const records: IdentityConfigRecords = {
        config: input.config,
        rallar: decodeRecord(input.config.rallar),
        defaults: decodeRecord(input.config.defaults),
        browser: decodeRecord(input.config.browser)
    };
    const rallarFacts = toRallarIdentityFacts(records);
    return {
        ...rallarFacts,
        browserLabel: decodeTrimmedText(records.browser.label) ??
            decodeTrimmedText(records.browser.name) ??
            decodeTrimmedText(input.userAgent),
        sessionLabel: decodeTrimmedText(records.browser.sessionLabel) ??
            toPrincipalSessionLabel(rallarFacts) ??
            input.agentId,
        ...toFleetIdentityFacts(records),
        location: input.location,
        capabilities: toControlAgentCapabilities({
            config: input.config,
            providerMode: rallarFacts.providerMode,
            apiBaseUrl: decodeTrimmedText(input.config.apiBaseUrl) ??
                decodeTrimmedText(records.rallar.apiBaseUrl) ??
                decodeTrimmedText(records.defaults.apiBaseUrl)
        }),
        updatedAtEpochMs: input.atEpochMs
    };
}

function toRallarIdentityFacts({ config, rallar, defaults }: IdentityConfigRecords): RallarIdentityFacts {
    const scope = decodeRecord(rallar.scope);
    const principalId = decodeTrimmedText(rallar.principalId) ??
        decodeTrimmedText(rallar.clientId) ??
        decodeTrimmedText(config.actor);
    return {
        principalId,
        clientId: decodeTrimmedText(rallar.clientId) ?? principalId,
        username: decodeTrimmedText(rallar.username) ?? decodeTrimmedText(config.actor) ?? principalId,
        sessionId: decodeTrimmedText(rallar.sessionId) ?? decodeTrimmedText(config.sessionId),
        clientInstanceId: decodeTrimmedText(rallar.clientInstanceId) ?? principalId,
        applicationId: decodeTrimmedText(defaults.applicationId) ??
            decodeTrimmedText(rallar.applicationId) ??
            decodeTrimmedText(scope.applicationId),
        workspaceId: decodeTrimmedText(defaults.workspaceId) ??
            decodeTrimmedText(rallar.workspaceId) ??
            decodeTrimmedText(scope.workspaceId),
        groupId: decodeTrimmedText(defaults.groupId) ??
            decodeTrimmedText(rallar.groupId) ??
            decodeTrimmedText(config.roomId),
        providerMode: decodeTrimmedText(decodeRecord(config.control).providerMode) ??
            decodeTrimmedText(defaults.providerMode) ??
            decodeTrimmedText(rallar.providerMode)
    };
}

function toFleetIdentityFacts({ config, browser }: IdentityConfigRecords): FleetIdentityFacts {
    const fleet = decodeRecord(config.fleet);
    return {
        region: decodeTrimmedText(fleet.region),
        provider: decodeTrimmedText(fleet.provider),
        datacenter: decodeTrimmedText(fleet.datacenter),
        hostId: decodeTrimmedText(fleet.hostId),
        agentPoolId: decodeTrimmedText(fleet.agentPoolId),
        deploymentId: decodeTrimmedText(fleet.deploymentId),
        browserName: decodeTrimmedText(fleet.browserName) ?? decodeTrimmedText(browser.name),
        browserVersion: decodeTrimmedText(fleet.browserVersion) ?? decodeTrimmedText(browser.version),
        os: decodeTrimmedText(fleet.os) ?? decodeTrimmedText(browser.os),
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
