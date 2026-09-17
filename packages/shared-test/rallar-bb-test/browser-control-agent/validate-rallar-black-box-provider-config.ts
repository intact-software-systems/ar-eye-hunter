import { decodeRallarBlackBoxConfigProviderMode, RALLAR_BLACK_BOX_CLIENT_DEFAULTS } from '../client-defaults.ts';
import type { RallarBlackBoxTestConfig, RallarBlackBoxTestError } from '../rallar-black-box-test-contracts.ts';
import { decodeNonBlankText, decodeRecord } from '../runtime/decode-runtime-result-values.ts';

const PROVIDER_CONFIG_INVALID = 'RALLAR_BLACK_BOX_PROVIDER_CONFIG_INVALID';

/**
 * A configuration whose provider mode names no provider is invalid; a simulated agent needs nothing more; a
 * browser-rallar agent needs a real API and a way to sign in.
 */
export function validateRallarBlackBoxProviderConfig(
    config: RallarBlackBoxTestConfig
): readonly RallarBlackBoxTestError[] {
    return decodeRallarBlackBoxConfigProviderMode(config).fold(
        (message) => [toUnreadableProviderModeIssue(config, message)],
        (providerMode) => providerMode === 'simulated' ? [] : validateBrowserRallarProviderConfig(config)
    );
}

function validateBrowserRallarProviderConfig(config: RallarBlackBoxTestConfig): readonly RallarBlackBoxTestError[] {
    const hasApiBaseUrl = Boolean(config.apiBaseUrl) &&
        config.apiBaseUrl !== RALLAR_BLACK_BOX_CLIENT_DEFAULTS.apiBaseUrl;
    const rallar = decodeRecord(config.rallar);
    const hasUsernamePassword = Boolean(decodeNonBlankText(rallar.username) && decodeNonBlankText(rallar.password));
    const restoreSession = rallar.restoreSession === true;
    return [
        ...(hasApiBaseUrl ? [] : [{
            code: PROVIDER_CONFIG_INVALID,
            message: 'browser-rallar provider requires a real Rallar API base URL.',
            details: { providerMode: 'browser-rallar', apiBaseUrl: config.apiBaseUrl }
        }]),
        ...(hasUsernamePassword || restoreSession ? [] : [{
            code: PROVIDER_CONFIG_INVALID,
            message: 'browser-rallar provider requires rallar username/password or restoreSession=true.',
            details: { providerMode: 'browser-rallar', hasApiBaseUrl, hasUsernamePassword, restoreSession }
        }])
    ];
}

function toUnreadableProviderModeIssue(config: RallarBlackBoxTestConfig, message: string): RallarBlackBoxTestError {
    return {
        code: PROVIDER_CONFIG_INVALID,
        message,
        details: { providerMode: decodeRecord(config.control).providerMode }
    };
}
