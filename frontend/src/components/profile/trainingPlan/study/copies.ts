import { GameInfo, GameKey, PgnHeaders } from '@/database/game';
import { CanonicalItem } from './book';

/** Names the study item a working copy was created from. */
export const STUDY_ITEM_HEADER = 'StudyItem';

/** A short hash of the owner's username, for tracing a copy back without a lookup. */
export const STUDY_STAMP_HEADER = 'StudyStamp';

/** Carries the course's export flag on the copy so the Share tab needs no course fetch. */
export const STUDY_EXPORT_HEADER = 'StudyExport';

export function isWorkingCopy(headers: PgnHeaders | undefined): boolean {
    return !!headers?.[STUDY_ITEM_HEADER];
}

export function exportAllowed(headers: PgnHeaders | undefined): boolean {
    return headers?.[STUDY_EXPORT_HEADER] !== 'false';
}

/** The first twelve hex digits of sha256(username). */
export async function studyStamp(username: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(username));
    return Array.from(new Uint8Array(digest).slice(0, 6))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
}

export function copyHeaders(item: CanonicalItem, stamp: string): Record<string, string> {
    return {
        [STUDY_ITEM_HEADER]: item.key,
        [STUDY_STAMP_HEADER]: stamp,
        [STUDY_EXPORT_HEADER]: item.allowExport ? 'true' : 'false',
    };
}

/** Maps each study item key to the student's copy of it, from their games list. */
export function findCopies(games: GameInfo[]): Map<string, GameKey> {
    const copies = new Map<string, GameKey>();
    for (const game of games) {
        const key = game.headers[STUDY_ITEM_HEADER];
        if (key && !copies.has(key)) {
            copies.set(key, { cohort: game.cohort, id: game.id });
        }
    }
    return copies;
}
