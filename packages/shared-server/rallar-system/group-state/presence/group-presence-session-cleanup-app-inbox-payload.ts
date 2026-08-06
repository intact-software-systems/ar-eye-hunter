// prettier-ignore
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
} from '../../client-state/inbox/app-client-inbox-contracts.ts';

export interface GroupPresenceSessionCleanupAppInboxPayload {
  readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
  readonly disconnectedAtEpochMs: number;
  readonly reason: string;
}
