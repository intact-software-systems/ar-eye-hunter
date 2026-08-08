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
const layoutRulesPath = '<repo>/scripts/repo-style-check/layout-rules.mjs';
const layoutRulesDiagnosticMessage =
  `Could not find a declaration file for module '${layoutRulesPath}'. ` +
  `'${layoutRulesPath}' implicitly has an 'any' type.`;
const implicitFindingMessage = "Parameter 'finding' implicitly has an 'any' type.";
const implicitItemMessage = "Parameter 'item' implicitly has an 'any' type.";
const ratchetOwner = 'it:keeps every ratcheted source within the mechanical code-standard tiers';
const untypedScannerRationale =
  'Repo-style governance consumes the untyped JavaScript scanner findings.';
const untypedScannerRemoval = 'Remove when the scanner publishes a checked declaration.';

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
    column: 25,
    code: 7006,
    message: implicitFindingMessage,
    owner: ratchetOwner,
    ownerRelativeLine: 11,
    path: 'packages/tests/repo/group-state-server-source-ratchet.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The group-state ratchet filters untyped scanner findings by tier.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 8,
    code: 7006,
    message: implicitFindingMessage,
    owner: ratchetOwner,
    ownerRelativeLine: 23,
    path: 'packages/tests/repo/group-state-server-source-ratchet.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The group-state ratchet reports untyped scanner findings on failure.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 39,
    code: 7016,
    message: scannerDiagnosticMessage,
    owner: '<module>',
    ownerRelativeLine: 6,
    path: 'packages/tests/repo/group-state-server-source-ratchet.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The group-state ratchet consumes the repository source scanner.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 34,
    code: 7006,
    message: implicitFindingMessage,
    owner: 'details',
    ownerRelativeLine: 2,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'details renders untyped layout-rule findings for assertion messages.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 27,
    code: 7006,
    message: implicitFindingMessage,
    owner: 'findingsFor',
    ownerRelativeLine: 1,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'findingsFor selects untyped layout-rule findings by rule name.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 26,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:recognizes all server group-state module criteria and whole identifier tokens',
    ownerRelativeLine: 17,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The module-criteria case maps untyped scanner cluster members.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 28,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:reproduces the 22-cluster planning count deterministically',
    ownerRelativeLine: 4,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The cluster-count case filters untyped scanner cluster members.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 34,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:reproduces the 22-cluster planning count deterministically',
    ownerRelativeLine: 5,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The cluster-count case maps untyped scanner cluster members.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 60,
    code: 7006,
    message: implicitItemMessage,
    owner: 'it:sorts findings by code units across punctuation and non-ASCII paths',
    ownerRelativeLine: 4,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'The ordering case projects untyped scanner findings to paths.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
  },
  {
    column: 8,
    code: 7016,
    message: layoutRulesDiagnosticMessage,
    owner: '<module>',
    ownerRelativeLine: 8,
    path: 'packages/tests/repo/repo-style-layout-rules.test.ts',
    disposition: 'accepted inherited debt',
    responsibility: 'Layout-rule governance consumes the JavaScript layout-rule module.',
    rationale: untypedScannerRationale,
    removalCondition: untypedScannerRemoval,
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
