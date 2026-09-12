import { GameKey } from '@/database/game';
import { TimelineEntry } from '@/database/timeline';
import { StudyItem } from './book';

/** The URL's item if it exists, else the first item the student has not started, else the first. */
export function chooseCurrent(
    items: StudyItem[],
    urlKey: string | null,
    copies: Map<string, GameKey>,
): StudyItem | undefined {
    if (items.length === 0) {
        return undefined;
    }
    const fromUrl = urlKey ? items.find((item) => item.key === urlKey) : undefined;
    if (fromUrl) {
        return fromUrl;
    }
    return items.find((item) => item.kind === 'own' || !copies.has(item.key)) ?? items[0];
}

/** The item keys marked done for this task, from the student's timeline. */
export function doneKeys(entries: TimelineEntry[], taskId: string): Set<string> {
    const keys = new Set<string>();
    for (const entry of entries) {
        if (entry.requirementId === taskId && entry.studyInfo?.itemKey) {
            keys.add(entry.studyInfo.itemKey);
        }
    }
    return keys;
}
