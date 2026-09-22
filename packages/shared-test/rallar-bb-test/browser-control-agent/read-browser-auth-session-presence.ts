import { readSession } from '@shared/api/auth.ts';

export function readBrowserAuthSessionPresence(): boolean {
    if (typeof localStorage === 'undefined' && typeof sessionStorage === 'undefined') {
        return false;
    }

    try {
        return readSession() !== undefined;
    }
    catch {
        return false;
    }
}
