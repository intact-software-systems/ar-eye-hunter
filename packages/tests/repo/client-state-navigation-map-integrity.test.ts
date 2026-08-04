import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const navigationPath = 'packages/shared-server/rallar-system/client-state/README.md';
const architecturePath = 'packages/shared-server/architecture.md';
const prACohortLinks = [
  ['./client-state-contract-validation.ts', 'function validateClientPrincipal('],
  ['./client-mutation-receipt-validation.ts', 'function validateClientMutationReceipt('],
  ['./client-state-semantic-equality.ts', 'function sameClientPrincipalState('],
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
  ['./mutation/compute/compute-client-mutation.ts', 'function computeClientMutation('],
  ['./mutation/compute/compute-client-mutation-result.ts', 'function computeClientMutationResult('],
  ['./mutation/compute/compute-client-mutation-state.ts', 'function bumpClientPrincipal('],
  [
    './mutation/compute/compute-client-principal-mutation.ts',
    'function computeClientPrincipalMutation(',
  ],
  [
    './mutation/compute/compute-client-instance-mutation.ts',
    'function computeClientInstanceMutation(',
  ],
  ['./mutation/compute/compute-client-session-connect.ts', 'function computeClientSessionConnect('],
  [
    './mutation/compute/compute-client-session-heartbeat.ts',
    'function computeClientSessionHeartbeat(',
  ],
  [
    './mutation/compute/compute-client-session-disconnect.ts',
    'function computeClientSessionDisconnect(',
  ],
  ['./mutation/compute/compute-client-session-expiry.ts', 'function computeClientSessionExpiry('],
  [
    './mutation/result-validation/validate-client-mutation-read.ts',
    'function validateClientMutationRead(',
  ],
  [
    './mutation/result-validation/validate-client-mutation-authority-policy.ts',
    'function validateClientMutationAuthorityPolicy(',
  ],
  [
    './mutation/result-validation/validate-client-mutation-result.ts',
    'function validateClientMutationResult(',
  ],
  ['./mutation/result-validation/validate-client-mutation.ts', 'function validateClientMutation('],
] as const;

describe('client-state navigation map integrity', () => {
  it('links every PR A owner to its named primary symbol', () => {
    const readme = read(navigationPath);
    for (const [target, declaration] of prACohortLinks) {
      expect(readme, target).toContain(`](${target})`);
      const resolved = path.resolve(path.dirname(absolute(navigationPath)), target);
      expect(existsSync(resolved), target).toBe(true);
      expect(readFileSync(resolved, 'utf8'), declaration).toContain(declaration);
    }
  });

  it('records the direct compute and result-validation path', () => {
    const readme = read(navigationPath);
    expect(readTimeline(readme, 'PR A compute and result timeline')).toEqual([
      'computeClientMutation validates the command, persisted facts, and stable read before making a decision.',
      'An existing idempotency record exits as exact replay or exact hash conflict before operation-family dispatch.',
      'The exhaustive operation switch calls exactly one named principal, instance, connect, heartbeat, disconnect, or expiry owner.',
      'The family owner makes the pure state decision and delegates shared audit, revision, candidate, snapshot, event, receipt, state-sync, and outbox construction to the named compute-state and compute-result owners.',
      'validateClientMutation validates the command, facts, computed result, stable read, durable authority, identities, conditional guards, causal generation, and exact outbox before the unchanged write phase.',
    ]);
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
      'AppInboxService serializes the command, durably reserves or reuses the AppInbox entry, invokes the owning-queue wake immediately after persistence, then asserts matching command identity before returning the entry.',
      'A synchronous producer waits by polling the durable result; there is no post-commit queue wake in the client-state path.',
    ]);
    expect(readTimeline(readme, 'Runtime invocation and transaction timeline')).toEqual([
      'InboxQueueReader later claims the durable entry and invokes the registered AppClientInboxService callback once for that processing attempt.',
      'AppInboxService validates the durable command identity and begins attempt finalization before invoking the registered callback.',
      'AppClientInboxService projects the command, then runs client-state read, compute, and validate from fresh state for that attempt.',
      'AppInboxTransactionWriter owns the transaction: ClientStateService performs the conditional state, receipt, event, and outbox writes; AppInboxTransactionWriter then writes the durable result, completes the reservation, and commits them together.',
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
