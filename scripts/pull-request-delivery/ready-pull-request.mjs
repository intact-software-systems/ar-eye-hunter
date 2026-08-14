export function markPullRequestReady(execFile) {
  execFile('gh', ['pr', 'ready'], { encoding: 'utf8' });
}

export function armPullRequestAutoMerge(execFile) {
  execFile('gh', ['pr', 'merge', '--auto', '--squash'], { encoding: 'utf8' });
}
