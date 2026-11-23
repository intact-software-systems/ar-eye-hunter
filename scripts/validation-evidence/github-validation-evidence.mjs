import { readFileSync } from 'node:fs';
import path from 'node:path';

import { readGithubArtifactDirectory } from '../github-actions/read-github-workflow-runs.mjs';

export function readGithubValidationEvidenceArtifact({ repository, runId }) {
    return readGithubArtifactDirectory({
        repository,
        runId,
        artifactName: 'validation-evidence-v2',
        readDirectory: readValidationEvidenceFile
    });
}

function readValidationEvidenceFile(artifactDirectory) {
    try {
        return readFileSync(path.join(artifactDirectory, 'validation-evidence-v2.json'), 'utf8');
    }
    catch {
        return undefined;
    }
}
