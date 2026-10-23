import type { RelicPublicSnapshot } from '@relic-hunters/mod.ts';

export function roomName(snapshot: RelicPublicSnapshot | undefined, roomId: string): string {
    return snapshot?.map.find((room) => room.id === roomId)?.name ?? roomId;
}

export type Lang = 'en' | 'no';

export interface UIStrings {
    readonly phaseLobby: string;
    readonly phasePlanning: string;
    readonly phaseReview: string;
    readonly phaseFinished: string;
    readonly phaseConnected: string;
    readonly phaseConnecting: string;
    readonly phaseSignedOut: string;
    readonly phaseBannerPlanning: string;
    readonly submitButton: string;
    readonly boundButton: string;
    readonly huntersSummoned: string;
    readonly keeperWatches: string;
    readonly keeperAwaits: string;
    readonly heedingTheCall: string;
    readonly bound: string;
    readonly heedTheCall: string;
    readonly readyConfirmed: string;
    readonly beginTheHunt: string;
    readonly objectiveLobby: string;
    readonly objectiveJoin: string;
    readonly objectiveEscaped: string;
    readonly objectiveDefeated: string;
    readonly objectiveAllLocked: string;
    readonly objectiveWon: string;
    readonly objectiveSilent: string;
    readonly timerLabel: string;
    readonly timerAutoSubmit: string;
    readonly setTimerTitle: string;
    readonly waitingForKeeper: string;
}

export const UI: Record<Lang, UIStrings> = {
    en: {
        phaseLobby: 'The Keeper gathers hunters',
        phasePlanning: 'The Keeper Commands',
        phaseReview: 'Plans revealed',
        phaseFinished: 'Expedition complete',
        phaseConnected: 'Choose a room',
        phaseConnecting: 'Opening the gate',
        phaseSignedOut: 'Sign in',
        phaseBannerPlanning: '⚔  The Hunt Begins!',
        submitButton: 'Submit Plan',
        boundButton: 'Bound — awaiting the others...',
        huntersSummoned: 'Hunters Summoned',
        keeperWatches: 'The Keeper watches from above.',
        keeperAwaits: 'The Keeper awaits more hunters…',
        heedingTheCall: 'heeding the call',
        bound: 'bound',
        heedTheCall: 'Heed the Call',
        readyConfirmed: '✓ Ready',
        beginTheHunt: 'Start',
        objectiveLobby: 'The Keeper watches. Gather hunters, then enter the castle.',
        objectiveJoin: 'Join the expedition to enter the ruin.',
        objectiveEscaped: 'You escaped. Watch whether the others can beat your score.',
        objectiveDefeated: 'You are down. The ruin keeps your relics.',
        objectiveAllLocked: 'All plans are locked. The ruin is about to answer.',
        objectiveWon: 'The highest score has claimed the Heart Relic.',
        objectiveSilent: 'The ruin has gone silent.',
        timerLabel: 'Time left',
        timerAutoSubmit: 'Time is up — submitting your plan…',
        setTimerTitle: 'Round Time Limit',
        waitingForKeeper: 'Waiting for the Keeper to begin the hunt…'
    },
    no: {
        phaseLobby: 'Vokteren samler jegere',
        phasePlanning: 'Vokternes Befaling',
        phaseReview: 'Planene avsløres',
        phaseFinished: 'Ekspedisjonen er over',
        phaseConnected: 'Velg et rom',
        phaseConnecting: 'Åpner porten',
        phaseSignedOut: 'Logg inn',
        phaseBannerPlanning: '⚔  Jakten begynner!',
        submitButton: 'Send plan',
        boundButton: 'Bundet — venter på de andre...',
        huntersSummoned: 'Jegere innkalt',
        keeperWatches: 'Vokteren ser fra oven.',
        keeperAwaits: 'Vokteren venter på flere jegere…',
        heedingTheCall: 'adlyder kallet',
        bound: 'bundet',
        heedTheCall: 'Adlyd kallet',
        readyConfirmed: '✓ Klar',
        beginTheHunt: 'Start',
        objectiveLobby: 'Vokteren ser på. Samle jegere, gå inn i slottet.',
        objectiveJoin: 'Bli med i ekspedisjonen for å entre ruinen.',
        objectiveEscaped: 'Du unnslapp. Se om de andre kan slå poengsummen din.',
        objectiveDefeated: 'Du er ute. Ruinen beholder relikvier.',
        objectiveAllLocked: 'Alle planer er låst. Ruinen er i ferd med å svare.',
        objectiveWon: 'Høyeste poengsum har krevd Hjerterelikkiet.',
        objectiveSilent: 'Ruinen har stilnet.',
        timerLabel: 'Tid igjen',
        timerAutoSubmit: 'Tiden er ute — sender inn planen din…',
        setTimerTitle: 'Tidsbegrensning per runde',
        waitingForKeeper: 'Venter på at Vokteren skal starte jakten…'
    }
};

export function plural(word: string, count: number): string {
    return count === 1 ? word : `${word}s`;
}

export function shortId(id: string): string {
    return id.length <= 8 ? id : id.slice(0, 8);
}

export function phaseLabel(value: string, lang: Lang): string {
    const u = UI[lang];
    switch (value) {
        case 'lobby':
            return u.phaseLobby;
        case 'planning':
            return u.phasePlanning;
        case 'review':
            return u.phaseReview;
        case 'finished':
            return u.phaseFinished;
        case 'connected':
            return u.phaseConnected;
        case 'connecting':
            return u.phaseConnecting;
        case 'signed-out':
            return u.phaseSignedOut;
        case 'authenticating':
            return 'Authenticating';
        case 'joining-room':
            return 'Joining room';
        case 'ready':
            return u.phaseConnected;
        case 'degraded':
            return 'Degraded';
        case 'error':
            return 'Connection error';
        default:
            return value;
    }
}
