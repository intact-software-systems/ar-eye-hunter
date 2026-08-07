export const approvedBase = '61e708708f94328f095f1f1fa5690747bb933476';

export interface AuthPrATargetLineage {
  path: string;
  symbols: string[];
  inheritedStyleFindings: string[];
}

export interface AuthPrALineage {
  base: string;
  source: {
    path: string;
    blob: string;
    symbols: string[];
  };
  targets: AuthPrATargetLineage[];
}

export const authPrALineages: AuthPrALineage[] = [
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-contracts.ts',
    'acf3e2b594e8b2519678d76f82de720f966fa09a',
    ['AuthMutationCommand', 'AuthMutationResult', 'AuthMutationService'],
    [
      target('auth-mutation-service.ts', ['AuthMutationService']),
      target('mutation/auth-mutation-contracts.ts', ['AuthMutationCommand', 'AuthMutationResult']),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-codecs.ts',
    '1baa7032de313d639228de272aee6f5a0abf9d32',
    ['decodeAuthMutationCommand', 'decodeAuthMutationResult'],
    [
      target(
        'mutation/decode-auth-mutation-command.ts',
        ['decodeAuthMutationCommand'],
        ['boundary.unknown'],
      ),
      target(
        'mutation/decode-auth-mutation-result.ts',
        ['decodeAuthMutationResult'],
        ['boundary.unknown'],
      ),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-errors.ts',
    '284efef5fee4ed9d66cf9fbf7cb150c775cdd936',
    ['AuthMutationRejectedError', 'requireMatchingCredentialDigest'],
    [
      target('mutation/auth-mutation-rejected-error.ts', ['AuthMutationRejectedError']),
      target('mutation/read/capture-auth-mutation-facts.ts', ['captureAuthMutationFacts']),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-public-results.ts',
    '19386ecd6f6ba8c15a92bfdfa6138dd8733f9635',
    ['toAuthMutationPublicResult'],
    [target('mutation/to-auth-mutation-public-result.ts', ['toAuthMutationPublicResult'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-session-lifecycle.ts',
    '372782728974a39f34f1d372fb4a6fe8915ccced',
    ['requireIssueSessionLifecycle'],
    [target('sessions/require-issue-session-lifecycle.ts', ['requireIssueSessionLifecycle'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-session-proof-secret.ts',
    '317c4138e3f4f213da14c9be6e4e3b75481b4d9e',
    ['authSessionProofSecret'],
    [target('sessions/auth-session-proof-secret.ts', ['authSessionProofSecret'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/repositories/auth-secret-digest.ts',
    'bdcbff2f82b3b345818d7a13e3f5793f05a53d08',
    ['hashAuthSecret'],
    [target('credentials/hash-auth-secret.ts', ['hashAuthSecret'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-credential-issuer.ts',
    '489233ca4fa42aaaa3cdf4109fe034281f9ee5d4',
    ['AuthCredentialIssuer', 'createHmacAuthCredentialIssuer'],
    [
      target(
        'credentials/auth-credential-issuer.ts',
        ['AuthCredentialIssuer', 'createHmacAuthCredentialIssuer'],
        ['boundary.unknown'],
      ),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-login-service.ts',
    'ee149e928206c13192545a555f32cdae09b676f5',
    ['authenticateAuthUser', 'prepareAuthUserRegistration'],
    [
      target('login/authenticate-auth-user.ts', ['authenticateAuthUser']),
      target('login/prepare-auth-user-registration.ts', ['prepareAuthUserRegistration']),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-read.ts',
    '587ab2e3a9a2ab32827857086d0180eed50fa07b',
    ['captureAuthMutationFacts', 'readAuthMutation'],
    [target('mutation/read/capture-auth-mutation-facts.ts', ['captureAuthMutationFacts'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-compute.ts',
    'b48f229659ee90e85c3aeba041959e62bb0c7139',
    ['computeAuthMutation', 'toLogoutWsOutbox'],
    [
      target('mutation/compute/to-auth-logout-outbox.ts', ['toAuthLogoutOutbox']),
      target('mutation/compute/compute-auth-agent-ticket-mutation.ts', [
        'computeAuthAgentTicketMutation',
      ]),
      target('mutation/compute/compute-auth-mutation.ts', ['computeAuthMutation']),
      target('mutation/compute/compute-auth-session-mutation.ts', ['computeAuthSessionMutation']),
      target('mutation/compute/compute-auth-ticket-mutation.ts', ['computeAuthTicketMutation']),
      target('mutation/compute/compute-auth-user-registration.ts', ['computeAuthUserRegistration']),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-service.ts',
    'ef7ebff0d0cd9010ea54c845dc5f0bfed41bf8e1',
    ['createAuthMutationService'],
    [target('auth-mutation-service.ts', ['createAuthMutationService'])],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-validate.ts',
    '24f6d4c047706f44d6efe36f6993ce2da8030201',
    ['validateAuthMutation'],
    [
      target('mutation/validate/validate-auth-mutation.ts', ['validateAuthMutation']),
      target('mutation/validate/validate-auth-session-mutation.ts', [
        'validateAuthSessionMutation',
      ]),
      target('mutation/validate/validate-auth-ticket-mutation.ts', ['validateAuthTicketMutation']),
      target('mutation/validate/validate-auth-user-mutation.ts', ['validateAuthUserMutation']),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-validation-shared.ts',
    '20b5e1c1f4243a3ef0cbf82ccd0baea92ff20ec6',
    ['equalAuthJson', 'requireMatchingAuthKind', 'requireAuthTicket'],
    [
      target('mutation/validate/auth-mutation-validation.ts', [
        'equalAuthJson',
        'requireMatchingAuthKind',
        'requireAuthTicket',
      ]),
    ],
  ),
  lineage(
    'packages/shared-server/rallar-system/services/auth-state-agent-validation.ts',
    'fe31c426fbbf0979d5ab40288eaf8c428ea28094',
    ['validateAgentIssueRead', 'validateConsumeAgentTicketRead'],
    [
      target('mutation/validate/validate-auth-agent-ticket-mutation.ts', [
        'validateAuthAgentTicketMutation',
        'validateAgentIssueRead',
        'validateConsumeAgentTicketRead',
      ]),
    ],
  ),
];

export const authPrAProductionTargets = [
  'packages/shared-server/rallar-system/auth/auth-mutation-service.ts',
  'packages/shared-server/rallar-system/auth/credentials/auth-credential-issuer.ts',
  'packages/shared-server/rallar-system/auth/credentials/hash-auth-secret.ts',
  'packages/shared-server/rallar-system/auth/login/authenticate-auth-user.ts',
  'packages/shared-server/rallar-system/auth/login/prepare-auth-user-registration.ts',
  'packages/shared-server/rallar-system/auth/mutation/auth-mutation-contracts.ts',
  'packages/shared-server/rallar-system/auth/mutation/auth-mutation-rejected-error.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/to-auth-logout-outbox.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-agent-ticket-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-session-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-ticket-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-user-registration.ts',
  'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts',
  'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-result.ts',
  'packages/shared-server/rallar-system/auth/mutation/read/capture-auth-mutation-facts.ts',
  'packages/shared-server/rallar-system/auth/mutation/to-auth-mutation-public-result.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/auth-mutation-validation.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-agent-ticket-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-session-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-ticket-mutation.ts',
  'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-user-mutation.ts',
  'packages/shared-server/rallar-system/auth/sessions/auth-session-proof-secret.ts',
  'packages/shared-server/rallar-system/auth/sessions/require-issue-session-lifecycle.ts',
] as const;

function lineage(
  path: string,
  blob: string,
  symbols: string[],
  targets: AuthPrATargetLineage[],
): AuthPrALineage {
  return { base: approvedBase, source: { path, blob, symbols }, targets };
}

function target(
  relativePath: string,
  symbols: string[],
  inheritedStyleFindings: string[] = [],
): AuthPrATargetLineage {
  return {
    path: `packages/shared-server/rallar-system/auth/${relativePath}`,
    symbols,
    inheritedStyleFindings,
  };
}
