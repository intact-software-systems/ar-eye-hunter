import { redactRallarBlackBoxValue } from '@shared-test/rallar-bb-test/redaction.ts';
import type { ApiJsonValue } from '@shared/api/api-json-value.ts';

/**
 * A JSON editor draft in the form the browser cache may keep: redacted, re-indented JSON. Text
 * that is not JSON becomes empty, because an unparsed draft may hold a secret in any shape.
 */
export function toRedactedJsonEditorText(text: string, secretValues: readonly string[]): string {
    const trimmed = text.trim();
    if (!trimmed) {
        return '';
    }

    try {
        const value = JSON.parse(trimmed) as ApiJsonValue;
        return JSON.stringify(redactRallarBlackBoxValue(value, { secretValues }), null, 2);
    }
    catch {
        return '';
    }
}
