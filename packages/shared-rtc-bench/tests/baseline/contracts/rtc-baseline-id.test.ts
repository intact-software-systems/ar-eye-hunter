import { describe, expect, it } from 'vitest';

import { parseRtcBaselineCommand } from '../../../baseline/command/rtc-baseline-cli-grammar.ts';
import { createRtcBaselineLocalObservationId, createRtcBaselineObservationId, createRtcBaselineRepeatId } from '../../../baseline/contracts/rtc-baseline-id.ts';
import { validateRtcBaselineId } from '../../../baseline/contracts/rtc-baseline-validation.ts';

const observationId = '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2';
const localObservationId = '20260830T081500417Z-eaf526518c70-e3-memory-local';

describe('RTC baseline identity', () => {
    it('creates the canonical identity from exact observation provenance', () => {
        expect(
            createRtcBaselineObservationId({
                startedAt: '2026-08-27T03:15:00.417Z',
                sourceCommit: 'eaf526518c70e3b396dad91c008125a622b38b00',
                environmentId: 'E2-browser',
                githubRunId: 123456789,
                githubRunAttempt: 2
            })
        ).toEqual({ ok: true, value: observationId });
    });

    it('creates only the controlled repeat identity from a primary observation', () => {
        expect(createRtcBaselineRepeatId(observationId)).toEqual({
            ok: true,
            value: `${observationId}-repeat-01`
        });
        expect(createRtcBaselineRepeatId(`${observationId}-repeat-01`)).toMatchObject({ ok: false });
    });

    it('creates a timestamped local identity that can be retried without falsifying provenance', () => {
        expect(
            createRtcBaselineLocalObservationId({
                startedAt: '2026-08-30T08:15:00.417Z',
                sourceCommit: 'eaf526518c70e3b396dad91c008125a622b38b00',
                environmentId: 'E3-memory'
            })
        ).toEqual({ ok: true, value: localObservationId });
        expect(validateRtcBaselineId(localObservationId)).toEqual([]);
        expect(createRtcBaselineRepeatId(localObservationId)).toEqual({
            ok: true,
            value: `${localObservationId}-repeat-01`
        });
    });

    it.each([
        [
            { startedAt: '2026-08-27T03:15:00Z' },
            '$.startedAt',
            'invalid-started-at'
        ],
        [
            { sourceCommit: 'eaf526518c70' },
            '$.sourceCommit',
            'invalid-source-commit'
        ],
        [{ githubRunId: 0 }, '$.githubRunId', 'invalid-run-id'],
        [{ githubRunAttempt: 0 }, '$.githubRunAttempt', 'invalid-run-attempt']
    ])('rejects invalid observation provenance %o', (override, path, code) => {
        const result = createRtcBaselineObservationId({
            startedAt: '2026-08-27T03:15:00.417Z',
            sourceCommit: 'eaf526518c70e3b396dad91c008125a622b38b00',
            environmentId: 'E2-browser',
            githubRunId: 123456789,
            githubRunAttempt: 2,
            ...override
        });

        expect(result).toEqual({
            ok: false,
            issues: [expect.objectContaining({ path, code })]
        });
    });

    it('accepts one timestamped GitHub observation identity across validation and command parsing', () => {
        expect(validateRtcBaselineId(observationId)).toEqual([]);
        expect(
            parseRtcBaselineCommand([
                'initialize',
                `--baseline-id=${observationId}`,
                '--workloads=RTC-B05',
                '--environment=E2-browser'
            ])
        ).toEqual({
            ok: true,
            value: {
                kind: 'initialize',
                baselineId: observationId,
                workloadIds: ['RTC-B05'],
                environmentId: 'E2-browser',
                retainedSampleMultiplier: 1,
                repeatOf: null,
                conditionalEnvironmentDecision: null
            }
        });
    });

    it('accepts one timestamped local observation identity across command parsing', () => {
        expect(
            parseRtcBaselineCommand([
                'initialize',
                `--baseline-id=${localObservationId}`,
                '--workloads=RTC-B06',
                '--environment=E3-memory'
            ])
        ).toMatchObject({
            ok: true,
            value: {
                baselineId: localObservationId,
                workloadIds: ['RTC-B06'],
                environmentId: 'E3-memory'
            }
        });
    });

    it.each([
        '20260827T031500-eaf526518c70-e2-browser-gh123456789-a2',
        '20260230T031500Z-eaf526518c70-e2-browser-gh123456789-a2',
        '20260827T031500Z-eaf526518c70-e2-browser-gh0-a2',
        '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a0',
        '20260827T031500Z-eaf526518c70-e2-browser-gh123456789-a2-repeat-02',
        '20260830T081500417-eaf526518c70-e3-memory-local',
        '20260230T081500417Z-eaf526518c70-e3-memory-local',
        '20260830T081500417Z-eaf526518c70-e2-browser-local',
        '20260830T081500417Z-eaf526518c70-e3-memory-local-repeat-02'
    ])('rejects malformed stream identity %s', (invalidObservationId) => {
        expect(validateRtcBaselineId(invalidObservationId)).toEqual([
            {
                path: '$.baselineId',
                code: 'invalid-baseline-id',
                message: 'Baseline ID does not match the canonical grammar.'
            }
        ]);
    });
});
