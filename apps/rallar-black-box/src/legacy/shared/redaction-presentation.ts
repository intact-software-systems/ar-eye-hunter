import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { RallarBlackBoxTestRedactionOptions, RallarBlackBoxTestState } from '@shared-test/rallar-bb-test/types.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { json } from './json-presentation.ts';

export function uiSecretValues(
    state?: RallarBlackBoxTestState,
    authSession?: AuthSession,
    extraValues: readonly (string | undefined)[] = []
): readonly string[] {
    return [
        ...(state?.currentConfig?.redaction?.secretValues ?? []),
        authSession?.accessToken,
        authSession ? `Bearer ${authSession.accessToken}` : undefined,
        ...extraValues
    ].filter((entry): entry is string => Boolean(entry && entry.length > 0));
}

export function uiRedactionOptions(
    state?: RallarBlackBoxTestState,
    authSession?: AuthSession,
    extraValues: readonly (string | undefined)[] = []
): RallarBlackBoxTestRedactionOptions {
    const base = state?.currentConfig?.redaction ?? {};
    return {
        ...base,
        secretValues: uiSecretValues(state, authSession, extraValues)
    };
}

export function redactedJson(
    value: unknown,
    state?: RallarBlackBoxTestState,
    authSession?: AuthSession,
    extraValues: readonly (string | undefined)[] = []
): string {
    return json(
        redactRallarBlackBoxValue(
            value,
            uiRedactionOptions(state, authSession, extraValues)
        )
    );
}
