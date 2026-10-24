import { load } from 'js-yaml';
import {
    chmod,
    mkdtemp,
    readFile,
    rm,
    writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

import { validateJsonSchema } from '../../shared-test/rallar-bb-test/schema/json-schema-validation.ts';
import { runOwnedTestProcess } from './owned-test-process.ts';

interface ControllerWorkflowStep {
    readonly name: string;
    readonly if?: string;
    readonly run?: string;
}

it('streams a bounded redacted API log reader without writing to the controller', async (context) => {
    const repoRoot = path.resolve(__dirname, '../../..');
    const workflow = load(await readFile(path.join(repoRoot, '.github/workflows/deploy-hetzner-controller.yml'), 'utf8'));
    const schema = {
        type: 'object',
        required: ['jobs'],
        properties: {
            jobs: {
                type: 'object',
                required: ['deploy'],
                properties: {
                    deploy: {
                        type: 'object',
                        required: ['steps'],
                        properties: {
                            steps: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    required: ['name'],
                                    properties: {
                                        name: { type: 'string' },
                                        if: { type: 'string' },
                                        run: { type: 'string' }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    };
    expect(validateJsonSchema(schema, workflow).ok).toBe(true);
    const steps = (workflow as { jobs: { deploy: { steps: ControllerWorkflowStep[]; }; }; }).jobs.deploy.steps;
    const step = steps.find((candidate) => candidate.name === 'Read recent API logs');
    expect(step, 'Operators need diagnostics without a deployment.').toBeDefined();
    if (!step || typeof step.run !== 'string') {
        throw new Error('Missing executable log action');
    }
    expect(step.if).toBe('inputs.action == \'logs\'');
    const fixture = await mkdtemp(path.join(tmpdir(), 'rallar-log-workflow-'));
    context.onTestFinished(() => rm(fixture, { recursive: true, force: true }));
    await writeFile(path.join(fixture, 'git'), '#!/usr/bin/env bash\nprintf "%040d" 0\n');
    await writeFile(
        path.join(fixture, 'ssh'),
        `#!/usr/bin/env bash
set -euo pipefail
[[ "$4" == 'bash -s -- --services api --lines 500 --since "30 min ago" --no-color' ]]
exec bash -s -- --services api --lines 500 --since '30 min ago' --no-color
`
    );
    await writeFile(
        path.join(fixture, 'journalctl'),
        `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == '--no-pager -o json -u rallar-api-v1.service -n 500 --since 30 min ago' ]]
printf '%s\n' '{"MESSAGE":"AppInbox failed Bearer private-token token=private-query","_SYSTEMD_UNIT":"rallar-api-v1.service","__REALTIME_TIMESTAMP":"1000000"}'
`
    );
    for (const executable of ['git', 'ssh', 'journalctl']) {
        await chmod(path.join(fixture, executable), 0o755);
    }
    const result = await runOwnedTestProcess(context, {
        executable: 'bash',
        args: ['-c', step.run],
        options: {
            cwd: repoRoot,
            env: { PATH: `${fixture}:${process.env.PATH}`, RALLAR_REPO_REF: '0'.repeat(40), HETZNER_USER: 'fixture', HETZNER_HOST: 'fixture.invalid' }
        }
    });
    expect(result.stdout).toContain('AppInbox failed Bearer [REDACTED] token=[REDACTED]');
    expect(result.stdout).not.toContain('private-');
});
