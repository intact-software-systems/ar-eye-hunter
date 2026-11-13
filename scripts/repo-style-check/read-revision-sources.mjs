import { spawnSync } from 'node:child_process';
import path from 'node:path';

const objectHeaderPattern = /^[0-9a-f]+ (\S+) (\d+)$/u;
// spawnSync's default 1 MiB stdout limit once dropped every larger blob and would have emptied a
// longer listing; the readers here take output of any size.
const unboundedOutput = { encoding: 'utf8', maxBuffer: Infinity };

export function readRevisionSources({ cwd, repoRoot, revision, isGovernedSourceFile }) {
    const files = runGit(cwd, ['ls-tree', '-r', '--name-only', revision])
        .split('\n')
        .filter(Boolean)
        .filter((file) => isGovernedSourceFile(path.join(repoRoot, file)));
    const blobs = readRevisionBlobs(cwd, revision, files);
    return files
        .map((file, index) => ({
            file: path.join(repoRoot, file),
            raw: blobs[index] ?? readRevisionFile(cwd, revision, file)
        }))
        .filter((source) => source.raw !== undefined);
}

function readRevisionFile(cwd, revision, file) {
    const result = spawnSync('git', ['show', `${revision}:${file}`], { cwd, ...unboundedOutput });
    return result.status === 0 ? result.stdout : undefined;
}

// One `git cat-file --batch` answers every path in order. An answer is a header line followed by
// exactly `size` content bytes and a newline, or a single line for an object it cannot show, so the
// stream is parsed by byte length, never by line. Anything but a blob is left undefined for the
// caller to read through `git show`, as it always was.
function readRevisionBlobs(cwd, revision, files) {
    if (files.length === 0) {
        return [];
    }
    const result = spawnSync('git', ['cat-file', '--batch'], {
        cwd,
        input: files.map((file) => `${revision}:${file}\n`).join(''),
        maxBuffer: Infinity
    });
    if (result.status !== 0) {
        throw new Error(result.stderr.toString('utf8').trim() || 'git cat-file --batch failed');
    }
    return toBatchBlobs(result.stdout, files.length);
}

function toBatchBlobs(stdout, count) {
    const blobs = [];
    let offset = 0;
    while (blobs.length < count) {
        const headerEnd = stdout.indexOf(0x0a, offset);
        assertBatchStream(headerEnd >= 0, 'an unterminated header');
        const header = objectHeaderPattern.exec(stdout.toString('utf8', offset, headerEnd));
        offset = headerEnd + 1;
        if (header === null) {
            blobs.push(undefined);
            continue;
        }
        const [, type, sizeText] = header;
        const end = offset + Number(sizeText);
        assertBatchStream(end < stdout.length, 'a truncated object');
        blobs.push(type === 'blob' ? stdout.toString('utf8', offset, end) : undefined);
        offset = end + 1;
    }
    assertBatchStream(offset === stdout.length, 'trailing output');
    return blobs;
}

function runGit(cwd, args) {
    const result = spawnSync('git', args, { cwd, ...unboundedOutput });
    if (result.status !== 0) {
        throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
    }
    return result.stdout;
}

function assertBatchStream(condition, problem) {
    if (!condition) {
        throw new Error(`git cat-file --batch returned ${problem}`);
    }
}
