import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const deployScriptPath = path.resolve(__dirname, '../../../scripts/hosted-rallar/controller/02-deploy-controller.sh');

/** The hosted controller's memory and event-loop budget rest on these deploy defaults (see the controller README). */
describe('hosted control server deploy env', () => {
    it('keeps five runs and writes the snapshot at most every ten seconds', async () => {
        const script = await readFile(deployScriptPath, 'utf8');
        const controlEnv = script.slice(script.indexOf('cat >/etc/rallar/control-server.env'));

        expect(script).toContain('RALLAR_RETENTION_MAX_RUNS="${RALLAR_RETENTION_MAX_RUNS:-5}"');
        expect(controlEnv).toContain('RALLAR_BLACK_BOX_RETENTION_MAX_RUNS=${RALLAR_RETENTION_MAX_RUNS}\n');
        expect(controlEnv).toContain('RALLAR_BLACK_BOX_SNAPSHOT_FLUSH_INTERVAL_MS=10000\n');
    });
});
