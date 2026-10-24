import { GameKey } from '@/database/game';
import {
    CustomTask,
    getCurrentScore,
    isRequirement,
    Requirement,
    RequirementProgress,
} from '@/database/requirement';
import { TimelineEntry, TimelineStudyInfo, TimelineStudyItem } from '@/database/timeline';
import { ALL_COHORTS, compareCohorts, dojoCohorts, User } from '@/database/user';
import { DateTime } from 'luxon';
import { StudyItem } from './book';

/** Select the task's cohort using the same rules as the task dialog. */
export function taskCohort(task: Requirement | CustomTask, user: User): string {
    const options = task.counts[ALL_COHORTS] ? dojoCohorts : Object.keys(task.counts);
    if (options.includes(user.dojoCohort)) {
        return user.dojoCohort;
    }
    return [...options].sort(compareCohorts)[0] ?? user.dojoCohort;
}

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

/** Substitute the cohort's target count into the task name. */
export function taskTitle(task: Requirement | CustomTask, cohort: string): string {
    const count = task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0;
    return task.name.replaceAll('{{count}}', String(count));
}

/** Remove a trailing "s" for labels such as "exercise 421". Assumes regular English plurals. */
export function singularUnit(unit: string): string {
    return unit.endsWith('s') ? unit.slice(0, -1) : unit;
}

/** The item keys marked done for this task, from the student's timeline. */
export function doneKeys(entries: TimelineEntry[], taskId: string): Set<string> {
    const keys = new Set<string>();
    for (const entry of entries) {
        if (entry.requirementId !== taskId) continue;
        for (const item of entry.studyInfo?.items ?? []) {
            keys.add(item.key);
        }
    }
    return keys;
}

/** A progress entry with at least one item the study page marked in it. */
export type StudyEntry = TimelineEntry & { studyInfo: TimelineStudyInfo };

export function isStudyEntry(entry: TimelineEntry): entry is StudyEntry {
    return (entry.studyInfo?.items?.length ?? 0) > 0;
}

/**
 * The entry a mark today grows. It is the latest created of this task's entries with items,
 * dated on the same local calendar day as now. The list's order does not count. The server sorts
 * a day's entries by id, which is random within the day.
 */
export function dayEntry(
    entries: TimelineEntry[],
    taskId: string,
    now: DateTime,
): StudyEntry | undefined {
    let latest: StudyEntry | undefined;
    for (const entry of entries) {
        if (
            entry.requirementId === taskId &&
            isStudyEntry(entry) &&
            DateTime.fromISO(entry.date || entry.createdAt).hasSame(now, 'day') &&
            (!latest || entry.createdAt > latest.createdAt)
        ) {
            latest = entry;
        }
    }
    return latest;
}

/** The key the task's count lives under, as getCurrentCount and the progress handler read it. */
function countKey(task: Requirement | CustomTask, cohort: string): string {
    return task.numberOfCohorts === 0 || task.numberOfCohorts === 1 ? ALL_COHORTS : cohort;
}

export interface DayEdit {
    entry: TimelineEntry;
    progress: RequirementProgress;
}

/**
 * The day's entry and the task's progress after its items change. Points follow the server's
 * rule, the score at the new count less the score at the entry's previous count. A custom task
 * scores nothing. An entry with no items left is time only and drops its study info.
 */
export function editDayEntry(
    entry: TimelineEntry,
    change: {
        items: TimelineStudyItem[];
        newCount: number;
        /** The minutes the change adds to the entry and to the progress. */
        minutes: number;
        task: Requirement | CustomTask;
        cohort: string;
        progress: RequirementProgress | undefined;
        /** When the change happened, RFC 3339. */
        at: string;
    },
): DayEdit {
    const { items, newCount, minutes, task, cohort, at } = change;
    const key = countKey(task, cohort);
    const base: RequirementProgress = {
        requirementId: task.id,
        minutesSpent: {},
        updatedAt: '',
        ...change.progress,
    };
    const score = (count: number) =>
        isRequirement(task)
            ? getCurrentScore(cohort, task, { ...base, counts: { ...base.counts, [key]: count } })
            : 0;
    const edited: TimelineEntry = {
        ...entry,
        newCount,
        dojoPoints: score(newCount) - score(entry.previousCount),
        totalDojoPoints: score(newCount),
        minutesSpent: entry.minutesSpent + minutes,
        totalMinutesSpent: entry.totalMinutesSpent + minutes,
        studyInfo: { items },
    };
    if (items.length === 0) delete edited.studyInfo;
    return {
        entry: edited,
        progress: {
            ...base,
            counts: { ...base.counts, [key]: newCount },
            minutesSpent: {
                ...base.minutesSpent,
                [cohort]: (base.minutesSpent[cohort] ?? 0) + minutes,
            },
            updatedAt: at,
        },
    };
}

/**
 * A task read in order, with one count carried across cohorts and either a start above zero or
 * a target that differs by cohort. Custom tasks are never workbooks, and neither is a per-cohort
 * set such as Study Master Games.
 */
export function isWorkbook(task: Requirement | CustomTask): boolean {
    if (!isRequirement(task) || task.numberOfCohorts !== 1) {
        return false;
    }
    if (task.startCount > 0) {
        return true;
    }
    const targets = Object.entries(task.counts)
        .filter(([cohort]) => cohort !== ALL_COHORTS)
        .map(([, count]) => count);
    return new Set(targets).size > 1;
}

/** How a workbook's items relate to its count. Mapped only when the book has one item per unit. */
export interface BookMapping {
    mapped: boolean;
    startCount: number;
    /** The task's unit for the count, lower case. Empty for a set. */
    unit: string;
}

export function bookMapping(task: Requirement | CustomTask, itemCount: number): BookMapping {
    if (!isWorkbook(task)) {
        return { mapped: false, startCount: 0, unit: '' };
    }
    const startCount = task.startCount ?? 0;
    const targets = Object.entries(task.counts)
        .filter(([cohort]) => cohort !== ALL_COHORTS)
        .map(([, count]) => count);
    const end = targets.length > 0 ? Math.max(...targets) : (task.counts[ALL_COHORTS] ?? 0);
    return {
        mapped: itemCount === end - startCount,
        startCount,
        unit: task.progressBarSuffix.trim().toLowerCase(),
    };
}

/**
 * Done counts the item when the task's count is items: a custom task, a task without a suffix,
 * such as Study Master Games, or a workbook whose book maps onto its count. For a task counted
 * in a named unit, such as pages or chapters, Done records the mark and leaves the count as it
 * is, because only the member knows how many of that unit the item was.
 */
export function countsItems(task: Requirement | CustomTask, mapping: BookMapping): boolean {
    return !isRequirement(task) || mapping.mapped || !task.progressBarSuffix.trim();
}

/**
 * The cohort's share of a mapped book, the items from position startCount + 1 through its target.
 */
export function cohortSlice(
    items: StudyItem[],
    task: Requirement | CustomTask,
    cohort: string,
    mapping: BookMapping,
): StudyItem[] {
    if (!mapping.mapped) {
        return items;
    }
    const target = task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0;
    return items.slice(0, Math.max(0, target - mapping.startCount));
}

/**
 * The keys the count covers beyond the explicit marks in a mapped book. The count is how many
 * items are done and the marks say which; the earliest unmarked items stand in for the rest,
 * which is progress made before the reader recorded marks.
 */
export function pointerDone(
    items: StudyItem[],
    pointer: number,
    mapping: BookMapping,
    marks: ReadonlySet<string>,
): Set<string> {
    if (!mapping.mapped) {
        return new Set();
    }
    const marked = items.filter((item) => marks.has(item.key)).length;
    let remainder = Math.max(0, pointer - mapping.startCount - marked);
    const keys = new Set<string>();
    for (const item of items) {
        if (remainder === 0) break;
        if (marks.has(item.key)) continue;
        keys.add(item.key);
        remainder -= 1;
    }
    return keys;
}

/** How the reader opens an item: as a game to read or as a puzzle to solve. */
export type StudyMode = { kind: 'read' } | { kind: 'solve'; playBothSides: boolean };

const READ: StudyMode = { kind: 'read' };
const SOLVE: StudyMode = { kind: 'solve', playBothSides: false };
const MEMORIZE: StudyMode = { kind: 'solve', playBothSides: true };
const START_POSITION = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -';

/** The PGN's header tags, read from the block before the first blank line. */
function headerTags(pgn: string): Map<string, string> {
    const block = pgn.split(/\r?\n\r?\n/, 1)[0] ?? '';
    const tags = new Map<string, string>();
    for (const match of block.matchAll(/^\[(\w+)\s+"([^"]*)"\]/gm)) {
        tags.set(match[1], match[2]);
    }
    return tags;
}

/**
 * The mode an item's own PGN asks for. A StudyMode tag decides when present. Otherwise a
 * position start presets solve and a game from the initial position presets read.
 */
export function presetMode(pgn: string): StudyMode {
    const tags = headerTags(pgn);
    switch (tags.get('StudyMode')?.toLowerCase()) {
        case 'solve':
            return SOLVE;
        case 'read':
            return READ;
        case 'memorize':
            return MEMORIZE;
    }
    const fen = tags.get('FEN') ?? '';
    const positionStart = fen ? !fen.startsWith(START_POSITION) : tags.get('SetUp') === '1';
    return positionStart ? SOLVE : READ;
}

/** The side to move at the PGN's start. */
export function sideToMove(pgn: string): 'white' | 'black' {
    return headerTags(pgn).get('FEN')?.split(' ')[1] === 'b' ? 'black' : 'white';
}

/** The mode after the member's own choice for the item, when there is one. */
export function resolveMode(preset: StudyMode, override?: StudyMode['kind']): StudyMode {
    if (!override || override === preset.kind) {
        return preset;
    }
    return override === 'read' ? READ : SOLVE;
}
