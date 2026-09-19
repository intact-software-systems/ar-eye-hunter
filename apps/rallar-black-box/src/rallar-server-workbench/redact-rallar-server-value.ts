import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { AuthSession } from '@shared/api/api-config.ts';

export function redactRallarServerValue<T>(value: T, authSession: AuthSession | undefined): T {
    return redactRallarBlackBoxValue(value, {
        secretValues: authSession ? [authSession.accessToken, `Bearer ${authSession.accessToken}`].filter(Boolean) : []
    });
}

export function redactRallarServerText(text: string, authSession: AuthSession | undefined): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return text;
    }
    try {
        return JSON.stringify(redactRallarServerValue(JSON.parse(trimmed), authSession), null, 2);
    }
    catch {
        return redactRallarServerValue(text, authSession);
    }
}

export function redactRallarServerUrl(url: string, authSession: AuthSession | undefined): string {
    try {
        const parsed = new URL(url);
        for (const [key, value] of [...parsed.searchParams.entries()]) {
            const redacted = redactRallarServerValue({ [key]: value }, authSession);
            if (redacted[key] !== value) {
                parsed.searchParams.set(key, redacted[key]);
            }
        }
        return parsed.toString();
    }
    catch {
        return redactRallarServerValue(url, authSession);
    }
}
