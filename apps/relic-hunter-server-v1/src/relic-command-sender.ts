import type { AuthSession } from '@shared/api/api-config.ts';

/** The session that sent a command and the principal whose own sessions hear what became of it. */
export type RelicCommandSender = Pick<AuthSession, 'clientId' | 'sessionId'>;
