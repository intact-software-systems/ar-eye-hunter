import path from 'node:path';

import { findingMagnitude } from './finding-magnitude.mjs';
import { scanProductionSources } from './repository-scan.mjs';

const structuralFactRuleIds = new Set([
    'file.length',
    'layout.directory-density',
    'layout.feature-prefix-cluster'
]);
const factScanOptions = Object.freeze({
    layoutOnly: false,
    layoutDetails: false,
    constructionDetails: false,
    outputContracts: false,
    objectInterfaces: false,
    cognitiveMetrics: false
});

export function collectRepositoryStyleFacts(input) {
    return scanProductionSources({
        repoRoot: input.repoRoot,
        sources: input.sources,
        options: factScanOptions
    })
        .findings.filter((finding) => structuralFactRuleIds.has(finding.ruleId))
        .map((finding) => ({
            ruleId: finding.ruleId,
            target: toRelativePath(input.repoRoot, finding.file),
            ...(finding.ruleId === 'layout.feature-prefix-cluster'
                ? { identity: readFeaturePrefix(finding.message) }
                : {}),
            magnitude: findingMagnitude(finding)
        }));
}

function readFeaturePrefix(message) {
    const match = /prefix '([^']+)' appears/u.exec(message);
    if (match === null) {
        throw new Error('repo-style feature-prefix fact is missing its canonical identity');
    }
    return match[1];
}

const toRelativePath = (repoRoot, file) => path.relative(repoRoot, file).split(path.sep).join('/');
