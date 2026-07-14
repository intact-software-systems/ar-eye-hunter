import { resolveAppExperience } from '../../app/experience-route.ts';

export type RecipeConsoleControlCredentialPolicy = Readonly<{
    allowManualToken: boolean;
    allowBrokeredToken: boolean;
    allowBootstrapAgentTicket: boolean;
    controlUrlFromLocation: boolean;
    apiBaseUrlFromLocation: boolean;
    controlTokenFromLocation: boolean;
    blockedMessage?: string;
}>;

export const TRUSTED_RECIPE_CONSOLE_CONTROL_CREDENTIAL_POLICY = {
    allowManualToken: true,
    allowBrokeredToken: true,
    allowBootstrapAgentTicket: true,
    controlUrlFromLocation: false,
    apiBaseUrlFromLocation: false,
    controlTokenFromLocation: false,
} as const satisfies RecipeConsoleControlCredentialPolicy;

export function recipeConsoleControlCredentialPolicyFromSearch(
    search: string,
): RecipeConsoleControlCredentialPolicy {
    const params = new URLSearchParams(search);
    const controlUrlFromLocation = hasNonemptyValue(params, 'controlUrl');
    const apiBaseUrlFromLocation = hasNonemptyValue(params, 'apiBaseUrl');
    const controlTokenFromLocation = hasNonemptyValue(params, 'controlToken');
    const allowManualToken = !controlUrlFromLocation || controlTokenFromLocation;
    const allowBrokeredToken = !controlUrlFromLocation && !apiBaseUrlFromLocation;
    const allowBootstrapAgentTicket = resolveAppExperience(search) !== 'recipe-console' ||
        !apiBaseUrlFromLocation;
    const blockedMessage = controlUrlFromLocation
        ? 'Automatic stored credentials are blocked for a URL-configured control endpoint. Use a configured endpoint or supply an explicit control token from the same trusted source.'
        : apiBaseUrlFromLocation
        ? 'Automatic token brokering is blocked for a URL-configured API endpoint. Use a configured API endpoint before authorizing control access.'
        : undefined;

    return {
        allowManualToken,
        allowBrokeredToken,
        allowBootstrapAgentTicket,
        controlUrlFromLocation,
        apiBaseUrlFromLocation,
        controlTokenFromLocation,
        blockedMessage,
    };
}

function hasNonemptyValue(params: URLSearchParams, key: string): boolean {
    return Boolean(params.get(key)?.trim());
}
