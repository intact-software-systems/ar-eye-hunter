import { describe, expect, it } from 'vitest';

import { toFullStackRtcBuildToolInputs } from '../../shared-test/black-box-runner/fixtures/rtc-production/read-full-stack-rtc-build-tool-inputs.ts';

const selected = {
    repoRoot: '/repository',
    compilerEntry: '/repository/node_modules/typescript/bin/tsc',
    compilerResolver: '/repository/node_modules/typescript/lib/getExePath.js',
    compilerNative: '/repository/node_modules/@typescript/typescript-linux-x64/lib/tsc',
    compilerNativePackage: '/repository/node_modules/@typescript/typescript-linux-x64/package.json',
    viteEntry: '/repository/node_modules/vite/dist/node/index.js',
    viteExecutable: '/repository/node_modules/vite/bin/vite.js',
    bundlerEntry: '/repository/node_modules/rolldown/dist/index.mjs',
    bundlerImports: ['/repository/node_modules/rolldown/dist/shared/binding-selected.mjs'],
    nativeBindings: ['/repository/node_modules/@rolldown/binding-linux-x64-gnu/rolldown-binding.linux-x64-gnu.node'],
    nativePackage: '/repository/node_modules/@rolldown/binding-linux-x64-gnu/package.json'
};

describe('installed RTC-B06 build-tool owners', () => {
    it('preserves actual selected compiler/bundler owner references without inferring another host platform', () => {
        const result = toFullStackRtcBuildToolInputs(selected);
        expect(result.ok ? result.value : result).toContain('node_modules/@rolldown/binding-linux-x64-gnu/rolldown-binding.linux-x64-gnu.node');
        expect(result.ok ? result.value : result).toContain('node_modules/@typescript/typescript-linux-x64/lib/tsc');
    });
    it.each(['override', 'missing-native', 'ambiguous-native', 'escaping-import'] as const)(
        'rejects an unsafe or unprovable selected backend: %s',
        (failure) => {
            const input = failure === 'override'
                ? { ...selected, nativeBindings: ['/private/override.node'] }
                : failure === 'missing-native'
                ? { ...selected, nativeBindings: [] }
                : failure === 'ambiguous-native'
                ? { ...selected, nativeBindings: [...selected.nativeBindings, '/repository/node_modules/@rolldown/binding-darwin-arm64/binding.node'] }
                : { ...selected, bundlerImports: ['/private/entry.mjs'] };
            expect(toFullStackRtcBuildToolInputs(input)).toMatchObject({ ok: false, issues: [{ code: 'unbound-build-tool-owner' }] });
        }
    );
});
