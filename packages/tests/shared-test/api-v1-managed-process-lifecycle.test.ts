import { describe, expect, it, vi } from 'vitest';

import { parseApiV1BlackBoxArgs, toApiV1ServerCommand } from '@shared-test/black-box-runner/api-v1-black-box-run.mts';
import { stopManagedApiServer } from '@shared-test/black-box-runner/managed-api/api-v1-managed-process-lifecycle.mts';

describe('managed API-v1 process lifecycle', () => {
    it('grants managed PGlite servers write permission for their private temporary roots', () => {
        const options = parseApiV1BlackBoxArgs(['--backend=pglite-memory']);

        expect(toApiV1ServerCommand(options)).toContain('--allow-write');
    });

    it('uses SIGTERM before SIGKILL when the injected child does not stop', async () => {
        vi.useFakeTimers();
        const signals: ('SIGTERM' | 'SIGKILL')[] = [];
        let resolveStatus!: (
            status: Readonly<{ success: boolean; code: number; signal: string | null; }>
        ) => void;
        const status = new Promise<Readonly<{ success: boolean; code: number; signal: string | null; }>>(
            (resolve) => {
                resolveStatus = resolve;
            }
        );

        const stopping = stopManagedApiServer({
            stdout: null,
            stderr: null,
            status,
            kill(signo): void {
                if (signo !== 'SIGTERM' && signo !== 'SIGKILL') {
                    throw new Error(`Unexpected managed API signal: ${String(signo)}`);
                }
                signals.push(signo);
                if (signo === 'SIGKILL') {
                    resolveStatus({ success: false, code: 137, signal: signo });
                }
            }
        });

        try {
            expect(signals).toEqual(['SIGTERM']);
            await vi.advanceTimersByTimeAsync(5000);
            await stopping;

            expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
        }
        finally {
            vi.useRealTimers();
        }
    });
});
