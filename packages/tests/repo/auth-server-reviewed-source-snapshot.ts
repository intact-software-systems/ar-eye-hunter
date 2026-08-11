import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

export interface ReviewedSourceSnapshot {
  readonly blob: string;
  readonly path: string;
}

export interface AuthTestPredecessorSnapshot extends ReviewedSourceSnapshot {
  readonly finalOwners: readonly string[];
}

export interface AuthTestFinalOwnerSnapshot extends ReviewedSourceSnapshot {
  readonly caseCount: number;
}

export interface AuthNavigationSourceSnapshot extends ReviewedSourceSnapshot {
  readonly regions: readonly string[];
}

interface ValidateReviewedSourceSnapshotInput {
  readonly actualSources: ReadonlyMap<string, string>;
  readonly expectedSources: readonly ReviewedSourceSnapshot[];
}

export const authTestProvenanceBaseCommit = '8152de39faf2d630158143366596d61346e20457';

export const authTestPredecessorSnapshot: readonly AuthTestPredecessorSnapshot[] = [
  {
    path: 'packages/tests/shared-server/app-auth-conflict-inbox.test.ts',
    blob: '9efc2a219ba1326f718e5a49894759f0c346375c',
    finalOwners: ['packages/tests/shared-server/auth/auth-ticket-conflict.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-inbox-service.test.ts',
    blob: '3c35ca92dfc2e1878eb06e1582f8d7e70e61ea68',
    finalOwners: [
      'packages/tests/shared-server/auth/auth-command-and-result-codecs.test.ts',
      'packages/tests/shared-server/auth/auth-inbox-registration-and-routing.test.ts',
    ],
  },
  {
    path: 'packages/tests/shared-server/app-auth-inbox-test-harness.ts',
    blob: 'c3c93377ad5091cbb7e6c6956af6ec0c80975162',
    finalOwners: ['packages/tests/shared-server/auth/auth-app-inbox-test-runtime.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-legacy-cutoff.test.ts',
    blob: 'df3070f84248415295ab110777df69e5d24fa696',
    finalOwners: ['packages/tests/shared-server/auth/auth-legacy-cutoff.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-legacy-replay-inbox.test.ts',
    blob: 'adda7eeebf501ccc7a7ec20d1c78e7f35c7d3bd3',
    finalOwners: ['packages/tests/shared-server/auth/auth-legacy-replay.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-persistence-inbox.test.ts',
    blob: 'ead9212d82fdef35a59e93c6dc77b997db396b6b',
    finalOwners: ['packages/tests/shared-server/auth/auth-persistence-security.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-public-routing-inbox.test.ts',
    blob: 'bbe882759769473148a9c2d97aa0b59446266e57',
    finalOwners: ['packages/tests/shared-server/auth/auth-public-command-routing.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/app-auth-transaction-inbox.test.ts',
    blob: 'ef6acc5f7848222bc95b55a8e48a2d87192750d3',
    finalOwners: ['packages/tests/shared-server/auth/auth-transaction-boundary.test.ts'],
  },
  {
    path: 'packages/tests/shared-server/auth-fixture.ts',
    blob: 'f2d6ee904a358829cd1a19429449ebddaa01edbf',
    finalOwners: ['packages/tests/shared-server/auth/auth-test-fixtures.ts'],
  },
  {
    path: 'packages/tests/shared-server/auth-login-service.test.ts',
    blob: '34e47b711c43247148f02665fe0d9ac96566ace4',
    finalOwners: [
      'packages/tests/shared-server/auth/auth-credential-login.test.ts',
      'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts',
    ],
  },
  {
    path: 'packages/tests/shared-server/request-auth-service.test.ts',
    blob: 'd3d31d43cd2b312b91ffb72e4ceae755c5d5ab9f',
    finalOwners: ['packages/tests/shared-server/auth/auth-request-proof.test.ts'],
  },
];

export const authTestFinalOwnerSnapshot: readonly AuthTestFinalOwnerSnapshot[] = [
  finalOwner(
    'packages/tests/shared-server/auth/auth-ticket-conflict.test.ts',
    '7b207b5ccde6949161ea2e7be92417517b443ed6',
    2,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-command-and-result-codecs.test.ts',
    'a217e493498b28012df0292707b725b9ce1c2a73',
    2,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-inbox-registration-and-routing.test.ts',
    'ca4f7c6e7df721c632135b9c98bed447927e9846',
    3,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-app-inbox-test-runtime.ts',
    '9786e4ca05e757b7bd74896cdb899974213b80e4',
    0,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-legacy-cutoff.test.ts',
    '3d927ba9179e5ff57ef7aa4c9a83630eed94220b',
    3,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-legacy-replay.test.ts',
    '85a785ba7f9606cbd9001faa1aaa11a75deb1074',
    3,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-persistence-security.test.ts',
    'c57f811595b0b9014601e5896182a2e6669343df',
    9,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-public-command-routing.test.ts',
    '0e26f48d1be01da42abd46507ee1f7d9c79ae7a0',
    3,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-transaction-boundary.test.ts',
    '3b792e7526b48021a21e8d7c5ead7b2770081dfe',
    3,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-test-fixtures.ts',
    '815a7212299f95ceb8e097aca4a241ded3036133',
    0,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-credential-login.test.ts',
    '1fa0c2b6cc4ab460c4e9be7351e2e193c0f24b50',
    5,
  ),
  finalOwner(
    'packages/tests/repo/auth-server-compatibility-runtime-identity.test.ts',
    '5660f227f83de5cb9ef926b4a501d0deed100c7d',
    6,
  ),
  finalOwner(
    'packages/tests/shared-server/auth/auth-request-proof.test.ts',
    '13683f29e923c7a99db0ee3813b8fc613774ea72',
    4,
  ),
];

export const authNavigationReadmeSnapshot: ReviewedSourceSnapshot = {
  path: 'packages/shared-server/rallar-system/auth/README.md',
  blob: 'a6b33cbb0d409fc5640f57a3d3f79cc25b762607',
};

export const authNavigationStageLabels = [
  '### Construction and callback registration',
  '**Construction:**',
  '**Callback registration:**',
  '### Later handler invocation',
  '**Later handler invocation:**',
  '**First guard/validation:**',
  '**Transaction/retry or query call:**',
  '**Durable write or query-only N/A:**',
  '**Commit/after-commit:**',
  '**Normal return:**',
  '**Early return/no-op:**',
  '**Terminal throw/rejection:**',
  '**Cleanup/finally/rollback:**',
  '**Caller propagation:**',
  '**Compatibility path:**',
] as const;

export const authNavigationSourceSnapshot: readonly AuthNavigationSourceSnapshot[] = [
  navigationSource('apps/api-v1/src/middleware.ts', '77b20cd6d40709d4db521d50acdb636a5a474c5f', [
    'initialise',
  ]),
  navigationSource(
    'apps/api-v1/src/repository/createStateRepositories.ts',
    'c51bc5e7b1f5ba5fdc0fead3cb2d0a0b977d9766',
    ['createAuthSessionRepository'],
  ),
  navigationSource(
    'apps/api-v1/src/repository/login-repository.ts',
    'b4eee4b5bdeefad29f5095da45fb0729e732b698',
    ['login'],
  ),
  navigationSource(
    'apps/api-v1/src/routes/config-route.ts',
    '800e73f7e18be3b39cca21884c8c8ba922167bae',
    ['init'],
  ),
  navigationSource(
    'apps/api-v1/src/services/request-auth-service.ts',
    'f97a3fc5d9bb3bcfe5c66505a27ef4464ba82194',
    ['requireApiAuthSession'],
  ),
  navigationSource(
    'packages/shared-server/http/request-auth-service.ts',
    '9bd5cab55a669c66b21a7d1257eec4c44280b339',
    ['readBearerToken', 'requireApiAuthSession'],
  ),
  navigationSource(
    'packages/shared-server/postgres/run-in-transaction.ts',
    '2ae8c8ae8fef7addebc66b58c9e232a13c0f2d49',
    ['runInTransaction'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/auth-mutation-service.ts',
    '6a7cc04eb0c75a00bcae090c9b3a9e6e87487405',
    ['createAuthMutationService'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/inbox/app-auth-inbox-service.ts',
    '8c32f7293cbbf20368344bcf868ea40570226880',
    [
      'AppAuthInboxService.constructor',
      'AppAuthInboxService.consumeWebSocketTicket',
      'AppAuthInboxService.logoutSession',
      'AppAuthInboxService.processAuthCommandUntilCompletion',
    ],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/inbox/auth-inbox-handler.ts',
    'd726866071756b7e9eded9c8d8914e97ad253f4e',
    ['AuthInboxHandler.processAuthMutation'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/login/authenticate-auth-user.ts',
    'a4d0bee34d231e15ab065581ce392586c1468e0f',
    ['authenticateAuthUser'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-session-mutation.ts',
    '309df9e16f03d16613e90cf61650c4de2f174ddb',
    ['computeLogoutAuthSession'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/compute/compute-auth-ticket-mutation.ts',
    '49f8b652e15dc9a02110ee834ea69e82ac4e1e1e',
    ['computeIssueAuthWebSocketTicket'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/decode-auth-mutation-command.ts',
    '15f801ef500d1fc078ceb1c02e491470354e935f',
    ['decodeAuthMutationCommand'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-session-mutation.ts',
    'ce470043262d49d40b2729a05abcd1798f437afd',
    ['validateLogoutAuthSession'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/validate/validate-auth-ticket-mutation.ts',
    'f13535675707c78eeb0d4f0f8bee80c4e4b075a9',
    ['validateIssueAuthWebSocketTicket'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/write/write-auth-mutation.ts',
    'af2901b4f3c829caf8b46b5e242145e9e40f0287',
    ['writeAuthMutation'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/write/write-auth-session.ts',
    'e2d0e23baa5a048a0ee066f1964631c5ea312202',
    ['writeAuthSession', 'writeAuthLogout'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/mutation/write/write-auth-ticket-mutation.ts',
    '1efd98e5eeed0106fc58b737d49f12abdf3a8e58',
    ['writeAuthWebSocketTicketIssue'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/persistence/auth-session-repository.ts',
    '663d4ad756a55c03f2e8b53b9d349aafe002d1e5',
    ['AuthSessionRepository'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/auth/sessions/require-issue-session-lifecycle.ts',
    '220daf53f11b91f7f99e8bc0b51ae0b09fa3c594',
    ['requireIssueSessionLifecycle'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/repositories/AuthSessionRepository.ts',
    '344ace03466d59359c8070a1c8ffab370e60eb3a',
    ['AuthSessionRepository'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/services/AppAuthInboxService.ts',
    '18bbacd9733ade7259502c50b3ae809d7b16d63e',
    ['AppAuthInboxService'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/services/app-inbox-transaction-writer.ts',
    'f6ee38b5f0c4c9866db2f1dd553889987afaef5b',
    ['AppInboxTransactionWriter.writeFinalizedMutation', 'AppInboxTransactionWriter.inTransaction'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/services/auth-login-service.ts',
    '5c65bb6c4063550287c136e1af021f666b23a80d',
    ['authenticateAuthUser'],
  ),
  navigationSource(
    'packages/shared-server/rallar-system/services/auth-state-mutations.ts',
    'e801c1ae4a97d58dc6316a58edf3ca8ac597603b',
    ['createAuthMutationService'],
  ),
];

export function validateReviewedSourceSnapshot(
  input: ValidateReviewedSourceSnapshotInput,
): readonly string[] {
  const issues = validateExpectedSources(input.expectedSources);
  const expectedPaths = new Set(input.expectedSources.map(({ path }) => path));

  for (const expected of input.expectedSources) {
    const actualSource = input.actualSources.get(expected.path);
    if (actualSource === undefined) {
      issues.push(`source.missing:${expected.path}`);
      continue;
    }
    const actualBlob = toGitBlobId(actualSource);
    if (actualBlob !== expected.blob) {
      issues.push(`source.changed:${expected.path}:expected=${expected.blob}:actual=${actualBlob}`);
    }
  }
  for (const actualPath of input.actualSources.keys()) {
    if (!expectedPaths.has(actualPath)) issues.push(`source.extra:${actualPath}`);
  }
  return issues.sort();
}

function validateExpectedSources(expectedSources: readonly ReviewedSourceSnapshot[]): string[] {
  const issues: string[] = [];
  const paths = new Set<string>();
  for (const sourceSnapshot of expectedSources) {
    if (paths.has(sourceSnapshot.path)) issues.push(`snapshot.duplicate:${sourceSnapshot.path}`);
    paths.add(sourceSnapshot.path);
    if (!/^[0-9a-f]{40}$/u.test(sourceSnapshot.blob)) {
      issues.push(`snapshot.blob:${sourceSnapshot.path}`);
    }
  }
  return issues;
}

function toGitBlobId(sourceText: string): string {
  const header = `blob ${Buffer.byteLength(sourceText, 'utf8')}\0`;
  return createHash('sha1').update(header).update(sourceText).digest('hex');
}

function finalOwner(path: string, blob: string, caseCount: number): AuthTestFinalOwnerSnapshot {
  return { path, blob, caseCount };
}

function navigationSource(
  path: string,
  blob: string,
  regions: readonly string[],
): AuthNavigationSourceSnapshot {
  return { path, blob, regions };
}
