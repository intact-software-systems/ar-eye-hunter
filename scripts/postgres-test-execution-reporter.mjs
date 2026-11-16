export default class PostgresTestExecutionReporter {
    onTestRunEnd(testModules) {
        const unexecuted = [];
        let count = 0;
        for (const module of testModules) {
            for (const test of module.children.allTests()) {
                count += 1;
                const { state } = test.result();
                if (state !== 'passed' && state !== 'failed') {
                    unexecuted.push(`${module.moduleId} > ${test.fullName} (${state})`);
                }
            }
        }
        console.log(`PostgreSQL execution: ${count} cases, ${unexecuted.length} unexecuted.`);
        if (count === 0 || unexecuted.length > 0) {
            throw new Error(`PostgreSQL execution is incomplete:\n${unexecuted.join('\n')}`);
        }
    }
}
