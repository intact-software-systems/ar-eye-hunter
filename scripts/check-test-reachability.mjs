import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE_PATTERN = /(\.(test|spec)\.(ts|tsx|mts|mjs|js)|_test\.(ts|mts))$/;
const manualSuitesPath = 'tests/manual-suites.json';

function git(...args) {
    return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function run(command, args) {
    return execFileSync(command, args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore']
    });
}

function toRepositoryPath(absolutePath) {
    return relative(repositoryRoot, absolutePath).split('\\').join('/');
}

function readTrackedTestFiles() {
    return git('ls-files').split('\n').filter((file) =>
        TEST_FILE_PATTERN.test(file) && existsSync(join(repositoryRoot, file))
    );
}

function readWorkflowCommands() {
    const files = [
        ...readdirSync(join(repositoryRoot, '.github/workflows')).map((name) => `.github/workflows/${name}`),
        ...readdirSync(join(repositoryRoot, '.github/actions')).map((name) => `.github/actions/${name}/action.yml`)
    ].filter((file) => existsSync(join(repositoryRoot, file)) && /\.ya?ml$/.test(file));
    return files.flatMap((file) =>
        readFileSync(join(repositoryRoot, file), 'utf8')
            .replace(/\\\n\s*/g, ' ')
            .split('\n')
            .map((line) => line.replace(/^\s*(-\s+)?(run:\s*)?/, '').trim())
            .filter((line) => /^(npm run|npx (vitest|playwright)|deno test|deno task|cd )/.test(line))
    );
}

function readPackageScripts() {
    return JSON.parse(readFileSync(join(repositoryRoot, 'package.json'), 'utf8')).scripts;
}

function listVitestFiles(configArguments) {
    const output = run('npx', ['vitest', 'list', '--filesOnly', '--json', ...configArguments]);
    return JSON.parse(output).map((entry) => toRepositoryPath(entry.file));
}

function listPlaywrightFiles(config) {
    const report = JSON.parse(run('npx', ['playwright', 'test', '--config', config, '--list', '--reporter=json']));
    const files = new Set();
    const visit = (suite) => {
        if (suite.file) {
            files.add(suite.file);
        }
        (suite.suites ?? []).forEach(visit);
    };
    visit(report);
    const configDirectory = dirname(join(repositoryRoot, config));
    return [...files].map((file) => toRepositoryPath(resolve(report.config?.rootDir ?? configDirectory, file)));
}

function readFlagValue(tokens, flag) {
    const index = tokens.findIndex((token) => token === flag || token.startsWith(`${flag}=`));
    if (index === -1) {
        return null;
    }
    return tokens[index].includes('=') ? tokens[index].split('=')[1] : tokens[index + 1];
}

const FLAGS_WITH_VALUE = new Set(['--config', '--project', '--shard', '--reporter', '--testTimeout']);

function readPathArguments(tokens) {
    return tokens.filter((token, index) =>
        !token.startsWith('-') && !FLAGS_WITH_VALUE.has(tokens[index - 1]) && /^[\w./@-]+$/.test(token) &&
        token.includes('/')
    );
}

function collectFilesUnder(prefix, trackedFiles) {
    const normalised = prefix.replace(/\/$/, '');
    return trackedFiles.filter((file) => file === normalised || file.startsWith(`${normalised}/`));
}

function expandCommand(command, state) {
    const reached = state.reached;
    let workingDirectory = '';
    for (const segment of command.split(/&&|;/).map((part) => part.trim()).filter(Boolean)) {
        const tokens = segment.replace(/"[^"]*"/g, ' ').split(/\s+/).filter(Boolean);
        if (tokens[0] === 'cd') {
            workingDirectory = tokens[1] === undefined ? workingDirectory : join(workingDirectory, tokens[1]);
            workingDirectory = workingDirectory.replace(/^(\.\.\/?)+$/, '').replace(/^\.$/, '');
            continue;
        }
        const scriptName = segment.match(/^(?:[A-Z_]+=\S+\s+)*npm run ([\w:.-]+)/)?.[1];
        if (scriptName) {
            expandScript(scriptName, state);
            continue;
        }
        if (/\bplaywright test\b/.test(segment)) {
            const config = readFlagValue(tokens, '--config');
            const specs = tokens.filter((token) => /\.spec\.ts$/.test(token));
            (specs.length > 0 ? specs : listPlaywrightFiles(config)).forEach((file) => reached.add(file));
        }
        else if (/\bvitest\b/.test(segment) && /\brun\b/.test(segment)) {
            const paths = readPathArguments(tokens.slice(tokens.findIndex((token) => /vitest/.test(token)) + 2));
            const projects = readFlagValue(tokens, '--project');
            const config = readFlagValue(tokens, '--config');
            const listArguments = [
                ...(config ? ['--config', config] : []),
                ...(projects ? ['--project', projects] : [])
            ];
            if (paths.length > 0) {
                paths.flatMap((path) => collectFilesUnder(path, state.trackedFiles)).forEach((file) =>
                    reached.add(file)
                );
            }
            else {
                listVitestFiles(listArguments).forEach((file) => reached.add(file));
            }
        }
        else if (/\bdeno (test|task test)\b/.test(segment)) {
            const paths = readPathArguments(tokens.slice(tokens.indexOf('test') + 1));
            const roots = paths.length > 0 ? paths.map((path) => join(workingDirectory, path)) : [workingDirectory];
            roots
                .flatMap((root) => collectFilesUnder(root, state.trackedFiles))
                .filter((file) => TEST_FILE_PATTERN.test(file))
                .forEach((file) => reached.add(file));
        }
    }
}

function expandScript(scriptName, state) {
    if (state.visitedScripts.has(scriptName) || !state.scripts[scriptName]) {
        return;
    }
    state.visitedScripts.add(scriptName);
    expandCommand(state.scripts[scriptName], state);
}

function computeReachedFiles(trackedFiles) {
    const state = { reached: new Set(), scripts: readPackageScripts(), visitedScripts: new Set(), trackedFiles };
    for (const command of readWorkflowCommands()) {
        expandCommand(command, state);
    }
    return state.reached;
}

function readManualSuites() {
    return JSON.parse(readFileSync(join(repositoryRoot, manualSuitesPath), 'utf8'));
}

function validateManualSuite(suite) {
    return ['paths', 'owner', 'command', 'reason'].filter((field) => !suite[field] || suite[field].length === 0)
        .map((field) => `${manualSuitesPath}: entry ${JSON.stringify(suite.paths)} is missing ${field}`);
}

function computeFindings(trackedFiles, reached, suites) {
    const findings = suites.flatMap(validateManualSuite);
    const claimed = new Set();
    for (const suite of suites) {
        const matches = suite.paths.flatMap((path) => collectFilesUnder(path, trackedFiles)).filter((file) =>
            TEST_FILE_PATTERN.test(file)
        );
        if (matches.length === 0) {
            findings.push(`${manualSuitesPath}: ${JSON.stringify(suite.paths)} matches no test file`);
        }
        for (const file of matches) {
            claimed.add(file);
            if (reached.has(file)) {
                findings.push(`${manualSuitesPath}: ${file} is run by a CI workflow, so it is not a manual suite`);
            }
        }
    }
    for (const file of trackedFiles) {
        if (!reached.has(file) && !claimed.has(file)) {
            findings.push(`${file}: no CI workflow runs this test and ${manualSuitesPath} does not own it`);
        }
    }
    return findings;
}

const trackedFiles = readTrackedTestFiles();
const reached = computeReachedFiles(trackedFiles);
const findings = computeFindings(trackedFiles, reached, readManualSuites());
const manualCount = trackedFiles.filter((file) => !reached.has(file)).length;
console.log(
    `Test reachability: ${trackedFiles.length} test files, ${reached.size} reached by CI, ${manualCount} manual.`
);
for (const finding of findings) {
    console.error(finding);
}
process.exit(findings.length === 0 ? 0 : 1);
