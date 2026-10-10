#!/usr/bin/env node
import { appendFile, copyFile, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

// This executable is the native process boundary for the capture CLI tests.
// It supplies daemon/SQL facts and an original-byte archive, never image policy.
const fixturePath = process.env.RALLAR_CAPTURE_FIXTURE;
if (typeof fixturePath !== 'string') {
    throw new TypeError('native capture fixture path is required');
}
/** @type {unknown} */
const decoded = JSON.parse(await readFile(fixturePath, 'utf8'));
if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('native capture fixture must be an object');
}
const command = basename(process.argv[1]);
const argumentsInput = process.argv.slice(2);
if (command === 'docker') {
    await readDockerFixture({ fixture: decoded, argumentsInput });
}
else {
    const version = command === 'deno' ? 'deno 2.9.5\nv8 15.0\ntypescript 6.0' : command === 'npm' ? '11.20' : '';
    console.log(version);
}

async function readDockerFixture({ fixture, argumentsInput }) {
    if (argumentsInput[0] === 'image' && argumentsInput[1] === 'save') {
        const outputIndex = argumentsInput.indexOf('--output');
        const output = argumentsInput[outputIndex + 1];
        if (outputIndex < 0 || typeof output !== 'string') {
            throw new TypeError('image save must have a named output');
        }
        if (!('archive' in fixture) || !('exports' in fixture) || typeof fixture.archive !== 'string' || typeof fixture.exports !== 'string') {
            throw new TypeError('archive and export record paths must be strings');
        }
        await appendFile(fixture.exports, `${output}\n`);
        if ('exportFailure' in fixture && fixture.exportFailure === true) {
            throw new Error('native export failed');
        }
        await copyFile(fixture.archive, output);
        return;
    }
    const responseName = argumentsInput[0] === 'container'
        ? 'containerText'
        : argumentsInput[0] === 'image'
        ? 'imageText'
        : argumentsInput[0] === 'ps'
        ? 'containersText'
        : argumentsInput[0] === 'exec'
        ? 'sqlText'
        : 'versionText';
    if (!(responseName in fixture) || typeof fixture[responseName] !== 'string') {
        throw new TypeError(`native fixture ${responseName} must be text`);
    }
    const response = fixture[responseName];
    if (responseName === 'sqlText') {
        const sql = argumentsInput[argumentsInput.length - 1];
        console.log(sql.includes('pg_stat_user_tables') ? ('maintenance' in fixture ? String(fixture.maintenance) : '0') : response);
    }
    else {
        console.log(response);
    }
}
