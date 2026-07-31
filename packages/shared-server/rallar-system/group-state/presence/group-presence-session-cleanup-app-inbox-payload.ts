// prettier-ignore
import type {
  ClientAuthorisedWsSessionConnectAppInboxPayload,
} from '../../services/AppClientInboxService.ts';

export interface GroupPresenceSessionCleanupAppInboxPayload {
  readonly connection: ClientAuthorisedWsSessionConnectAppInboxPayload;
  readonly disconnectedAtEpochMs: number;
  readonly reason: string;
}
