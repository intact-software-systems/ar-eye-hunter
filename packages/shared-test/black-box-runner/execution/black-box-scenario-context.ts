// deno-lint-ignore-file no-explicit-any
import { createRallarStubRtcProvider } from '../create-rallar-stub-rtc-provider.ts';
import { createRallarBrowserRtcProvider } from '../rallar-browser-rtc-provider.ts';
import {
    createRallarInMemoryProvider,
    createRallarInMemoryRuntimeState
} from '../rallar-in-memory-runtime.ts';
import { createRallarRemoteBrowserRtcProvider } from '../rallar-remote-browser-provider.ts';
import { createRallarWebRtcWebSocketSignalingProvider } from '../rallar-webrtc-runtime.ts';
import { type RtcProvider } from '../rtc-provider.ts';
import { toRtcFailureStatus } from '../rtc/rtc-wait-expectations.ts';
import { normalizeRedactions } from './black-box-redaction.ts';
import { toRunnerCorrelationConfig } from './black-box-run-correlation.ts';
import {
    defaultEnvironment,
    resolveBlackBoxVariables
} from './black-box-run-secrets.ts';

export interface BlackBoxExecutionDependencies {
    readonly now: () => number;
    readonly createUuid: () => string;
}

export function createDefaultExecutionDependencies(): BlackBoxExecutionDependencies {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    const random = Math.random;
    return {
        now: Date.now,
        createUuid: cryptoApi?.randomUUID
            ? cryptoApi.randomUUID.bind(cryptoApi)
            : () => randomUuid(random)
    };
}

function randomUuid(random: () => number): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
        const digit = Math.floor(random() * 16);
        const value = character === 'x' ? digit : (digit & 0x3) | 0x8;
        return value.toString(16);
    });
}

export function createMissingRtcProvider(providerName: string): RtcProvider {
    const missing = (interaction: any, config: any, context: any): Promise<any> => {
        return Promise.resolve(
            toRtcFailureStatus({
                config: config,
                interaction: interaction,
                result: 'RTC provider is not configured: ' + providerName,
                details: {
                    availableProviders: Object.keys(context.rtcProviders || {})
                }
            })
        );
    };

    return {
        connect: missing,
        send: missing,
        wait: missing,
        close: missing
    };
}

function createRtcProviders(dependencies: BlackBoxExecutionDependencies): Record<string, RtcProvider> {
    const signalingProvider = createRallarWebRtcWebSocketSignalingProvider({ now: dependencies.now });
    return {
        'rallar-signaling': signalingProvider,
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider({
            now: dependencies.now,
            state: createRallarInMemoryRuntimeState()
        }),
        'rallar-browser': createRallarBrowserRtcProvider(),
        'rallar-remote-browser': createRallarRemoteBrowserRtcProvider()
    };
}

export interface CreateScenarioContextInput {
    readonly options: any;
    readonly dependencies: BlackBoxExecutionDependencies;
}

export function createScenarioContext(input: CreateScenarioContextInput): any {
    const { options, dependencies } = input;
    const environment = defaultEnvironment();
    const resolvedVariables = resolveBlackBoxVariables(
        options.variables || {},
        options.environment || environment,
        options.secretVariables || options.secrets || []
    );
    const correlation = toRunnerCorrelationConfig({ options, createUuid: dependencies.createUuid });

    return {
        dependencies,
        remoteBrowserEnvironment: {
            RALLAR_BLACK_BOX_CONTROL_BASE_URL: environment.RALLAR_BLACK_BOX_CONTROL_BASE_URL,
            RALLAR_BLACK_BOX_RUN_ID: environment.RALLAR_BLACK_BOX_RUN_ID,
            RALLAR_BLACK_BOX_AGENT_ID: environment.RALLAR_BLACK_BOX_AGENT_ID,
            RALLAR_BLACK_BOX_CONTROL_TOKEN: environment.RALLAR_BLACK_BOX_CONTROL_TOKEN
        },
        variables: resolvedVariables.variables,
        outputs: {},
        results: {},
        resultsList: [],
        resultsByName: {},
        wsConnections: {},
        wsMessages: {},
        wsCloseEvents: {},
        rtcConnections: {},
        rtcMessages: {},
        rtcDiagnostics: {},
        rtcCloseEvents: {},
        rtcProviders: {
            ...createRtcProviders(dependencies),
            ...options.rtcProviders
        },
        options,
        dryRun: options?.dryRun === true,
        correlation,
        redactions: [
            ...resolvedVariables.redactions,
            ...normalizeRedactions(options.redactions)
        ]
    };
}
