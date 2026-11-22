import { decodeStateScope, type StateScope } from '@shared/api/state-types.ts';
import type { RoomLobbyAccountView } from '@shared/api/room-lobbies/room-lobby.ts';
import { toError } from '@shared/resilience/to-error.ts';
import type { Hono } from 'hono';
import { toApiMutationFailureResponse } from '../routes/api-mutation-route-failure.ts';

export interface RoomLobbyReadDependencies {
    requireSession(request: { header(name: string): string | undefined; }): Promise<{ readonly clientId: string; }>;
    read(scope: StateScope, principalId: string): Promise<RoomLobbyAccountView>;
}

export function registerRoomLobbyReadRoute(app: Hono, dependencies: RoomLobbyReadDependencies): void {
    app.get('/api/room-lobbies/apps/:applicationId/workspaces/:workspaceId', async context => {
        try {
            const session = await dependencies.requireSession(context.req);
            const scope = decodeStateScope(context.req.param());
            context.header('Cache-Control', 'private, no-store');
            return context.json(await dependencies.read(scope, session.clientId));
        }
        catch (error) {
            return toApiMutationFailureResponse(context, toError(error));
        }
    });
}
