import { describe, expect, it } from 'vitest';
import { resolveRallarBlackBoxBootstrapConfig } from '../../../apps/rallar-black-box/src/runtime-store.ts';

describe('rallar-black-box control bootstrap', () => {
    it('enables remote control mode from URL autoConnect params', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?controlUrl=ws://127.0.0.1:5180/control&runId=run-url&agentId=agent-url&autoConnect=1',
            {},
        );

        expect(bootstrap).toMatchObject({
            mode: 'control-agent',
            autoConnect: true,
            controlUrl: 'ws://127.0.0.1:5180/control',
            runId: 'run-url',
            agentId: 'agent-url',
            source: 'url',
        });
    });

    it('uses control mode as an auto-connect shorthand', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig(
            '?mode=control&agentId=agent-mode',
            {},
        );

        expect(bootstrap.mode).toBe('control-agent');
        expect(bootstrap.autoConnect).toBe(true);
        expect(bootstrap.agentId).toBe('agent-mode');
    });

    it('keeps local workbench defaults without URL or env config', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig('', {});

        expect(bootstrap).toMatchObject({
            mode: 'local-workbench',
            autoConnect: false,
            controlUrl: 'ws://localhost:5180/control',
            agentId: 'visible-agent-local',
            source: 'default',
        });
    });

    it('uses Vite environment values when URL params are absent', () => {
        const bootstrap = resolveRallarBlackBoxBootstrapConfig('', {
            VITE_RALLAR_CONTROL_URL: 'ws://control.example.test/control',
            VITE_RALLAR_AUTO_CONNECT: 'true',
            VITE_RALLAR_RUN_ID: 'run-env',
            VITE_RALLAR_AGENT_ID: 'agent-env',
        });

        expect(bootstrap).toMatchObject({
            mode: 'control-agent',
            autoConnect: true,
            controlUrl: 'ws://control.example.test/control',
            runId: 'run-env',
            agentId: 'agent-env',
            source: 'environment',
        });
    });
});
