import { useEffect, useState } from 'react';

import type { Lang } from './lang.ts';
import { isAmbientSoundPlaying, startAmbientSound, stopAmbientSound } from './sound.ts';

export interface RelicPreferences {
    readonly lang: Lang;
    readonly ambientEnabled: boolean;
    readonly helpVisible: boolean;
    toggleLanguage(): void;
    toggleAmbient(): void;
    enableAmbient(): void;
    setHelpVisible(visible: boolean): void;
}

export function useRelicPreferences(authenticated: boolean): RelicPreferences {
    const [lang, setLang] = useState<Lang>(() => localStorage.getItem('relic-lang') === 'no' ? 'no' : 'en');
    const [ambientEnabled, setAmbientEnabled] = useState(false);
    const [helpVisible, setHelpVisible] = useState(false);
    useEffect(() => {
        if (!authenticated) {
            stopAmbientSound();
            setAmbientEnabled(false);
        }
        return () => stopAmbientSound();
    }, [authenticated]);
    const toggleLanguage = () => {
        const next = lang === 'en' ? 'no' : 'en';
        localStorage.setItem('relic-lang', next);
        setLang(next);
    };
    const toggleAmbient = () => {
        if (isAmbientSoundPlaying()) {
            stopAmbientSound();
            setAmbientEnabled(false);
        }
        else {
            setAmbientEnabled(startAmbientSound());
        }
    };
    return {
        lang,
        ambientEnabled,
        helpVisible,
        toggleLanguage,
        toggleAmbient,
        enableAmbient: () => {
            if (!isAmbientSoundPlaying()) {
                setAmbientEnabled(startAmbientSound());
            }
        },
        setHelpVisible
    };
}
