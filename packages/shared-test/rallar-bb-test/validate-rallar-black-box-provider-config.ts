import {
    RALLAR_BLACK_BOX_CLIENT_DEFAULTS,
    resolveRallarBlackBoxProviderMode,
    type RallarBlackBoxProviderMode
} from './client-defaults.ts';
import type { RallarBlackBoxTestConfig, RallarBlackBoxTestError } from './rallar-black-box-test-contracts.ts';
import { decodeNonBlankText, decodeRecord } from './runtime/decode-runtime-result-values.ts';

const PROVIDER_CONFIG_INVALID = 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID';

export function resolveRallarBlackBoxConfigProviderMode(
    config: RallarBlackBoxTestConfig | undefined
): RallarBlackBoxProviderMode {
    const control = decodeRecord(config?.control);
    const defaults = decodeRecord(config?.defaults);
    return resolveRallarBlackBoxProviderMode(
        decodeNonBlankText(control.providerMode) ??
            decodeNonBlankText(control.provider) ??
            decodeNonBlankText(defaults.providerMode) ??
            decodeNonBlankText(defaults.provider)
    );
}

/** A simulated agent needs nothing; a browser-rallar agent needs a real API and a way to sign in. */
export function validateRallarBlackBoxProviderConfig(
    config: RallarBlackBoxTestConfig
): readonly RallarBlackBoxTestError[] {
    const providerMode = resolveRallarBlackBoxConfigProviderMode(config);
    if (providerMode === 'simulated') {
        return [];
    }

    const hasApiBaseUrl = Boolean(config.apiBaseUrl) &&
        config.apiBaseUrl !== RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl;
    const rallar = decodeRecord(config.rallar);
    const hasUsernamePassword = Boolean(decodeNonBlankText(rallar.username) && decodeNonBlankText(rallar.password));
    const restoreSession = rallar.restoreSession === true;
    return [
        ...(hasApiBaseUrl ? [] : [{
            code: PROVIDER_CONFIG_INVALID,
            message: 'browser-rallar provider requires a real Rallar API base URL.',
            details: { providerMode, apiBaseUrl: config.apiBaseUrl }
        }]),
        ...(hasUsernamePassword || restoreSession ? [] : [{
            code: PROVIDER_CONFIG_INVALID,
            message: 'browser-rallar provider requires rallar username/password or restoreSession=true.',
            details: { providerMode, hasApiBaseUrl, hasUsernamePassword, restoreSession }
        }])
    ];
}
