import { ApiV1ConfigurationError } from './api-v1-configuration-error.ts';
import type { ApiV1Configuration, ApiV1ConfigurationProfile } from './api-v1-configuration.ts';
import type { ApiV1ConfigurationSourceValue } from './decode-api-v1-configuration-source.ts';
import { decodeApiV1Configuration } from './decode-api-v1-configuration.ts';
import {
    readApiV1ConfigurationEnvironment,
    type ApiV1ConfigurationEnvironment
} from './read-api-v1-configuration-environment.ts';

export interface ReadApiV1ConfigurationInput {
    readonly environment: ApiV1ConfigurationEnvironment;
    readonly readTextFile: (url: URL) => Promise<string>;
    readonly defaultsUrl: URL;
    readonly profileUrls: Readonly<Record<ApiV1ConfigurationProfile['name'], URL>>;
    readonly staticClientsUrl: URL;
}

export interface ApiV1ConfigurationStartupSummary {
    readonly profile: ApiV1ConfigurationProfile['name'];
    readonly productionHardening: boolean;
    readonly databaseMode: ApiV1Configuration['database']['mode'];
    readonly databasePubSub: ApiV1Configuration['database']['pubSub'];
    readonly iceMode: ApiV1Configuration['ice']['mode'];
    readonly publicApi: {
        readonly apiBaseUrl: string;
        readonly wsBaseUrl: string;
    };
    readonly corsOrigins: readonly string[];
    readonly workerCategories: {
        readonly apiQueue: ApiV1Configuration['topology']['replay']['queueWorkers'];
        readonly rtcTopologyReplay: ApiV1Configuration['topology']['replay']['mode'];
    };
    readonly appliedEnvironmentOverrideNames: readonly string[];
}

interface ApiV1ConfigurationStartupSummaryInput {
    readonly profile: ApiV1Configuration['profile'];
    readonly http: Pick<ApiV1Configuration['http'], 'corsOrigins'>;
    readonly publicApi: ApiV1Configuration['publicApi'];
    readonly database: Pick<ApiV1Configuration['database'], 'mode' | 'pubSub'>;
    readonly topology: {
        readonly replay: ApiV1Configuration['topology']['replay'];
    };
    readonly ice: Pick<ApiV1Configuration['ice'], 'mode'>;
}

export async function readApiV1Configuration(
    input: ReadApiV1ConfigurationInput
): Promise<ApiV1Configuration> {
    const environment = readApiV1ConfigurationEnvironment(input.environment);
    const [defaultsSource, profileSource, staticClientsSource] = await Promise.all([
        readJsonConfigurationResource(input, input.defaultsUrl, 'defaults'),
        readJsonConfigurationResource(
            input,
            input.profileUrls[environment.profileName],
            'profile'
        ),
        readJsonConfigurationResource(input, input.staticClientsUrl, 'authentication.staticClients')
    ]);
    const configuration = decodeApiV1Configuration({
        profileName: environment.profileName,
        defaultsSource,
        profileSource,
        environmentSource: environment.environmentSource,
        appliedEnvironmentOverrideNames: environment.appliedEnvironmentOverrideNames,
        secretsSource: environment.secretsSource,
        staticClientsSource
    });
    recursivelyFreeze(configuration);
    return configuration;
}

export function toApiV1ConfigurationStartupSummary(
    configuration: ApiV1ConfigurationStartupSummaryInput
): ApiV1ConfigurationStartupSummary {
    return {
        profile: configuration.profile.name,
        productionHardening: configuration.profile.productionHardening,
        databaseMode: configuration.database.mode,
        databasePubSub: configuration.database.pubSub,
        iceMode: configuration.ice.mode,
        publicApi: {
            apiBaseUrl: configuration.publicApi.apiBaseUrl,
            wsBaseUrl: configuration.publicApi.wsBaseUrl
        },
        corsOrigins: [...configuration.http.corsOrigins],
        workerCategories: {
            apiQueue: configuration.topology.replay.queueWorkers,
            rtcTopologyReplay: configuration.topology.replay.mode
        },
        appliedEnvironmentOverrideNames: [
            ...configuration.profile.appliedEnvironmentOverrideNames
        ]
    };
}

async function readJsonConfigurationResource(
    input: ReadApiV1ConfigurationInput,
    url: URL,
    path: string
): Promise<ApiV1ConfigurationSourceValue> {
    try {
        return JSON.parse(await input.readTextFile(url)) as ApiV1ConfigurationSourceValue;
    }
    catch {
        throw new ApiV1ConfigurationError([{
            source: path === 'profile' ? 'profile' : 'defaults',
            path,
            code: 'invalid-resource',
            message: 'Configuration resource could not be read as JSON.'
        }]);
    }
}

function recursivelyFreeze(value: object): void {
    for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
        const child = descriptor.value;
        if (typeof child === 'object' && child !== null && !Object.isFrozen(child)) {
            recursivelyFreeze(child);
        }
    }
    Object.freeze(value);
}
