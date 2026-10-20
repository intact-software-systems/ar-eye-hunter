import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { runOwnedTestProcess } from './owned-test-process.ts';

const controller = path.resolve('scripts/hosted-rallar/controller');

it('replays all six validated diagnostic keys, including absence, without changing unrelated configuration', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-diagnostic-restore-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const apiFile = path.join(root, 'api.env');
    const configurationFile = path.join(root, 'restore.json');
    await writeFile(apiFile, 'PORT=8080\nDATABASE_URL=private-fixture\nRALLAR_TIMING_LOGS=1\nRALLAR_RTC_TOPOLOGY_DEGREE_LIMIT=4\n');
    const configuration = {
        RALLAR_TIMING_LOGS: { present: false, value: null, source: null },
        RALLAR_APP_INBOX_PHASE_TIMING: { present: true, value: 'false', source: 'environment' },
        RALLAR_RTC_TOPOLOGY_DEGREE_LIMIT: { present: false, value: null, source: null },
        RALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE: { present: true, value: '3', source: 'environment' },
        RALLAR_RTC_TOPOLOGY_MESH_MIN_SIZE: { present: false, value: null, source: null },
        RALLAR_RTC_TOPOLOGY_MESH_PARAM_K: { present: false, value: null, source: null }
    };
    await writeFile(configurationFile, JSON.stringify(configuration));
    const environment = {
        PATH: process.env.PATH,
        RALLAR_API_ENV_FILE: apiFile,
        RALLAR_API_RESTORE_CONFIGURATION: configurationFile,
        RALLAR_API_CAPTURE_OWNER: 'api-owned',
        RALLAR_ROLLOUT_SCRIPT_SELF_TEST: 'restore-api-diagnostics'
    };
    const result = await runOwnedTestProcess(context, {
        executable: 'bash',
        args: [path.join(controller, '08-rollout-controller.sh')],
        options: { env: environment }
    });
    expect(result.stdout).not.toContain('private-fixture');
    expect(await readFile(apiFile, 'utf8')).toBe(
        'PORT=8080\nDATABASE_URL=private-fixture\nRALLAR_APP_INBOX_PHASE_TIMING=false\nRALLAR_RTC_TOPOLOGY_TREE_MIN_SIZE=3\n'
    );
    await writeFile(configurationFile, JSON.stringify({ ...configuration, RALLAR_TIMING_LOGS: { present: true, value: 'bad', source: 'environment' } }));
    await expect(runOwnedTestProcess(context, { executable: 'bash', args: [path.join(controller, '08-rollout-controller.sh')], options: { env: environment } }))
        .rejects.toMatchObject({ code: 1 });
    expect(await readFile(apiFile, 'utf8')).not.toContain('bad');
});

it('serializes finish/deadline invocations and refuses foreign capture ownership at the real shell boundary', async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), 'rallar-capture-lock-'));
    context.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const bin = path.join(root, 'bin');
    const directory = path.join(root, 'api-owned');
    await mkdir(bin);
    await mkdir(directory);
    await writeFile(path.join(directory, 'configuration.json'), '{}');
    await writeFile(path.join(root, 'active'), 'api-owned');
    // macOS lacks util-linux flock; fcntl.flock exercises the same inherited-descriptor OS lock.
    const programs = {
        flock:
            '#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | (fcntl.LOCK_NB if "-n" in sys.argv else 0))\nexcept BlockingIOError: sys.exit(1)\n',
        readlink: '#!/usr/bin/env bash\nprintf "%s/controller.lock" "$RALLAR_API_CAPTURE_ROOT"\n',
        node: '#!/usr/bin/env bash\nprintf "begin\\n" >> "$RALLAR_API_CAPTURE_ROOT/effects"\nsleep 0.1\nprintf "end\\n" >> "$RALLAR_API_CAPTURE_ROOT/effects"\n'
    };
    for (const [name, source] of Object.entries(programs)) {
        await writeFile(path.join(bin, name), source);
        await chmod(path.join(bin, name), 0o755);
    }
    const environment = { PATH: `${bin}:${process.env.PATH}`, RALLAR_API_CAPTURE_ROOT: root };
    const wrapper = path.join(controller, 'rallar-api-cpu-capture.sh');
    await Promise.all([
        runOwnedTestProcess(context, { executable: 'bash', args: [wrapper, 'finish', directory], options: { env: environment } }),
        runOwnedTestProcess(context, { executable: 'bash', args: [wrapper, 'deadline', directory], options: { env: environment } })
    ]);
    expect(await readFile(path.join(root, 'effects'), 'utf8')).toBe('begin\nend\nbegin\nend\n');
    await writeFile(path.join(root, 'active'), 'api-someone-else');
    await expect(runOwnedTestProcess(context, { executable: 'bash', args: [wrapper, 'finish', directory], options: { env: environment } })).rejects
        .toMatchObject({ code: 1 });
    expect(await readFile(path.join(root, 'active'), 'utf8')).toBe('api-someone-else');
});
