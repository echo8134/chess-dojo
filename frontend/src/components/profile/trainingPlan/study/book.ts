import { Course } from '@/database/course';
import { GameKey } from '@/database/game';
import {
    Directory,
    DirectoryItemTypes,
} from '@jackstenglein/chess-dojo-common/src/database/directory';

/** A game from a course, shown from the course's PGN until the student has a copy. */
export interface CanonicalItem {
    kind: 'canonical';
    key: string;
    name: string;
    pgn: string;
    orientation: 'white' | 'black';
    allowExport: boolean;
}

/** A game the student owns, opened and saved in place. */
export interface OwnItem {
    kind: 'own';
    key: string;
    name: string;
    game: GameKey;
}

export type StudyItem = CanonicalItem | OwnItem;

export interface StudyChapter {
    name: string;
    items: StudyItem[];
}

export interface StudyBook {
    title: string;
    chapters: StudyChapter[];
    /** Folder games that are not the student's own and so are left out. */
    skipped: number;
}

/**
 * Keys a course game by module id, which survives chapter reordering. A module
 * without an id falls back to its position, which does not.
 */
export function courseItemKey(
    course: Pick<Course, 'type' | 'id'>,
    moduleId: string | undefined,
    chapterIndex: number,
    moduleIndex: number,
    pgnIndex: number,
): string {
    const moduleKey = moduleId || `c${chapterIndex}-m${moduleIndex}`;
    return `course:${course.type}/${course.id}/${moduleKey}/${pgnIndex}`;
}

export function gameItemKey(game: GameKey): string {
    return `game:${game.cohort}/${game.id}`;
}

export function courseBook(course: Course): StudyBook {
    const chapters: StudyChapter[] = [];
    course.chapters?.forEach((chapter, chapterIndex) => {
        const items: StudyItem[] = [];
        chapter.modules.forEach((module, moduleIndex) => {
            const pgns = module.pgns?.filter((pgn) => pgn.trim() !== '') ?? [];
            pgns.forEach((pgn, pgnIndex) => {
                const base = module.name || chapter.name;
                items.push({
                    kind: 'canonical',
                    key: courseItemKey(course, module.id, chapterIndex, moduleIndex, pgnIndex),
                    name: pgns.length > 1 ? `${base} ${pgnIndex + 1}` : base,
                    pgn,
                    orientation: module.boardOrientation || 'white',
                    allowExport: course.allowExport ?? false,
                });
            });
        });
        if (items.length > 0) {
            chapters.push({ name: chapter.name, items });
        }
    });
    return { title: course.name, chapters, skipped: 0 };
}

export function directoryBook(directory: Directory, username: string): StudyBook {
    const items: StudyItem[] = [];
    let skipped = 0;
    for (const id of directory.itemIds) {
        const item = directory.items[id];
        if (!item || item.type === DirectoryItemTypes.DIRECTORY) {
            continue;
        }
        if (item.type !== DirectoryItemTypes.OWNED_GAME || item.metadata.owner !== username) {
            skipped += 1;
            continue;
        }
        const game = { cohort: item.metadata.cohort, id: item.metadata.id };
        items.push({
            kind: 'own',
            key: gameItemKey(game),
            name: `${item.metadata.white} vs ${item.metadata.black}`,
            game,
        });
    }
    return {
        title: directory.name,
        chapters: items.length > 0 ? [{ name: directory.name, items }] : [],
        skipped,
    };
}

export function itemsOf(book: StudyBook): StudyItem[] {
    return book.chapters.flatMap((chapter) => chapter.items);
}
