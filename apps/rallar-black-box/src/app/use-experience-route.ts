import { useEffect, useState } from 'react';
import {
    resolveAppExperience,
    type AppExperience,
} from './experience-route.ts';

function readExperience(): AppExperience {
    return resolveAppExperience(
        typeof window === 'undefined' ? '' : window.location.search,
    );
}

export function useExperienceRoute(): AppExperience {
    const [experience, setExperience] = useState(readExperience);

    useEffect(() => {
        const handlePopState = (): void => setExperience(readExperience());
        window.addEventListener('popstate', handlePopState);
        return () => window.removeEventListener('popstate', handlePopState);
    }, []);

    return experience;
}
