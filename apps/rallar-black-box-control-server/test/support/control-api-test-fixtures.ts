export interface ReportEnvelopeInput {
    readonly runId: string;
    readonly agentId: string;
    readonly eventId: string;
    readonly marker: string;
    readonly padding?: string;
}

export function reportEnvelope(
    input: ReportEnvelopeInput
): Readonly<Record<string, object | string | number>> {
    return {
        kind: 'report',
        protocolVersion: 1,
        runId: input.runId,
        agentId: input.agentId,
        atEpochMs: Date.now(),
        eventId: input.eventId,
        payload: {
            kind: 'report',
            topic: 'rallar.bb.report.final',
            payload: {
                reportId: input.eventId,
                summary: { reason: input.marker },
                stats: { padding: input.padding ?? '' }
            }
        }
    };
}

export function distributedManifest() {
    return {
        schemaVersion: 1,
        distributedRunId: 'api-dist-1',
        controlRunId: 'api-control-run',
        group: {
            applicationId: 'rallar-server',
            workspaceId: 'default',
            groupId: 'bb-group'
        },
        recipes: [
            {
                recipeId: 'api-health',
                recipe: {
                    recipeId: 'api-health',
                    commands: [
                        {
                            kind: 'health',
                            commandId: 'api-health-command'
                        }
                    ]
                }
            }
        ],
        targetPolicy: {
            mode: 'selected-agents',
            agentIds: ['agent-a']
        },
        startMode: 'manual',
        ackTimeoutMs: 1_000
    };
}
