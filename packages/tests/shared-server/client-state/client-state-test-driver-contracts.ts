import type { AuthSession } from '@shared/api/api-config.ts';
import type { ClientPlatform } from '@shared/api/client-types.ts';
import type {
  ConnectClientSessionRequest,
  DisconnectClientSessionRequest,
  HeartbeatClientSessionRequest,
  StateScope,
  UpsertClientInstanceRequest,
  UpsertClientPrincipalRequest,
} from '@shared/api/state-types.ts';
import type {
  ClientStateService,
  ClientStateWritten,
} from '@shared-server/rallar-system/client-state/client-state-service-contracts.ts';

export interface ClientStateTestAuthorisedWsInput {
  readonly applicationId?: string;
  readonly workspaceId?: string;
  readonly principalId?: string;
  readonly clientInstanceId?: string;
  readonly connectedAtEpochMs?: number;
  readonly expiresAtEpochMs?: number;
  readonly userAgent?: string;
  readonly platform?: ClientPlatform;
  readonly capabilities?: readonly string[];
  readonly displayName?: string;
}

export type ClientStatePhaseTestDriver = Pick<
  ClientStateService,
  'listSnapshots' | 'readSnapshot' | 'readPresenceSnapshot' | 'listEvents' | 'listEventPage'
> &
  Readonly<{
    upsertPrincipal(
      scope: StateScope,
      principalId: string,
      request: UpsertClientPrincipalRequest,
    ): Promise<ClientStateWritten>;
    upsertInstance(
      scope: StateScope,
      principalId: string,
      clientInstanceId: string,
      request: UpsertClientInstanceRequest,
    ): Promise<ClientStateWritten>;
    connectSession(
      scope: StateScope,
      principalId: string,
      clientInstanceId: string,
      sessionId: string,
      request: ConnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    heartbeatSession(
      scope: StateScope,
      principalId: string,
      clientInstanceId: string,
      sessionId: string,
      request: HeartbeatClientSessionRequest,
    ): Promise<ClientStateWritten>;
    disconnectSession(
      scope: StateScope,
      principalId: string,
      clientInstanceId: string,
      sessionId: string,
      request: DisconnectClientSessionRequest,
    ): Promise<ClientStateWritten>;
    expireExpiredSessions(atEpochMs: number): Promise<readonly ClientStateWritten[]>;
    registerAuthorisedWsClientSession(
      authSession: AuthSession,
      generationId: string,
      input?: ClientStateTestAuthorisedWsInput,
    ): Promise<ClientStateWritten>;
    disconnectAuthorisedWsClientSession(
      sessionId: string,
      generationId: string,
      reason?: string,
    ): Promise<ClientStateWritten>;
  }>;
