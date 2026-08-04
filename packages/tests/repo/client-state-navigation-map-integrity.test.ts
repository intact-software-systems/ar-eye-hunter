import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/client-state/README.md';
const architecturePath = 'packages/shared-server/architecture.md';
const commandCohortLinks = [
  ['./client-state-validation-primitives.ts', 'class ClientMutationRejectedError'],
  ['./mutation/client-mutation-contracts.ts', 'type ClientMutationCommand ='],
  ['./mutation/client-mutation-command.ts', 'function toClientMutationCommand('],
  ['./mutation/client-mutation-authority.ts', 'function toClientMutationIssuedSessionAuthority('],
  [
    './mutation/validate-client-expired-session-authority.ts',
    'function validateClientExpiredSessionAuthority(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-command.ts',
    'function validateClientMutationCommand(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-operation-input.ts',
    'function validateClientMutationOperationInput(',
  ],
  [
    './mutation/command-validation/validate-client-mutation-request.ts',
    'function validateClientMutationRequest(',
  ],
] as const;

describe('client-state navigation map integrity', () => {
  it('links every command/validation owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of commandCohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('records the current and cohort target mutation timelines', () => {
    const readme = read(navigationPath);
    expect(readme).toContain('## Construction, registration, and enqueue timeline');
    expect(readme).toContain('## Runtime invocation and transaction timeline');
    expect(readme).toContain('## PR A command and validation timeline');
    expect(readme).toContain('AppInboxService');
    expect(readme).toContain('validateClientMutationCommand');
    expect(readme).toContain('toClientMutationCommand');
  });

  it('keeps enqueue wake before later invocation and post-commit observation', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'Construction, registration, and enqueue timeline')).toEqual([
      'API composition creates the durable repositories, database, client-state service, timing sink, and queue-engine wake capability before constructing AppClientInboxService.',
      'RallarMiddleware creates InboxQueueReader and invokes the AppClientInboxService factory with the already-created queue reader and wake capability.',
      'AppInboxService constructs its transaction writer and stores the enqueue-time owning-queue wake capability before AppClientInboxService registers handlers.',
      'AppClientInboxService registers all eight client mutation callbacks through AppInboxService.onStateMessage; InboxQueueReader can dispatch a callback only after that registration.',
      'A route, authorized-WebSocket adapter, or maintenance producer first asks AppClientInboxService to validate ingress and project the payload or authority.',
      'AppInboxService serializes the command, durably reserves or reuses the AppInbox entry, validates command identity, and invokes the owning-queue wake at this enqueue boundary.',
      'A synchronous producer waits by polling the durable result; there is no post-commit queue wake in the client-state path.',
    ]);
    expect(readTimeline(readme, 'Runtime invocation and transaction timeline')).toEqual([
      'InboxQueueReader later claims the durable entry and invokes the registered AppClientInboxService callback once for that processing attempt.',
      'AppInboxService validates the durable command identity and begins attempt finalization before invoking the registered callback.',
      'AppClientInboxService projects the command, then runs client-state read, compute, and validate from fresh state for that attempt.',
      'AppInboxTransactionWriter owns the transaction; ClientStateService performs the first conditional write and the state, receipt, event, outbox, durable result, and reservation completion commit together.',
      'The committed result returns to AppClientInboxService.commitComputed, which observes the snapshot after commit; observation is not a queue wake.',
      'The registered callback returns the confirmed result, and a waiting producer reads the same durable result for its caller-visible outcome.',
      'A retryable failure leaves the entry for ResourceInbox retry; the next claimed attempt re-enters identity validation and the complete command/read/compute/validate path without repeating the original enqueue wake.',
    ]);
  });

  it('keeps the navigation owner reachable once from shared-server architecture', () => {
    const architecture = read(architecturePath);
    expect(architecture.match(/\.\/rallar-system\/client-state\/README\.md/g)).toHaveLength(1);
  });
});

function absolute(filePath: string): string {
  return path.join(repoRoot, filePath);
}

function read(filePath: string): string {
  return readFileSync(absolute(filePath), 'utf8');
}

function readTimeline(readme: string, heading: string): readonly string[] {
  const section = readme.match(
    new RegExp(
      `^## ${heading}\\n\\n(?:[^\\n]*\\n)*?\\x60\\x60\\x60text\\n([\\s\\S]+?)\\n\\x60\\x60\\x60`,
      'm',
    ),
  )?.[1];
  if (!section) throw new Error(`Missing structured timeline: ${heading}`);
  return section.split('\n').map((line) => line.replace(/^\d+\. /, ''));
}
