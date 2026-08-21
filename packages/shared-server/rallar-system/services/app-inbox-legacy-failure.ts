import type { AppInboxFailure } from './app-inbox-failure.ts';

export function toLegacyAppInboxFailure(failure: AppInboxFailure): string {
    if (failure.version === 'legacy-string.v0') {
        return failure.message;
    }
    if (failure.version === 'legacy-object.v0') {
        return JSON.stringify({
            error: failure.message,
            code: failure.code,
            message: failure.message,
            status: failure.status,
            ...(failure.denial?.details === null || failure.denial === null
                ? {}
                : { details: failure.denial.details })
        });
    }
    if (failure.version === 'legacy-retry-exhausted.v0') {
        return JSON.stringify(failure.legacyWire);
    }
    if (failure.code === 'app-inbox-non-retryable') {
        return failure.message;
    }
    if (failure.denial !== null) {
        return JSON.stringify({
            error: failure.message.startsWith('Forbidden:')
                ? failure.message
                : `Forbidden: ${failure.denial.message}`,
            code: failure.denial.code,
            message: failure.denial.message,
            ...(failure.denial.details === null
                ? {}
                : { details: failure.denial.details })
        });
    }
    if (failure.version === 'canonical.v1') {
        const { version: _version, ...persisted } = failure;
        return JSON.stringify(persisted);
    }
    return JSON.stringify(failure);
}
