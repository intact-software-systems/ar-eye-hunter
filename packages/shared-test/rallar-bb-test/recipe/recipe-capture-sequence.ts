import { parseRtcCaptureMode } from '@shared/webrtc/rtc-capture-configuration.ts';
import type { RtcSignalingDiagnostics } from '@shared/webrtc/rtc-signaling-diagnostics.ts';

import type { RallarBlackBoxTestConfig, RallarBlackBoxTestRecipe } from '../rallar-black-box-test-contracts.ts';

export namespace RecipeCaptureSequence {
    export interface Selection {
        readonly run: RtcSignalingDiagnostics.CaptureMode | undefined;
        readonly recipe: RtcSignalingDiagnostics.CaptureMode | undefined;
        readonly step: RtcSignalingDiagnostics.CaptureMode | undefined;
    }
}

/** Owns only the desired capture setting of one executable command sequence. */
export class RecipeCaptureSequence {
    private selection: RecipeCaptureSequence.Selection;

    constructor(selection: RecipeCaptureSequence.Selection) {
        this.selection = Object.freeze({ ...selection });
    }

    get(): RecipeCaptureSequence.Selection {
        return this.selection;
    }

    configure(config: RallarBlackBoxTestConfig): void {
        this.selection = Object.freeze({ ...this.selection, step: resolveConfiguredCaptureMode(config) });
    }

    fork(): RecipeCaptureSequence {
        return new RecipeCaptureSequence(this.selection);
    }

    forRecipe(
        recipe: RallarBlackBoxTestRecipe,
        run: RtcSignalingDiagnostics.CaptureMode | undefined
    ): RecipeCaptureSequence {
        return new RecipeCaptureSequence({
            run: this.selection.run ?? run,
            recipe: recipe.rtcCaptureMode ?? this.selection.recipe,
            step: this.selection.step
        });
    }
}

export function resolveConfiguredCaptureMode(
    config: RallarBlackBoxTestConfig | undefined
): RtcSignalingDiagnostics.CaptureMode | undefined {
    return parseRtcCaptureMode(config?.rallar?.rtcCaptureMode).fold(
        (issues) => {
            throw new TypeError(issues[0].message);
        },
        (parsed) => parsed.mode
    );
}
