import {describe, expect, it} from 'vitest';
import {executeBlackBox} from '../../shared-test/black-box-runner/execute-black-box.ts';

describe('executeBlackBox', () => {
    it('supports SET output and placeholder resolution', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'auth',
                            value: {
                                body: {
                                    token_type: 'Bearer',
                                    access_token: 'abc-123',
                                },
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setAuth: {},
                },
                {
                    SET: {
                        request: {
                            output: 'authHeader',
                            value: '{auth.body.token_type} {auth.body.access_token}',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    deriveAuthHeader: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authHeader).toBe('Bearer abc-123');
    });

    it('supports exact object placeholder values', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'auth',
                            value: {
                                body: {
                                    access_token: 'abc-123',
                                    token_type: 'Bearer',
                                },
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setAuth: {},
                },
                {
                    SET: {
                        request: {
                            output: 'authBody',
                            value: '{auth.body}',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    deriveAuthBody: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.authBody).toEqual({
            access_token: 'abc-123',
            token_type: 'Bearer',
        });
    });

    it('supports ASSERT success with compatible comparison', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'user',
                            value: {
                                id: 123,
                                name: 'Alice',
                                traceId: 'dynamic-value',
                            },
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    setUser: {},
                },
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {
                            actual: '{user}',
                            body: {
                                id: 'integer',
                                name: 'string',
                            },
                        },
                    },
                    assertUserShape: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.resultsByName.assertUserShape[0].status).toBe('SUCCESS');
    });

    it('reports ASSERT failure', async () => {
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            actual: {
                                id: 'not-an-integer',
                            },
                            body: {
                                id: 'integer',
                            },
                        },
                    },
                    assertUserShape: {},
                },
            ],
            0,
            {
                failFast: true,
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.summary.firstFailure.name).toBe('assertUserShape');
        expect(report.resultsByName.assertUserShape[0].status).toBe('FAILURE');
    });

    it('supports failFast false', async () => {
        const report = await executeBlackBox(
            [
                {
                    ASSERT: {
                        request: {
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {
                            actual: {
                                id: 'not-an-integer',
                            },
                            body: {
                                id: 'integer',
                            },
                        },
                    },
                    firstAssertFails: {},
                },
                {
                    SET: {
                        request: {
                            output: 'afterFailure',
                            value: 'still-runs',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 2,
                        },
                        response: {},
                    },
                    setAfterFailure: {},
                },
            ],
            0,
            {
                failFast: false,
            },
        );

        expect(report.summary.failure).toBe(1);
        expect(report.summary.success).toBe(1);
        expect(report.outputs.afterFailure).toBe('still-runs');
    });

    it('supports variables in placeholders', async () => {
        const report = await executeBlackBox(
            [
                {
                    SET: {
                        request: {
                            output: 'url',
                            value: '{variables.baseUrl}/users',
                            scenarioExecutionNumber: 1,
                            interactionExecutionNumber: 1,
                        },
                        response: {},
                    },
                    deriveUrl: {},
                },
            ],
            0,
            {
                variables: {
                    baseUrl: 'http://localhost:8080',
                },
            },
        );

        expect(report.summary.failure).toBe(0);
        expect(report.outputs.url).toBe('http://localhost:8080/users');
    });
});
