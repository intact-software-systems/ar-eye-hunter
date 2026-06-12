import type { AuthSession } from '@shared/api/api-config.ts';
import type { RallarAuthState } from '@shared-web/browser/rallar.ts';

export function readAuthSessionFromRallarAuthState(
    state: RallarAuthState,
): AuthSession | undefined {
    return state.authenticated ? state.session : undefined;
}
