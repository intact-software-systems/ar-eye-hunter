const repository = 'intact-software-systems/ar-eye-hunter';
const defaultBranch = 'main';
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;

export function authenticateGitHubAdministrator(authenticationInput) {
  const user = authenticationInput.readCurrentUser();
  if (user?.type !== 'User' || typeof user.login !== 'string' || user.login.trim() === '') {
    throw new Error('GitHub did not return one current human user');
  }
  const permission = authenticationInput.readPermission(user.login);
  if (
    permission?.permission !== 'admin' ||
    permission.user?.login !== user.login
  ) {
    throw new Error('current GitHub user must have effective admin repository permission');
  }
  return { login: user.login, permission: 'admin' };
}

export function authenticateRecordedGitHubAdministrator(authenticationInput) {
  if (typeof authenticationInput.login !== 'string' || authenticationInput.login.trim() === '') {
    throw new Error('recorded GitHub actor login must be non-empty');
  }
  const permission = authenticationInput.readPermission(authenticationInput.login);
  if (
    permission?.permission !== 'admin' ||
    permission.user?.login !== authenticationInput.login
  ) {
    throw new Error('recorded GitHub actor must have effective admin repository permission');
  }
  return { login: authenticationInput.login, permission: 'admin' };
}

export function validateLocalGovernancePublicationState(publicationInput) {
  const state = publicationInput.readCheckoutState();
  if (state.status !== '') {
    throw new Error('local governance publication requires a completely clean checkout');
  }
  if (
    state.headOid !== publicationInput.request.expectedHeadOid ||
    state.remoteMainOid !== publicationInput.request.expectedHeadOid
  ) {
    throw new Error('expected head must equal both local HEAD and current remote main');
  }
  return state;
}

export function publishGovernanceDecisionCommit(publicationInput) {
  const published = publicationInput.writeCommit({
    repository,
    branchName: defaultBranch,
    expectedHeadOid: publicationInput.expectedHeadOid,
    message:
      `governance(${publicationInput.operation}): ` + publicationInput.decisionId.slice(0, 12),
    additions: publicationInput.additions.map((addition) => ({
      path: addition.path,
      contents: Buffer.from(addition.content).toString('base64'),
    })),
    deletions: publicationInput.deletions.map((deletedPath) => ({ path: deletedPath })),
  });
  if (
    !isExactObject(published, ['oid']) ||
    typeof published.oid !== 'string' ||
    !gitObjectIdPattern.test(published.oid)
  ) {
    throw new Error('GitHub did not return one created commit OID');
  }
  return { oid: published.oid };
}

export function publishImmutableGitBlob(publicationInput) {
  const bytes = Buffer.from(publicationInput.bytes);
  const published = publicationInput.writeBlob({
    content: bytes.toString('base64'),
    encoding: 'base64',
  });
  if (
    !hasOnlyKeys(published, ['sha', 'url']) ||
    typeof published.sha !== 'string' ||
    !gitObjectIdPattern.test(published.sha) ||
    (published.url !== undefined && typeof published.url !== 'string')
  ) {
    throw new Error('GitHub did not return one created blob OID');
  }
  return { oid: published.sha, byteLength: bytes.byteLength };
}

function hasOnlyKeys(value, allowedKeys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowedKeys.includes(key))
  );
}

function isExactObject(value, expectedKeys) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expectedKeys].sort())
  );
}
