#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';

import { decodeGovernanceDecisionRequest } from './governance-decision-request.mjs';
import { createGitHubGovernanceApi } from './github-governance-api.mjs';

const [requestPath, outputPath, repoRoot = process.cwd()] = process.argv.slice(2);
if (requestPath === undefined || outputPath === undefined) {
  throw new Error('usage: materialize-gate-evidence <request> <output> [repo-root]');
}
const request = decodeGovernanceDecisionRequest(JSON.parse(readFileSync(requestPath, 'utf8')));
if (request.operation === 'gate.accept-deviation') {
  const evidence = createGitHubGovernanceApi(repoRoot).readGateEvidence(request.target);
  writeFileSync(outputPath, `${JSON.stringify(evidence)}\n`, { encoding: 'utf8', mode: 0o600 });
}
