export interface TypeScriptDiagnostic {
  readonly column: number;
  readonly code: number;
  readonly message: string;
  readonly owner: string;
  readonly ownerRelativeLine: number;
  readonly path: string;
}

export interface InheritedDiagnosticDisposition extends TypeScriptDiagnostic {
  readonly disposition: 'accepted inherited debt';
  readonly responsibility: string;
  readonly rationale: string;
  readonly removalCondition: string;
}

const scannerPath = '<repo>/scripts/repo-style-check/repository-scan.mjs';
const scannerDiagnosticMessage =
  `Could not find a declaration file for module '${scannerPath}'. ` +
  `'${scannerPath}' implicitly has an 'any' type.`;
const clientStateModule = '"@shared-server/rallar-system/client-state/client-state-service.ts"';
const missingClientMutationMessage =
  `Module '${clientStateModule}' has no exported member ` + "'ClientMutationWritten'.";
const missingClientStateMessage =
  `Module '${clientStateModule}' has no exported member ` + "'ClientStateWritten'.";
const missingClientStateServiceMessage =
  `'${clientStateModule}' has no exported member named 'ClientStateService'. ` +
  "Did you mean 'createClientStateService'?";

export const authServerInheritedDiagnosticLedger = [
  {
    column: 39,
    code: 7016,
    message: scannerDiagnosticMessage,
    owner: '<module>',
    ownerRelativeLine: 5,
    path: 'packages/tests/repo/auth-server-shell-lineage-validation.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'Auth shell-lineage governance consumes the repository source scanner.',
    rationale: 'The JavaScript scanner has no TypeScript declaration in the exact PR C base.',
    removalCondition: 'Remove when the scanner publishes a checked declaration or typed entry.',
  },
  {
    column: 8,
    code: 2305,
    message: missingClientMutationMessage,
    owner: '<module>',
    ownerRelativeLine: 23,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The authorised WebSocket fixture models a client mutation result.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical mutation-written contract.',
  },
  {
    column: 8,
    code: 2305,
    message: missingClientStateMessage,
    owner: '<module>',
    ownerRelativeLine: 24,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The authorised WebSocket fixture models persisted client state.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical client-state write contract.',
  },
  {
    column: 8,
    code: 7006,
    message: "Parameter 'error' implicitly has an 'any' type.",
    owner: 'requireClientMutationWritten',
    ownerRelativeLine: 5,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'requireClientMutationWritten narrows the fixture failure branch.',
    rationale: 'The missing mutation-written export prevents contextual typing of this callback.',
    removalCondition: 'Remove when the canonical mutation-written contract types the callback.',
  },
  {
    column: 8,
    code: 7006,
    message: "Parameter 'value' implicitly has an 'any' type.",
    owner: 'requireClientMutationWritten',
    ownerRelativeLine: 8,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-authorised-ws.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'requireClientMutationWritten narrows the fixture success branch.',
    rationale: 'The missing mutation-written export prevents contextual typing of this callback.',
    removalCondition: 'Remove when the canonical mutation-written contract types the callback.',
  },
  {
    column: 8,
    code: 2305,
    message: missingClientStateMessage,
    owner: '<module>',
    ownerRelativeLine: 11,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-expiry.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The expiry fixture models the client-state write result.',
    rationale: 'The touched fixture inherits a stale test-only type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical client-state write contract.',
  },
  {
    column: 8,
    code: 2724,
    message: missingClientStateServiceMessage,
    owner: '<module>',
    ownerRelativeLine: 10,
    path: 'packages/tests/shared-server/client-state/app-client-inbox-expiry.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The expiry fixture types its client-state service dependency.',
    rationale: 'The touched fixture inherits a stale service type name absent from the export.',
    removalCondition: 'Remove when the fixture uses the canonical service capability type.',
  },
] as const satisfies readonly InheritedDiagnosticDisposition[];
