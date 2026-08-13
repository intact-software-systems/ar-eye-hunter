import { execFileSync } from 'node:child_process';

const repository = 'intact-software-systems/ar-eye-hunter';
const gitObjectIdPattern = /^[0-9a-f]{40}$/u;

export function createGitHubGovernanceApi(repoRoot) {
  return {
    readCurrentUser: () => readGitHubJson(repoRoot, ['user']),
    readPermission: (login) =>
      readGitHubJson(repoRoot, [
        `repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`,
      ]),
    readRemoteMain: () => readGitHubJson(repoRoot, [`repos/${repository}/git/ref/heads/main`]),
    readCommit: (commitOid) =>
      readGitHubJson(repoRoot, [`repos/${repository}/commits/${commitOid}`]),
    readBlob: (blobOid) =>
      decodeGitHubGitBlob(
        blobOid,
        readGitHubJson(repoRoot, [`repos/${repository}/git/blobs/${blobOid}`]),
      ),
    readWorkflowRun: (runId) =>
      readGitHubJson(repoRoot, [`repos/${repository}/actions/runs/${runId}`]),
    writeBlob: (blob) =>
      readGitHubJson(repoRoot, [`repos/${repository}/git/blobs`, '--method', 'POST'], blob),
    writeCommit: (publication) => writeGovernanceCommit(repoRoot, publication),
  };
}

export function decodeGitHubGitBlob(requestedOid, response) {
  try {
    if (
      !gitObjectIdPattern.test(requestedOid) ||
      response?.sha !== requestedOid ||
      response.encoding !== 'base64' ||
      typeof response.content !== 'string' ||
      !Number.isSafeInteger(response.size) ||
      response.size < 0
    ) {
      throw new Error('invalid blob metadata');
    }
    const encoded = response.content.replace(/[\r\n]/gu, '');
    if (!isCanonicalBase64(encoded)) {
      throw new Error('invalid base64 content');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.byteLength !== response.size || bytes.toString('base64') !== encoded) {
      throw new Error('blob size or encoding mismatch');
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('GitHub did not return the exact requested UTF-8 blob');
  }
}

function isCanonicalBase64(value) {
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value);
}

function writeGovernanceCommit(repoRoot, publication) {
  const query = `mutation CreateGovernanceDecision($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid } }
  }`;
  const response = readGitHubJson(repoRoot, ['graphql'], {
    query,
    variables: {
      input: {
        branch: {
          repositoryNameWithOwner: publication.repository,
          branchName: publication.branchName,
        },
        expectedHeadOid: publication.expectedHeadOid,
        message: { headline: publication.message },
        fileChanges: {
          additions: publication.additions,
          deletions: publication.deletions,
        },
      },
    },
  });
  if (response?.errors !== undefined) {
    throw new Error('GitHub createCommitOnBranch returned GraphQL errors');
  }
  const oid = response?.data?.createCommitOnBranch?.commit?.oid;
  return typeof oid === 'string' ? { oid } : {};
}

function readGitHubJson(repoRoot, apiArguments, body) {
  let output;
  try {
    output = execFileSync('gh', ['api', ...apiArguments, ...(body ? ['--input', '-'] : [])], {
      cwd: repoRoot,
      encoding: 'utf8',
      input: body ? `${JSON.stringify(body)}\n` : undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new Error(`GitHub API request failed closed: ${safeApiFailure(error)}`);
  }
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('GitHub API returned invalid JSON');
  }
}

function safeApiFailure(error) {
  if (typeof error?.status === 'number') {
    return `gh exited ${error.status}`;
  }
  return 'gh invocation failed';
}
