import type { RallarServerRestCollection, RallarServerWorkbenchVariables } from '../rallar-server-workbench.ts';

function stateCollectionPath(suffix: string): string {
    return '/api/state/apps/{{applicationId}}/workspaces/{{workspaceId}}' + suffix;
}

export function createRallarServerRestCollectionTemplates(
    variables: RallarServerWorkbenchVariables
): readonly RallarServerRestCollection[] {
    const baseVariables = {
        applicationId: variables.applicationId,
        workspaceId: variables.workspaceId,
        groupId: variables.groupId,
        principalId: variables.principalId,
        clientInstanceId: variables.clientInstanceId,
        sessionId: variables.sessionId,
        generationId: variables.generationId,
        requestId: variables.requestId,
        username: variables.username,
        missingGroupId: `${variables.groupId}-missing`,
        otherPrincipalId: `${variables.principalId}-not-self`
    };

    return [
        {
            collectionId: 'group-membership-evidence',
            name: 'Group membership evidence',
            description: 'Create/read/join a group and verify the latest group snapshot.',
            variables: baseVariables,
            steps: [
                {
                    stepId: 'create-group',
                    label: 'Create group',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            groupId: '{{groupId}}',
                            displayName: '{{groupId}}',
                            description: 'Created by rallar-black-box REST collection',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: '{{principalId}}'
                        }
                    },
                    expect: {
                        status: [200, 201, 409]
                    }
                },
                {
                    stepId: 'join-group',
                    label: 'Join group',
                    request: {
                        method: 'PUT',
                        path: stateCollectionPath(
                            '/groups/{{groupId}}/members/{{principalId}}' + '/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            status: 'active'
                        }
                    },
                    expect: {
                        status: [200, 201]
                    }
                },
                {
                    stepId: 'read-group',
                    label: 'Read group',
                    request: {
                        method: 'GET',
                        path: stateCollectionPath('/groups/{{groupId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: 200,
                        body: [
                            {
                                path: '$.group.groupId',
                                equals: '{{groupId}}'
                            }
                        ]
                    },
                    extract: [
                        {
                            name: 'observedGroupId',
                            path: '$.group.groupId'
                        }
                    ]
                }
            ]
        },
        {
            collectionId: 'group-lifecycle-stages',
            name: 'Group lifecycle stages',
            description: 'Drive a phased group through plan, connect and activate by hand, then pause and ' +
                'resume its transport, reading the stage and observed condition at each step.',
            variables: baseVariables,
            steps: [
                {
                    stepId: 'create-phased-group',
                    label: 'Create phased group',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            groupId: '{{groupId}}',
                            displayName: '{{groupId}}',
                            description: 'Created by rallar-black-box lifecycle collection',
                            kind: 'room',
                            joinMode: 'open',
                            createdByPrincipalId: '{{principalId}}',
                            // `manual` triggers throughout: the point of this
                            // collection is that an operator drives each
                            // boundary by hand, so nothing may auto-advance
                            // between the steps (product decision 8).
                            lifecyclePolicy: {
                                preset: 'managed',
                                establishment: {
                                    planTrigger: { kind: 'manual' },
                                    connectTrigger: { kind: 'manual' }
                                },
                                activation: { mode: 'manual' },
                                admission: { mode: 'open' }
                            }
                        }
                    },
                    expect: {
                        status: [200, 201, 409],
                        body: [
                            {
                                path: '$.group.lifecycleState',
                                equals: 'forming'
                            }
                        ]
                    }
                },
                {
                    stepId: 'plan-layout',
                    label: 'Plan layout',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/{{groupId}}/plan/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: [200, 201]
                    }
                },
                {
                    stepId: 'connect-layout',
                    label: 'Connect the planned layout',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/{{groupId}}/connect/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: [200, 201]
                    }
                },
                {
                    stepId: 'read-formation',
                    label: 'Read formation view',
                    request: {
                        method: 'GET',
                        path: stateCollectionPath('/groups/{{groupId}}/formation'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: 200
                    },
                    extract: [
                        {
                            name: 'observedLifecycleState',
                            path: '$.lifecycleState'
                        },
                        {
                            name: 'observedCondition',
                            path: '$.condition'
                        },
                        {
                            name: 'observedFormationEpoch',
                            path: '$.formationEpoch'
                        }
                    ]
                },
                {
                    stepId: 'pause-transport',
                    label: 'Pause transport',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/{{groupId}}/transport/pause/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: [200, 201],
                        body: [
                            {
                                // The valve is orthogonal to the stage
                                // (product decision 25): pausing must not move
                                // the group off the stage it reached.
                                path: '$.group.transportState',
                                equals: 'halted'
                            }
                        ]
                    }
                },
                {
                    stepId: 'resume-transport',
                    label: 'Resume transport',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath('/groups/{{groupId}}/transport/resume/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: {
                        status: [200, 201],
                        body: [
                            {
                                path: '$.group.transportState',
                                equals: 'flowing'
                            }
                        ]
                    }
                }
            ]
        },
        {
            collectionId: 'client-presence-lifecycle',
            name: 'Client presence lifecycle',
            description: 'Upsert client state, connect presence, and list client/group events.',
            variables: baseVariables,
            steps: [
                {
                    stepId: 'upsert-principal',
                    label: 'Upsert principal',
                    request: {
                        method: 'PUT',
                        path: stateCollectionPath('/clients/{{principalId}}/principal/requests/{{requestId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            username: '{{username}}',
                            displayName: '{{username}}',
                            status: 'active'
                        }
                    },
                    expect: { status: [200, 201] }
                },
                {
                    stepId: 'connect-client-session',
                    label: 'Connect client session',
                    request: {
                        method: 'PUT',
                        path: stateCollectionPath(
                            '/clients/{{principalId}}/instances/{{clientInstanceId}}' +
                                '/sessions/{{sessionId}}/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            generationId: '{{generationId}}',
                            presenceState: 'online',
                            transport: 'rtc',
                            connectionId: 'rallar-black-box'
                        }
                    },
                    expect: { status: [200, 201] }
                },
                {
                    stepId: 'heartbeat-client-session',
                    label: 'Heartbeat client session',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath(
                            '/clients/{{principalId}}/instances/{{clientInstanceId}}' +
                                '/sessions/{{sessionId}}/heartbeat/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            generationId: '{{generationId}}',
                            presenceState: 'online'
                        }
                    },
                    expect: { status: 200 }
                },
                {
                    stepId: 'connect-group-presence',
                    label: 'Connect group presence',
                    request: {
                        method: 'PUT',
                        path: stateCollectionPath(
                            '/groups/{{groupId}}/sessions/{{sessionId}}' + '/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            principalId: '{{principalId}}'
                        }
                    },
                    expect: { status: [200, 201] }
                },
                {
                    stepId: 'client-events-page',
                    label: 'List client events page',
                    request: {
                        method: 'GET',
                        path: stateCollectionPath('/clients/{{principalId}}/events/page'),
                        query: { limit: 20 },
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: { status: 200 }
                },
                {
                    stepId: 'disconnect-client-session',
                    label: 'Disconnect client session',
                    request: {
                        method: 'POST',
                        path: stateCollectionPath(
                            '/clients/{{principalId}}/instances/{{clientInstanceId}}' +
                                '/sessions/{{sessionId}}/disconnect/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            generationId: '{{generationId}}'
                        }
                    },
                    expect: { status: 200 }
                }
            ]
        },
        {
            collectionId: 'negative-auth-state-cases',
            name: 'Negative auth and state cases',
            description: 'Check missing auth, forbidden self-service, duplicate group, ' +
                'and missing group behavior.',
            variables: baseVariables,
            steps: [
                {
                    stepId: 'missing-auth-ws-ticket',
                    label: 'Missing auth WS ticket',
                    request: {
                        method: 'POST',
                        path: '/api/auth/ws-ticket/requests/{{requestId}}',
                        attachAuth: false,
                        responseBodyMode: 'json',
                        body: {}
                    },
                    expect: { status: 401 }
                },
                {
                    stepId: 'missing-auth-ice',
                    label: 'Missing auth ICE config',
                    request: {
                        method: 'GET',
                        path: '/api/webrtc/ice',
                        attachAuth: false,
                        responseBodyMode: 'json'
                    },
                    expect: { status: 401 }
                },
                {
                    stepId: 'forbidden-other-principal-join',
                    label: 'Forbidden other-principal join',
                    request: {
                        method: 'PUT',
                        path: stateCollectionPath(
                            '/groups/{{groupId}}/members/{{otherPrincipalId}}' + '/requests/{{requestId}}'
                        ),
                        attachAuth: true,
                        responseBodyMode: 'json',
                        body: {
                            status: 'active'
                        }
                    },
                    expect: { status: 403 }
                },
                {
                    stepId: 'missing-group-read',
                    label: 'Missing group read',
                    request: {
                        method: 'GET',
                        path: stateCollectionPath('/groups/{{missingGroupId}}'),
                        attachAuth: true,
                        responseBodyMode: 'json'
                    },
                    expect: { status: 404 }
                }
            ]
        }
    ];
}
