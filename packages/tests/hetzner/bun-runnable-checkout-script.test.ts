import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { runOwnedTestProcess, type OwnedTestProcessOutcome } from './owned-test-process.ts';

const repoRoot = path.resolve(__dirname, '../../..');
const controllerDirectory = path.join(repoRoot, 'scripts/hosted-rallar/controller');
const bunRuntimePath = 'scripts/hosted-rallar/controller/rallar-bun-runtime.sh';
const serverAppDirs = [
    'apps/api-v1',
    'apps/rallar-black-box-control-server',
    'apps/relic-hunter-server-v1',
    'apps/ar-eye-hunter-server-v1'
];
const hostBunVersion = '1.4.4';

type CommitShape =
    | Readonly<{ kind: 'bun'; pinnedBunVersion: string; }>
    | Readonly<{ kind: 'deno'; }>;

interface RolloutRepository {
    readonly sourceDir: string;
    readonly checkoutDir: string;
    readonly git: (cwd: string, args: readonly string[]) => Promise<OwnedTestProcessOutcome>;
}

const bunCommit: CommitShape = { kind: 'bun', pinnedBunVersion: hostBunVersion };

async function writeCommitTree(sourceDir: string, shape: CommitShape): Promise<void> {
    await rm(path.join(sourceDir, 'apps'), { recursive: true, force: true });
    await rm(path.join(sourceDir, 'scripts'), { recursive: true, force: true });
    await rm(path.join(sourceDir, 'package-lock.json'), { force: true });
    await writeFile(path.join(sourceDir, 'package-lock.json'), '{}\n');
    for (const appDir of serverAppDirs) {
        await mkdir(path.join(sourceDir, appDir, 'src'), { recursive: true });
        await writeFile(path.join(sourceDir, appDir, 'src/main.ts'), 'export {};\n');
        if (shape.kind === 'deno') {
            await writeFile(path.join(sourceDir, appDir, 'deno.json'), '{}\n');
        }
    }
    if (shape.kind === 'deno') {
        return;
    }
    const runtime = await readFile(path.join(repoRoot, bunRuntimePath), 'utf8');
    const pinned = runtime.replace(
        /^RALLAR_MIN_BUN_VERSION="\$\{RALLAR_MIN_BUN_VERSION:-[0-9.]+\}"$/mu,
        `RALLAR_MIN_BUN_VERSION="\${RALLAR_MIN_BUN_VERSION:-${shape.pinnedBunVersion}}"`
    );
    expect(pinned).toContain(`RALLAR_MIN_BUN_VERSION:-${shape.pinnedBunVersion}}`);
    await mkdir(path.dirname(path.join(sourceDir, bunRuntimePath)), { recursive: true });
    await writeFile(path.join(sourceDir, bunRuntimePath), pinned);
}

async function commitTree(repository: RolloutRepository, shape: CommitShape, message: string): Promise<string> {
    await writeCommitTree(repository.sourceDir, shape);
    await repository.git(repository.sourceDir, ['add', '-A']);
    await repository.git(repository.sourceDir, ['commit', '-m', message]);
    return (await repository.git(repository.sourceDir, ['rev-parse', 'HEAD'])).stdout.trim();
}

/** A remote whose main is runnable Bun source, and a controller checkout cloned from it. */
async function createRolloutRepository(context: TestContext, prefix: string): Promise<RolloutRepository> {
    const tmp = await mkdtemp(path.join(tmpdir(), prefix));
    context.onTestFinished(() => rm(tmp, { recursive: true, force: true }));
    const originDir = path.join(tmp, 'origin.git');
    const repository: RolloutRepository = {
        sourceDir: path.join(tmp, 'source'),
        checkoutDir: path.join(tmp, 'checkout'),
        git: (cwd, args) => runOwnedTestProcess(context, { executable: 'git', args: [...args], options: { cwd } })
    };
    await repository.git(tmp, ['init', '--bare', originDir]);
    await mkdir(repository.sourceDir);
    await repository.git(repository.sourceDir, ['init']);
    await repository.git(repository.sourceDir, ['config', 'user.email', 'test@example.com']);
    await repository.git(repository.sourceDir, ['config', 'user.name', 'Test User']);
    await commitTree(repository, bunCommit, 'bun');
    await repository.git(repository.sourceDir, ['branch', '-M', 'main']);
    await repository.git(repository.sourceDir, ['remote', 'add', 'origin', originDir]);
    await repository.git(repository.sourceDir, ['push', '-u', 'origin', 'main']);
    await repository.git(originDir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    await repository.git(tmp, ['clone', originDir, repository.checkoutDir]);
    return repository;
}

async function runCheckoutSelfTest(
    context: TestContext,
    repository: RolloutRepository,
    repoRef: string
): Promise<OwnedTestProcessOutcome> {
    return await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [path.join(controllerDirectory, '08-rollout-controller.sh')],
        options: {
            env: {
                PATH: process.env.PATH,
                LANG: 'C',
                LC_ALL: 'C',
                RALLAR_CHECKOUT_DIR: repository.checkoutDir,
                RALLAR_REPO_REF: repoRef,
                RALLAR_BUN_SELF_TEST_VERSION: hostBunVersion,
                RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'checkout-ref'
            }
        }
    });
}

async function readCheckoutHead(repository: RolloutRepository): Promise<string> {
    return (await repository.git(repository.checkoutDir, ['rev-parse', 'HEAD'])).stdout.trim();
}

const recordingStub = '#!/usr/bin/env bash\nprintf "%s %s\\n" "$(basename "$0")" "$*" >> "$STUB_LOG"\n';
const controllerStubs: Readonly<Record<string, string>> = {
    id: '#!/usr/bin/env bash\nif [[ "$1" == -u ]]; then echo 0; else exec /usr/bin/id "$@"; fi\n',
    flock: '#!/usr/bin/env bash\nexit 0\n',
    bun: recordingStub,
    caddy: recordingStub,
    chown: recordingStub,
    curl: recordingStub,
    npm: recordingStub,
    openssl: recordingStub,
    rsync: recordingStub,
    runuser: recordingStub,
    systemctl: recordingStub
};

async function createControllerStubs(context: TestContext): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), 'rallar-controller-stubs-'));
    context.onTestFinished(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, 'bin'));
    for (const [name, body] of Object.entries(controllerStubs)) {
        await writeFile(path.join(directory, 'bin', name), body);
        await chmod(path.join(directory, 'bin', name), 0o755);
    }
    return directory;
}

describe('runnable Bun checkout', () => {
    it('checks out exact commit SHAs without treating them as branch pull refs', async (context) => {
        const repository = await createRolloutRepository(context, 'rallar-rollout-sha-ref-');
        const commitSha = (await repository.git(repository.sourceDir, ['rev-parse', 'HEAD'])).stdout.trim();

        const { stdout } = await runCheckoutSelfTest(context, repository, commitSha);

        expect(stdout).toContain(`checkoutHead=${commitSha}`);
        expect(stdout).toContain('checkoutBranch=HEAD');
    });

    it('follows a rewritten remote branch instead of failing the fast-forward of a diverged local one', async (context) => {
        const repository = await createRolloutRepository(context, 'rallar-rollout-rewritten-branch-');
        await repository.git(repository.sourceDir, ['checkout', '-b', 'feature']);
        await writeFile(path.join(repository.sourceDir, 'revision.txt'), 'first\n');
        await commitTree(repository, bunCommit, 'first');
        await repository.git(repository.sourceDir, ['push', '-u', 'origin', 'feature']);
        // The controller rolled out the first version of the branch.
        await repository.git(repository.checkoutDir, ['fetch', 'origin']);
        await repository.git(repository.checkoutDir, ['checkout', 'feature']);
        // The branch is rewritten upstream (a rebase), so the local branch no longer fast-forwards.
        await repository.git(repository.sourceDir, ['reset', '--hard', 'main']);
        await writeFile(path.join(repository.sourceDir, 'revision.txt'), 'rewritten\n');
        const rewrittenSha = await commitTree(repository, bunCommit, 'rewritten');
        await repository.git(repository.sourceDir, ['push', '--force', 'origin', 'feature']);

        const { stdout } = await runCheckoutSelfTest(context, repository, 'feature');

        expect(stdout).toContain(`checkoutHead=${rewrittenSha}`);
        expect(stdout).toContain('checkoutBranch=feature');
    });

    it.for([
        { shape: { kind: 'deno' } as const, refusal: 'apps/api-v1 is pre-Bun source' },
        { shape: { kind: 'bun', pinnedBunVersion: '1.5.0' } as const, refusal: 'needs Bun 1.5.0' }
    ])('keeps the checkout where it is for a ref that cannot run ($refusal)', async ({ shape, refusal }, context) => {
        const repository = await createRolloutRepository(context, 'rallar-rollout-unrunnable-');
        const headBefore = await readCheckoutHead(repository);
        await repository.git(repository.sourceDir, ['checkout', '-b', 'unrunnable']);
        await commitTree(repository, shape, 'unrunnable');
        await repository.git(repository.sourceDir, ['push', '-u', 'origin', 'unrunnable']);

        await expect(runCheckoutSelfTest(context, repository, 'unrunnable')).rejects.toMatchObject({
            stderr: expect.stringContaining(refusal)
        });
        expect(await readCheckoutHead(repository)).toBe(headBefore);
    });

    it.for([
        { script: '02-deploy-controller.sh' },
        { script: '08-rollout-controller.sh' }
    ])('$script refuses pre-Bun source before it installs or stops anything', async ({ script }, context) => {
        const repository = await createRolloutRepository(context, 'rallar-controller-pre-bun-');
        const headBefore = await readCheckoutHead(repository);
        await repository.git(repository.sourceDir, ['checkout', '-b', 'pre-bun']);
        await commitTree(repository, { kind: 'deno' }, 'pre-bun');
        await repository.git(repository.sourceDir, ['push', '-u', 'origin', 'pre-bun']);
        const stubDirectory = await createControllerStubs(context);
        const stubLog = path.join(stubDirectory, 'stub.log');

        await expect(runOwnedTestProcess(context, {
            executable: 'bash',
            args: [path.join(controllerDirectory, script)],
            options: {
                env: {
                    PATH: `${path.join(stubDirectory, 'bin')}:${process.env.PATH}`,
                    LANG: 'C',
                    LC_ALL: 'C',
                    HOME: stubDirectory,
                    GIT_CONFIG_GLOBAL: path.join(stubDirectory, 'gitconfig'),
                    STUB_LOG: stubLog,
                    RALLAR_CONTROLLER_ROLE: 'control',
                    RALLAR_CONTROLLER_LOCK_ROOT: path.join(stubDirectory, 'lock'),
                    RALLAR_CHECKOUT_DIR: repository.checkoutDir,
                    RALLAR_REPO_REF: 'pre-bun',
                    RALLAR_BUN_SELF_TEST_VERSION: hostBunVersion
                }
            }
        })).rejects.toMatchObject({
            stderr: expect.stringContaining('apps/rallar-black-box-control-server is pre-Bun source')
        });

        const commands = (await readFile(stubLog, 'utf8').catch(() => '')).split('\n').filter((line) => line !== '');
        expect(commands.filter((line) => /^(systemctl|npm|runuser|chown|rsync) /u.test(line))).toEqual([]);
        expect(await readCheckoutHead(repository)).toBe(headBefore);
    });
});
