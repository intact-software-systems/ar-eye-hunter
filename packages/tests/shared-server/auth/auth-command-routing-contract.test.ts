import { describe, expect, it } from 'vitest';

import { AppInboxType } from '@shared-server/rallar-system/services/app-inbox-contracts.ts';
import {
  toAuthAppInboxType,
  toAuthCommandContextId,
  toAuthCommandSenderId,
} from '@shared-server/rallar-system/auth/inbox/auth-app-inbox-routing.ts';

const user = {
  clientId: 'client-register',
  normalizedUsername: 'alice',
} as const;
const session = {
  clientId: 'client-session',
  username: 'alice',
  sessionId: 'session-1',
  accessTokenDigest: 'access-token-digest',
  issuedAtEpochMs: 1_000,
  expiresAtEpochMs: 2_000,
} as const;

const routingFixtures = [
  [
    { kind: 'register-user', user },
    AppInboxType.AUTH_USER_REGISTER,
    'operation=register-user:username=alice',
    'client-register',
  ],
  [
    {
      kind: 'issue-session',
      authority: { normalizedUsername: 'alice' },
      session,
    },
    AppInboxType.AUTH_SESSION_ISSUE,
    'operation=issue-session:username=alice',
    'client-session',
  ],
  [
    { kind: 'logout-session', expected: session },
    AppInboxType.AUTH_SESSION_LOGOUT,
    'client=client-session:session=session-1',
    'client-session',
  ],
  [
    { kind: 'issue-ws-ticket', ticketRecord: session },
    AppInboxType.AUTH_WS_TICKET_ISSUE,
    'client=client-session:session=session-1',
    'client-session',
  ],
  [
    { kind: 'consume-ws-ticket', ticketDigest: 'ws-digest', expectedSessionId: 'session-1' },
    AppInboxType.AUTH_WS_TICKET_CONSUME,
    'credential=ws-digest',
    'ws-digest',
  ],
  [
    {
      kind: 'issue-agent-tickets',
      authority: session,
      tickets: [{ sessionId: 'agent-session-1' }, { sessionId: 'agent-session-2' }],
    },
    AppInboxType.AUTH_AGENT_SESSION_TICKETS_ISSUE,
    'client=client-session:session=session-1',
    'client-session',
  ],
  [
    { kind: 'consume-agent-ticket', ticketDigest: 'agent-digest' },
    AppInboxType.AUTH_AGENT_SESSION_TICKET_CONSUME,
    'credential=agent-digest',
    'agent-digest',
  ],
] as const;

describe('auth command routing contract', () => {
  it('catches any command variant routed to the wrong queue type, context, or sender', () => {
    for (const [command, type, contextId, senderId] of routingFixtures) {
      expect(toAuthAppInboxType(command as never)).toBe(type);
      expect(toAuthCommandContextId(command as never)).toBe(contextId);
      expect(toAuthCommandSenderId(command as never)).toBe(senderId);
    }
  });
});
