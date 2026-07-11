import type { AuthSession } from '@shared/api/api-config.ts';
import { readSession } from '@shared/api/auth.ts';

export function readCurrentAuthSession(): AuthSession | undefined {
    try {
        return readSession();
    } catch {
        return undefined;
    }
}
