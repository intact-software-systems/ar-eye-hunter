import type { TownPersonalityKind } from './state.ts';

export const PERSONALITY_PROPS: Readonly<Record<TownPersonalityKind, string>> = {
    silence:
        '<path fill="#55565b" stroke="#373b36" stroke-width="9" d="M30 240V25H220V240M40 48H210"/><path fill="#c8a44e" stroke="#554c34" stroke-width="7" d="M90 55H163L181 160H70z"/><circle fill="#6b5438" cx="125" cy="173" r="15"/><path stroke="#b79c73" stroke-width="6" d="M128 180V245"/>',
    gardener:
        '<path fill="#a07353" stroke="#514d3b" stroke-width="7" d="M18 172H107L95 241H32zM145 172H234L220 241H157z"/><path stroke="#5e7650" stroke-width="11" d="M61 180V59m129 121V58M61 140l-30-25m159 25 30-25"/><g fill="#c4a2a3" stroke="#665a56" stroke-width="5"><circle cx="60" cy="54" r="32"/><circle cx="190" cy="54" r="32"/></g><g fill="#d7bd65"><circle cx="60" cy="54" r="12"/><circle cx="190" cy="54" r="12"/></g>',
    queue:
        '<path fill="#635e54" d="M15 41H38V240H15zM218 41H241V240H218z"/><path fill="#ad6657" stroke="#564e41" stroke-width="6" d="M22 75H234V127H22z"/><path stroke="#e6d6a6" stroke-width="12" d="M40 82l30 37m26-37 30 37m26-37 30 37"/>',
    cleaner:
        '<path fill="none" stroke="#514e46" stroke-width="16" d="M97 134Q12 102 36 28L78 43"/><path fill="#9c7d50" stroke="#494b3f" stroke-width="8" d="M62 112H211L229 209H45z"/><path fill="#53554c" d="M80 134H190V151H80z"/><circle cx="78" cy="218" r="21" fill="#42463e"/><circle cx="202" cy="218" r="21" fill="#42463e"/><path stroke="#ddc597" stroke-width="8" d="M113 175H173"/>',
    mayor:
        '<path fill="#a4a396" stroke="#565c52" stroke-width="8" d="M50 245V182H205V245zM89 180L97 109H156L171 180z"/><ellipse cx="128" cy="67" rx="45" ry="52" fill="#b7b6a9" stroke="#565c52" stroke-width="8"/><path stroke="#565c52" stroke-width="8" d="M100 53l18 7m17 0 18-7M110 97H148"/>',
    washer:
        '<path stroke="#5c5b48" stroke-width="10" d="M12 250V25m232 225V25M12 43H244"/><path fill="#c5b9a4" stroke="#625e50" stroke-width="5" d="M37 46H99V162H37z"/><path fill="#a0ac93" stroke="#625e50" stroke-width="5" d="M133 46H214V148L185 148V95H165V148H133z"/><path fill="#b89a89" d="M68 176H150V225H68z"/>',
    watcher:
        '<path fill="#c8b056" stroke="#645940" stroke-width="7" d="M36 151Q43 99 119 116L140 86Q196 70 218 116L238 132L207 147Q191 218 97 213Q31 211 36 151z"/><circle fill="#343e38" cx="188" cy="111" r="8"/>',
    inspector:
        '<path fill="#846951" stroke="#494d3f" stroke-width="8" d="M32 136H225V166H32zM57 165V244m142-79V244"/><ellipse cx="125" cy="133" rx="81" ry="15" fill="#dbd2b3"/><path fill="#778c51" stroke="#55623b" stroke-width="5" d="M67 123L98 64L119 123M133 123L162 65L188 123"/><path fill="#b8b677" d="M85 90l11-19 9 29m44-10 12-18 11 24"/>'
};
export const PERSONALITY_LABELS: Readonly<Record<TownPersonalityKind, string>> = {
    silence: 'NO NOISE',
    gardener: 'DO NOT SNEEZE',
    queue: 'QUEUE HERE',
    cleaner: 'SPOTLESS!',
    mayor: 'BE SERIOUS',
    washer: 'KEEP DRY',
    watcher: 'NO SQUEAKS',
    inspector: 'FREE SAMPLES'
};
export const PERSONALITY_REMARKS: Readonly<Record<TownPersonalityKind, string>> = {
    silence: 'BE QUIET!!!',
    gardener: 'MY WIG!',
    queue: 'BACK OF THE LINE!',
    cleaner: 'BUUURP!',
    mayor: 'SHOW SOME RESPECT!',
    washer: 'YOU NEED A WASH!',
    watcher: 'GIVE THAT BACK!',
    inspector: 'JUST ONE MORE...'
};
export const PERSONALITY_ITEMS: Readonly<Record<TownPersonalityKind, string>> = {
    silence:
        '<path fill="#a4957a" stroke="#575d4d" stroke-width="8" d="M38 75H217V208H38z"/><path stroke="#575d4d" stroke-width="7" d="M42 81l172 120m0-120L42 201"/>',
    gardener:
        '<path fill="#d3b893" stroke="#665545" stroke-width="8" d="M35 197Q5 78 95 46Q193 7 226 164L198 197L170 139L139 170L102 131L73 191z"/>',
    queue:
        '<path fill="#d8c292" stroke="#695b40" stroke-width="8" d="M51 51H205V205H51z"/><text x="128" y="165" text-anchor="middle" font-size="110" fill="#4b5042">1</text>',
    cleaner:
        '<path fill="#9eac63" fill-opacity=".8" d="M25 159Q-4 81 65 81Q56 6 131 35Q218 1 215 87Q281 133 213 173Q194 255 128 215Q33 258 25 159z"/><path fill="none" stroke="#6f824e" stroke-width="9" d="M66 126q25-27 43 2m21 33q42 9 41-32"/>',
    mayor:
        '<path fill="#bb817a" stroke="#784f4b" stroke-width="5" d="M116 106Q158 87 183 141Q191 191 141 174z"/><path stroke="#51483e" stroke-width="15" d="M70 89l53 20m14 0 48-20"/>',
    washer:
        '<path stroke="#80684c" stroke-width="15" d="M173 10L89 205"/><path fill="#c5b16f" stroke="#675d42" stroke-width="7" d="M58 158L136 190L111 245L20 209z"/>',
    watcher: '<path fill="#6b634e" stroke="#3b4339" stroke-width="7" d="M26 179L78 150L92 59H172L190 150L238 179z"/>',
    inspector:
        '<path fill="#9aa981" stroke="#59624b" stroke-width="8" d="M60 90H196L182 224H75z"/><path fill="none" stroke="#59624b" stroke-width="10" d="M64 114Q128-19 193 114"/>'
};

export const PERSONALITY_REACTION_ITEMS: Readonly<Partial<Record<TownPersonalityKind, string>>> = {
    silence:
        '<path fill="#d6c7a2" stroke="#5c5c47" stroke-width="8" d="M29 103H95L216 36V220L95 154H29z"/><path fill="#776d56" d="M56 154H92L108 228H65z"/><path fill="none" stroke="#b18d50" stroke-width="8" d="M230 46l22-18m-22 100h25m-25 81 22 18"/>',
    washer:
        '<path fill="#b8b18e" stroke="#5b604b" stroke-width="8" d="M35 30H222V92L202 240H133L127 111L117 240H48L34 92z"/><path stroke="#747b5b" stroke-width="10" d="M45 67H211"/>'
};
