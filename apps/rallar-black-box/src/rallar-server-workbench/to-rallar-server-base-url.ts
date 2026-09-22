import { Either } from '@shared/resilience/Either.ts';
import type { RallarServerRestRequestInput } from './rallar-server-workbench-contracts.ts';

export function toRallarServerBaseUrl(
    { apiBaseUrl, forbidPlaceholderBaseUrl }: Pick<
        RallarServerRestRequestInput,
        'apiBaseUrl' | 'forbidPlaceholderBaseUrl'
    >
): Either<string, string> {
    const trimmed = apiBaseUrl.trim();
    if (!trimmed) {
        return Either.ofLeft('Rallar Server API base URL is required.');
    }
    if (forbidPlaceholderBaseUrl && /api\.example\.invalid/i.test(trimmed)) {
        return Either.ofLeft('Real-provider Rallar Server requests cannot use the placeholder API base URL.');
    }
    return Either.ofRight(trimmed.endsWith('/') ? trimmed : `${trimmed}/`);
}
