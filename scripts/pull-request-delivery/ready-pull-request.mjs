export function markPullRequestReady(execFile) {
    execFile('gh', ['pr', 'ready'], { encoding: 'utf8' });
}

export function armPullRequestAutoMerge(execFile, pullRequest) {
    execFile(
        'gh',
        ['pr', 'merge', ...(pullRequest === undefined ? [] : [pullRequest]), '--auto', '--squash'],
        { encoding: 'utf8' }
    );
}
