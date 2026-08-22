import { describe, expect, it } from 'vitest';
import { runnerDisabledReason, runnerFriendlyErrorMessage, runnerReadinessStatus } from '../../../apps/rallar-black-box/src/runner-readiness.ts';

describe('runner readiness', () => {
    it('allows local runs before distributed agents are connected', () => {
        const readiness = runnerReadinessStatus({
            apiStatus: 'online',
            authenticated: true,
            groupId: 'bb-group',
            controlStatus: 'offline',
            controlRunId: '',
            connectedAgentCount: 0,
            targetableAgentCount: 0
        });

        expect(readiness.canRunLocal).toBe(true);
        expect(readiness.canRunDistributed).toBe(false);
        expect(readiness.primaryMessage).toBe(
            'Ready to run in this browser. Distributed: Control server offline'
        );
        expect(runnerDisabledReason(readiness, 'local-browser')).toBeUndefined();
        expect(runnerDisabledReason(readiness, 'connected-agents')).toBe('Control server offline');
    });

    it('blocks local and distributed runs on auth, API, or recipe prerequisites', () => {
        const readiness = runnerReadinessStatus({
            apiStatus: 'offline',
            authenticated: false,
            groupId: '',
            controlStatus: 'online',
            controlRunId: 'run-1',
            connectedAgentCount: 2,
            targetableAgentCount: 2,
            recipePrerequisiteIssues: ['Recipe JSON is not bundled.']
        });

        expect(readiness.canRunLocal).toBe(false);
        expect(readiness.canRunDistributed).toBe(false);
        expect(readiness.localBlockers).toContain('API is offline');
        expect(readiness.localBlockers).toContain('Login required');
        expect(readiness.localBlockers).toContain('Current group missing');
        expect(readiness.localBlockers).toContain('Recipe JSON is not bundled.');
    });

    it('rewrites vague network errors into actionable service guidance', () => {
        expect(runnerFriendlyErrorMessage(new Error('Failed to fetch'))).toContain('Service is offline');
        expect(runnerFriendlyErrorMessage(new Error('401 Unauthorized'))).toContain('Log in again');
    });

    it('shows empty TURN/STUN as a warning without blocking recipe actions', () => {
        const readiness = runnerReadinessStatus({
            apiStatus: 'online',
            authenticated: true,
            groupId: 'bb-group',
            controlStatus: 'online',
            controlRunId: 'run-1',
            connectedAgentCount: 1,
            targetableAgentCount: 1,
            turnStatus: 'empty'
        });

        expect(readiness.canRunLocal).toBe(true);
        expect(readiness.canRunDistributed).toBe(true);
        expect(runnerDisabledReason(readiness, 'local-browser')).toBeUndefined();
        expect(runnerDisabledReason(readiness, 'connected-agents')).toBeUndefined();
        expect(readiness.checks).toContainEqual(expect.objectContaining({
            id: 'turn',
            status: 'warning',
            message: 'No TURN/STUN servers returned. Cross-region WebRTC may fail; configure Metered TURN.'
        }));
    });

    it('shows TURN endpoint failures as warnings without blocking recipe actions', () => {
        const readiness = runnerReadinessStatus({
            apiStatus: 'online',
            authenticated: true,
            groupId: 'bb-group',
            controlStatus: 'online',
            controlRunId: 'run-1',
            connectedAgentCount: 1,
            targetableAgentCount: 1,
            turnStatus: 'error',
            turnDetail: 'HTTP 502'
        });

        expect(readiness.canRunLocal).toBe(true);
        expect(readiness.canRunDistributed).toBe(true);
        expect(readiness.checks).toContainEqual(expect.objectContaining({
            id: 'turn',
            status: 'warning',
            message: 'TURN/STUN check failed: HTTP 502'
        }));
    });
});
