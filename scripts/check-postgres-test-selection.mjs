import {
    globSync,
    readFileSync,
    realpathSync
} from 'node:fs';
import {
    join,
    relative,
    resolve
} from 'node:path';

import { createVitest, parseCLI } from 'vitest/node';

async function main() {
    const arguments_ = process.argv.slice(2);
    if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== '--root')) {
        throw new Error('Usage: node scripts/check-postgres-test-selection.mjs [--root <repository>]');
    }
    const root = realpathSync(resolve(arguments_[1] ?? join(import.meta.dirname, '..')));
    const candidates = globSync('packages/tests/**/*.test.ts', { cwd: root }).filter((file) =>
        readFileSync(join(root, file), 'utf8').includes('RALLAR_POSTGRES_INTEGRATION')
    );
    const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const lanes = Object.entries(scripts).filter(([name]) => name.startsWith('test:postgres:'));
    if (lanes.length === 0 || candidates.length === 0) {
        throw new Error('PostgreSQL selection requires configured lanes and gated test files');
    }

    process.env.RALLAR_POSTGRES_INTEGRATION = '1';
    const selected = new Set();
    for (const [name, command] of lanes) {
        const { filter, options } = parsePostgresCommand(name, command);
        const context = await createVitest({ ...options, root, watch: false, run: true, reporters: [] });
        try {
            for (const specification of await context.getRelevantTestSpecifications(filter)) {
                selected.add(resolve(specification.moduleId));
            }
        }
        finally {
            await context.close();
        }
    }

    const unselected = candidates.filter((file) => !selected.has(resolve(root, file)));
    const { options } = parsePostgresCommand(...lanes[0]);
    const collectionOptions = {
        ...options,
        include: unselected,
        exclude: [],
        testNamePattern: /.*/
    };
    const enabled = unselected.length === 0 ? new Map() : await collectCases(root, collectionOptions);
    process.env.RALLAR_POSTGRES_INTEGRATION = '0';
    const disabled = unselected.length === 0 ? new Map() : await collectCases(root, collectionOptions);
    let missingCount = 0;
    for (const [key, enabledCase] of enabled) {
        const omittedCount = enabledCase.count - (disabled.get(key)?.count ?? 0);
        if (omittedCount > 0) {
            missingCount += omittedCount;
            console.error(`No PostgreSQL lane selects ${enabledCase.description} (${omittedCount} cases)`);
        }
    }
    console.log(
        `PostgreSQL selection: ${
            candidates.length - unselected.length
        } candidate files selected, ${missingCount} enabled cases omitted.`
    );
    if (missingCount > 0) {
        process.exitCode = 1;
    }
}

function parsePostgresCommand(name, command) {
    const start = command.indexOf('vitest run');
    if (start < 0 || !command.includes('RALLAR_POSTGRES_INTEGRATION=1') || /&&|[;\n]/.test(command)) {
        throw new Error(`${name} must directly invoke a PostgreSQL-enabled Vitest run for selection accounting`);
    }
    return parseCLI(command.slice(start));
}

async function collectCases(root, options) {
    const context = await createVitest({ ...options, root, watch: false, run: true, reporters: [] });
    try {
        // Static collection does not evaluate aliases, parameterized rows or environment gates.
        const { testModules, unhandledErrors } = await context.collect([], { staticParse: false });
        const errors = [...unhandledErrors];
        const cases = new Map();
        for (const module of testModules) {
            errors.push(...module.errors());
            for (const suite of module.children.allSuites()) {
                errors.push(...suite.errors());
            }
            for (const test of module.children.allTests()) {
                if (test.result().state === 'skipped') {
                    continue;
                }
                const file = relative(root, module.moduleId).replaceAll('\\', '/');
                const key = JSON.stringify([file, test.fullName]);
                cases.set(key, {
                    description: `${file} > ${test.fullName}`,
                    count: (cases.get(key)?.count ?? 0) + 1
                });
            }
        }
        if (errors.length > 0) {
            throw new Error(`PostgreSQL collection failed: ${errors.map((error) => error.message).join('; ')}`);
        }
        return cases;
    }
    finally {
        await context.close();
    }
}

try {
    await main();
}
catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
