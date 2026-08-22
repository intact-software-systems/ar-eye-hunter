// deno-lint-ignore-file no-explicit-any
const SUCCESS = 'SUCCESS';
const FAILURE = 'FAILURE';

function toOutputReportFields(interaction: any): any {
    return {
        output: interaction.request.output,
        outputPath: interaction.request.outputPath,
        outputs: interaction.request.outputs,
        transform: interaction.request.transform,
        secret: interaction.request.secret,
        redact: interaction.request.redact,
        redactAs: interaction.request.redactAs
    };
}

function toCorrelationReportFields(interaction: any): any {
    const correlation = interaction?.request?.correlation;
    if (!correlation) {
        return {};
    }

    return {
        runnerRunId: correlation.runnerRunId,
        runnerStepId: correlation.runnerStepId,
        correlation
    };
}

export function toWsConnectionName(request: any): string {
    return request.connection || request.name || 'default';
}

export function toWsExpectedConnectionName(interaction: any): string {
    return interaction.response?.connection ||
        interaction.response?.onConnection ||
        interaction.request?.expectConnection ||
        toWsConnectionName(interaction.request);
}

export function toWsSuccessStatus(config: any, interaction: any, details: any = {}): any {
    return {
        name: config.interactionName,
        status: SUCCESS,
        transport: 'WS',
        ...toCorrelationReportFields(interaction),
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...toOutputReportFields(interaction),
        input: interaction.request.input
    };
}

export function toWsFailureStatus(
    config: any,
    interaction: any,
    result: string,
    details: any = {}
): any {
    return {
        name: config.interactionName,
        status: FAILURE,
        result,
        transport: 'WS',
        ...toCorrelationReportFields(interaction),
        action: interaction.request.action,
        connection: interaction.request.connection || interaction.response?.connection,
        path: interaction.request.path,
        timeoutMs: interaction.request.timeoutMs,
        scenarioExecutionNumber: config.interaction.request.scenarioExecutionNumber,
        interactionExecutionNumber: config.interaction.request.interactionExecutionNumber,
        repeatIndex: config.interaction.request.repeatIndex,
        expected: interaction.response,
        actual: details,
        ...config
    };
}
