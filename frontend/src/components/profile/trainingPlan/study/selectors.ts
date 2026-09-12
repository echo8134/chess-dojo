import { GameKey } from '@/database/game';
import { TimelineEntry } from '@/database/timeline';
import { StudyItem } from './book';

/**
 * Select the URL's item if it exists. Otherwise select the first item outside the completed
 * range that is owned or has no working copy. Fall back to the first item.
 */
export function chooseCurrent(
    items: StudyItem[],
    urlKey: string | null,
    copies: Map<string, GameKey>,
    passed = new Set<string>(),
): StudyItem | undefined {
    if (items.length === 0) {
        return undefined;
    }
    const fromUrl = urlKey ? items.find((item) => item.key === urlKey) : undefined;
    if (fromUrl) {
        return fromUrl;
    }
    return (
        items.find(
            (item) => !passed.has(item.key) && (item.kind === 'own' || !copies.has(item.key)),
        ) ?? items[0]
    );
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
