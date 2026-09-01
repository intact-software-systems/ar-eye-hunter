// deno-lint-ignore-file no-explicit-any
import { createRallarBrowserRtcProvider } from '../rallar-browser-rtc-provider.ts';
import { createRallarInMemoryProvider } from '../rallar-in-memory-runtime.ts';
import { createRallarRemoteBrowserRtcProvider } from '../rallar-remote-browser-provider.ts';
import { createRallarStubRtcProvider } from '../rallar-stub-rtc-provider.ts';
import { createRallarWebRtcWebSocketSignalingProvider } from '../rallar-webrtc-runtime.ts';
import { toRtcFailureStatus, type RtcProvider } from '../rtc-provider.ts';
import { normalizeRedactions } from './black-box-redaction.ts';
import { toRunnerCorrelationConfig } from './black-box-run-correlation.ts';
import {
    defaultEnvironment,
    resolveBlackBoxVariables
} from './black-box-run-secrets.ts';

export function createMissingRtcProvider(providerName: string): RtcProvider {
    const missing = (interaction: any, config: any, context: any): Promise<any> => {
        return Promise.resolve(toRtcFailureStatus(
            config,
            interaction,
            'RTC provider is not configured: ' + providerName,
            {
                availableProviders: Object.keys(context.rtcProviders || {})
            }
        ));
    };

    return {
        connect: missing,
        send: missing,
        wait: missing,
        close: missing
    };
}

function createRtcProviders(): Record<string, RtcProvider> {
    const signalingProvider = createRallarWebRtcWebSocketSignalingProvider();
    return {
        'rallar-signaling': signalingProvider,
        'rallar-stub': createRallarStubRtcProvider(),
        'rallar-memory': createRallarInMemoryProvider(),
        'rallar-browser': createRallarBrowserRtcProvider(),
        'rallar-remote-browser': createRallarRemoteBrowserRtcProvider()
    };
}

export function createScenarioContext(options: any = {}): any {
    const resolvedVariables = resolveBlackBoxVariables(
        options.variables || {},
        options.environment || defaultEnvironment(),
        options.secretVariables || options.secrets || []
    );
    const correlation = toRunnerCorrelationConfig(options);

    return {
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
            ...createRtcProviders(),
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
