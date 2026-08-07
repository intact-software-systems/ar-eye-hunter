import {
  type NavigationCodeEdge,
  type NavigationReadContext,
  validateNavigationCodeEdge,
} from './auth-server-navigation-edge-validation.ts';

type TraceStage =
  | 'caller-result'
  | 'commit-after-commit'
  | 'compatibility-paths'
  | 'construction-registration'
  | 'durable-writes'
  | 'early-exits'
  | 'first-guard'
  | 'later-invocation-retry'
  | 'normal-result'
  | 'terminal-failure-cleanup'
  | 'transaction-query-boundary';

const authRoot = 'packages/shared-server/rallar-system/auth';
const codeEdges = {
  'config-to-login': edge({
    fromFile: 'apps/api-v1/src/routes/config-route.ts',
    fromSymbol: 'init',
    toFile: 'apps/api-v1/src/repository/login-repository.ts',
    toSymbol: 'login',
  }),
  'login-to-wrapper': edge({
    fromFile: 'apps/api-v1/src/repository/login-repository.ts',
    fromSymbol: 'login',
    toFile: 'packages/shared-server/rallar-system/services/auth-login-service.ts',
    toSymbol: 'authenticateAuthUser',
  }),
  'wrapper-to-login': edge({
    fromFile: 'packages/shared-server/rallar-system/services/auth-login-service.ts',
    fromSymbol: 'authenticateAuthUser',
    toFile: `${authRoot}/login/authenticate-auth-user.ts`,
    toSymbol: 'authenticateAuthUser',
  }),
  'app-to-handler': edge({
    fromFile: `${authRoot}/inbox/app-auth-inbox-service.ts`,
    fromSymbol: 'AppAuthInboxService',
    toFile: `${authRoot}/inbox/auth-inbox-handler.ts`,
    toSymbol: 'AuthInboxHandler',
  }),
  'app-to-hash': edge({
    fromFile: `${authRoot}/inbox/app-auth-inbox-service.ts`,
    fromSymbol: 'AppAuthInboxService',
    toFile: `${authRoot}/credentials/hash-auth-secret.ts`,
    toSymbol: 'hashAuthSecret',
  }),
  'app-to-decode': edge({
    fromFile: `${authRoot}/inbox/app-auth-inbox-service.ts`,
    fromSymbol: 'AppAuthInboxService',
    toFile: `${authRoot}/mutation/decode-auth-mutation-command.ts`,
    toSymbol: 'decodeAuthMutationCommand',
  }),
  'handler-to-decode': edge({
    fromFile: `${authRoot}/inbox/auth-inbox-handler.ts`,
    fromSymbol: 'AuthInboxHandler',
    toFile: `${authRoot}/mutation/decode-auth-mutation-command.ts`,
    toSymbol: 'decodeAuthMutationCommand',
  }),
  'handler-to-service': edge({
    fromFile: `${authRoot}/inbox/auth-inbox-handler.ts`,
    fromSymbol: 'AuthInboxHandler',
    toFile: `${authRoot}/auth-mutation-service.ts`,
    toSymbol: 'AuthMutationService',
  }),
  'service-to-read': edge({
    fromFile: `${authRoot}/auth-mutation-service.ts`,
    fromSymbol: 'createAuthMutationService',
    toFile: `${authRoot}/mutation/read/read-auth-mutation.ts`,
    toSymbol: 'readAuthMutation',
  }),
  'service-to-compute': edge({
    fromFile: `${authRoot}/auth-mutation-service.ts`,
    fromSymbol: 'createAuthMutationService',
    toFile: `${authRoot}/mutation/compute/compute-auth-mutation.ts`,
    toSymbol: 'computeAuthMutation',
  }),
  'service-to-validate': edge({
    fromFile: `${authRoot}/auth-mutation-service.ts`,
    fromSymbol: 'createAuthMutationService',
    toFile: `${authRoot}/mutation/validate/validate-auth-mutation.ts`,
    toSymbol: 'validateAuthMutation',
  }),
  'service-to-write': edge({
    fromFile: `${authRoot}/auth-mutation-service.ts`,
    fromSymbol: 'createAuthMutationService',
    toFile: `${authRoot}/mutation/write/write-auth-mutation.ts`,
    toSymbol: 'writeAuthMutation',
  }),
  'app-to-public-result': edge({
    fromFile: `${authRoot}/inbox/app-auth-inbox-service.ts`,
    fromSymbol: 'AppAuthInboxService',
    toFile: `${authRoot}/mutation/to-auth-mutation-public-result.ts`,
    toSymbol: 'toAuthMutationPublicResult',
  }),
  'compute-to-session': edge({
    fromFile: `${authRoot}/mutation/compute/compute-auth-mutation.ts`,
    fromSymbol: 'computeAuthMutation',
    toFile: `${authRoot}/mutation/compute/compute-auth-session-mutation.ts`,
    toSymbol: 'computeAuthSessionMutation',
  }),
  'session-to-lifecycle': edge({
    fromFile: `${authRoot}/mutation/compute/compute-auth-session-mutation.ts`,
    fromSymbol: 'computeAuthSessionMutation',
    toFile: `${authRoot}/sessions/require-issue-session-lifecycle.ts`,
    toSymbol: 'requireIssueSessionLifecycle',
  }),
  'session-to-logout': edge({
    fromFile: `${authRoot}/mutation/compute/compute-auth-session-mutation.ts`,
    fromSymbol: 'computeAuthSessionMutation',
    toFile: `${authRoot}/mutation/compute/to-auth-logout-outbox.ts`,
    toSymbol: 'toAuthLogoutOutbox',
  }),
  'write-to-session': edge({
    fromFile: `${authRoot}/mutation/write/write-auth-mutation.ts`,
    fromSymbol: 'writeAuthMutation',
    toFile: `${authRoot}/mutation/write/write-auth-session.ts`,
    toSymbol: 'writeAuthSessionIssue',
  }),
  'compute-to-ticket': edge({
    fromFile: `${authRoot}/mutation/compute/compute-auth-mutation.ts`,
    fromSymbol: 'computeAuthMutation',
    toFile: `${authRoot}/mutation/compute/compute-auth-ticket-mutation.ts`,
    toSymbol: 'computeAuthTicketMutation',
  }),
  'ticket-to-session': edge({
    fromFile: `${authRoot}/mutation/compute/compute-auth-ticket-mutation.ts`,
    fromSymbol: 'computeAuthTicketMutation',
    toFile: `${authRoot}/mutation/compute/compute-auth-session-mutation.ts`,
    toSymbol: 'requireConsumedAuthSession',
  }),
  'validate-to-ticket': edge({
    fromFile: `${authRoot}/mutation/validate/validate-auth-mutation.ts`,
    fromSymbol: 'validateAuthMutation',
    toFile: `${authRoot}/mutation/validate/validate-auth-ticket-mutation.ts`,
    toSymbol: 'validateAuthTicketMutation',
  }),
  'write-to-ticket': edge({
    fromFile: `${authRoot}/mutation/write/write-auth-mutation.ts`,
    fromSymbol: 'writeAuthMutation',
    toFile: `${authRoot}/mutation/write/write-auth-ticket-mutation.ts`,
    toSymbol: 'writeAuthTicketMutation',
  }),
  'ticket-write-to-session': edge({
    fromFile: `${authRoot}/mutation/write/write-auth-ticket-mutation.ts`,
    fromSymbol: 'writeAuthTicketMutation',
    toFile: `${authRoot}/mutation/write/write-auth-session.ts`,
    toSymbol: 'writeAuthSession',
  }),
  'api-proof-to-shared': edge({
    fromFile: 'apps/api-v1/src/services/request-auth-service.ts',
    fromSymbol: 'requireApiAuthSession',
    toFile: 'packages/shared-server/http/request-auth-service.ts',
    toSymbol: 'requireApiAuthSession',
  }),
  'shared-to-session-wrapper': edge({
    fromFile: 'packages/shared-server/http/request-auth-service.ts',
    fromSymbol: 'requireApiAuthSession',
    toFile: 'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    toSymbol: 'AuthSessionRepository',
  }),
  'session-wrapper-to-owner': edge({
    fromFile: 'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    fromSymbol: 'AuthSessionRepository',
    toFile: `${authRoot}/persistence/auth-session-repository.ts`,
    toSymbol: 'AuthSessionRepository',
  }),
  'shared-to-app-wrapper': edge({
    fromFile: 'packages/shared-server/http/request-auth-service.ts',
    fromSymbol: 'requireWsAuthSession',
    toFile: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    toSymbol: 'AppAuthInboxService',
  }),
  'app-wrapper-to-owner': edge({
    fromFile: 'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    fromSymbol: 'AppAuthInboxService',
    toFile: `${authRoot}/inbox/app-auth-inbox-service.ts`,
    toSymbol: 'AppAuthInboxService',
  }),
} as const;

const stageOrder: readonly TraceStage[] = [
  'construction-registration',
  'compatibility-paths',
  'later-invocation-retry',
  'first-guard',
  'transaction-query-boundary',
  'durable-writes',
  'commit-after-commit',
  'normal-result',
  'early-exits',
  'terminal-failure-cleanup',
  'caller-result',
];

export const authNavigationFamilies = [
  family('Login and credential issuance', [
    'config-to-login',
    'login-to-wrapper',
    'wrapper-to-login',
    'login-to-wrapper',
    'app-to-hash',
    'app-to-handler',
    'app-to-public-result',
    'wrapper-to-login',
    'app-to-handler',
    'app-to-handler',
    'config-to-login',
  ]),
  family('Authenticated AppInbox mutation', [
    'app-to-handler',
    'app-to-handler',
    'app-to-decode',
    'handler-to-decode',
    'handler-to-service',
    'service-to-write',
    'service-to-write',
    'app-to-public-result',
    'service-to-validate',
    'service-to-write',
    'app-to-public-result',
  ]),
  family('Session lifecycle, logout, expiry, and revocation', [
    'app-to-handler',
    'app-wrapper-to-owner',
    'compute-to-session',
    'session-to-lifecycle',
    'service-to-compute',
    'write-to-session',
    'session-to-logout',
    'compute-to-session',
    'session-to-lifecycle',
    'write-to-session',
    'app-to-public-result',
  ]),
  family('Ticket issue and consume', [
    'app-to-handler',
    'app-wrapper-to-owner',
    'compute-to-ticket',
    'ticket-to-session',
    'validate-to-ticket',
    'write-to-ticket',
    'ticket-write-to-session',
    'compute-to-ticket',
    'validate-to-ticket',
    'write-to-ticket',
    'app-to-public-result',
  ]),
  family('Authentication and authorization proof/query', [
    'api-proof-to-shared',
    'shared-to-session-wrapper',
    'api-proof-to-shared',
    'shared-to-app-wrapper',
    'session-wrapper-to-owner',
    'shared-to-app-wrapper',
    'app-wrapper-to-owner',
    'shared-to-session-wrapper',
    'shared-to-session-wrapper',
    'shared-to-app-wrapper',
    'api-proof-to-shared',
  ]),
];

export function readAuthNavigationViolations(
  readSource: (filePath: string) => string,
): readonly string[] {
  const context: NavigationReadContext = {
    cache: new Map(),
    readSource,
    violations: [],
  };
  for (const familyContract of authNavigationFamilies) {
    if (JSON.stringify(Object.keys(familyContract.stages)) !== JSON.stringify(stageOrder)) {
      context.violations.push(`${familyContract.heading}:stage-map`);
      continue;
    }
    for (const [stage, edgeName] of Object.entries(familyContract.stages)) {
      const edgeContract = codeEdges[edgeName];
      validateNavigationCodeEdge(edgeContract, stage, context);
    }
  }
  return [...new Set(context.violations)].sort();
}

function edge(input: NavigationCodeEdge): NavigationCodeEdge {
  return input;
}

function family(heading: string, edgeNames: readonly (keyof typeof codeEdges)[]) {
  return {
    heading,
    stages: Object.fromEntries(
      stageOrder.map((stage, index) => [stage, edgeNames[index]]),
    ) as Record<TraceStage, keyof typeof codeEdges>,
  };
}
