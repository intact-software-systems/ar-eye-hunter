export function validateDistributedValidationResult(input) {
    const issues = [];
    if (input.selectionResult !== 'success') {
        issues.push(`selection result must be success, received ${input.selectionResult}`);
    }
    if (!['true', 'false'].includes(input.selected)) {
        issues.push(`selected must be true or false, received ${input.selected}`);
        return issues;
    }

    if (input.selected === 'false') {
        for (const [job, result] of downstreamResults(input)) {
            if (result !== 'skipped') {
                issues.push(`${job} result must be skipped when not selected, received ${result}`);
            }
        }
        return issues;
    }

    for (const [job, result] of downstreamResults(input)) {
        if (result !== 'success') {
            issues.push(`${job} result must be success when selected, received ${result}`);
        }
    }
    return issues;
}

function downstreamResults(input) {
    return [
        ['preflight', input.preflightResult],
        ['prepare', input.prepareResult],
        ['run', input.runResult]
    ];
}
