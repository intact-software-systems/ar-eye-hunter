import { describe, expect, it } from 'vitest';
import { parseLegacyRunsUrlSelection } from '../../../apps/rallar-black-box/src/legacy/runner/runs/legacy-run-url-selection.ts';
import { createLegacyMonitorHref } from '../../../apps/rallar-black-box/src/recipe-console/monitor/legacy-monitor-link.ts';

describe('legacy Runs URL selection', () => {
    it('reads the exact run context emitted by the Recipe Console Monitor link', () => {
        const href = createLegacyMonitorHref({
            v: 1,
            experience: 'recipe-console',
            view: 'monitor',
            controlRunId: ' control-requested ',
            distributedRunId: ' distributed-requested '
        }, '?provider=simulated');

        expect(parseLegacyRunsUrlSelection(new URL(href, 'https://console.test').search))
            .toEqual({
                controlRunId: 'control-requested',
                distributedRunId: 'distributed-requested'
            });
    });

    it('preserves the pre-v1 legacy Runs deep-link contract', () => {
        expect(parseLegacyRunsUrlSelection(
            '?workspace=black-box-runner&tab=runs' +
                '&controlRunId=control-old&distributedRunId=distributed-old'
        )).toEqual({
            controlRunId: 'control-old',
            distributedRunId: 'distributed-old'
        });
    });

    it('ignores run IDs outside legacy Runs and incomplete run pairs', () => {
        expect(parseLegacyRunsUrlSelection(
            '?v=1&experience=recipe-console&view=monitor' +
                '&controlRunId=control-a&distributedRunId=distributed-a'
        )).toBeUndefined();
        expect(parseLegacyRunsUrlSelection(
            '?experience=legacy&workspace=black-box-runner&tab=recipes' +
                '&controlRunId=control-a&distributedRunId=distributed-a'
        )).toBeUndefined();
        expect(parseLegacyRunsUrlSelection(
            '?experience=legacy&workspace=black-box-runner&tab=runs' +
                '&distributedRunId=distributed-a'
        )).toBeUndefined();
    });
});
