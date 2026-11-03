import { toAuthSessionKey } from '@shared-web/browser/auth/to-auth-session-key.ts';
import type { AuthSession } from '@shared/api/api-config.ts';
import { createContext, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { OperatorApiSession } from './operator-api-session.ts';

export interface RoomOperatorContext {
    readonly apiBaseUrl: string;
    readonly auth: OperatorApiSession;
    readonly sessionKey: string | null;
    readonly issue: string | null;
}

export const RoomOperatorContext = createContext<RoomOperatorContext | null>(null);

export interface RoomOperationsProviderProps {
    readonly apiBaseUrl: string;
    readonly session: AuthSession | null;
    readonly endpointFromLocation: boolean;
    readonly children: ReactNode;
}

export function RoomOperationsProvider(
    { apiBaseUrl, session, endpointFromLocation, children }: RoomOperationsProviderProps
) {
    const auth = useMemo(() => new OperatorApiSession(endpointFromLocation ? null : session), [
        session,
        apiBaseUrl,
        endpointFromLocation
    ]);
    useLayoutEffect(() => {
        auth.setSession(endpointFromLocation ? null : session);
        return () => auth.setSession(null);
    }, [auth, endpointFromLocation, session]);
    const context = useMemo(() => ({
        apiBaseUrl,
        auth,
        sessionKey: session === null ? null : toAuthSessionKey(session),
        issue: endpointFromLocation
            ? 'Use the configured API endpoint. Operator credentials cannot be sent to an endpoint supplied by a link.'
            : session === null
            ? 'Sign in with an API administrator account to inspect rooms.'
            : null
    }), [apiBaseUrl, auth, endpointFromLocation, session]);
    return <RoomOperatorContext.Provider value={context}>{children}</RoomOperatorContext.Provider>;
}
