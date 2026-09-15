import { GameKey } from '@/database/game';
import { CustomTask, isRequirement, Requirement } from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { ALL_COHORTS, compareCohorts, dojoCohorts, User } from '@/database/user';
import { StudyItem } from './book';

/** The cohort whose count the task tracks for this user, as the task dialog picks it. */
export function taskCohort(task: Requirement | CustomTask, user: User): string {
    const options = task.counts[ALL_COHORTS] ? dojoCohorts : Object.keys(task.counts);
    if (options.includes(user.dojoCohort)) {
        return user.dojoCohort;
    }
    return [...options].sort(compareCohorts)[0] ?? user.dojoCohort;
}

/**
 * The URL's item if it exists. Otherwise the first item the student has not started, one the
 * pointer has not passed and that has no working copy. Otherwise the first item.
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

/** The task's name with the cohort's count in it, as the plan shows it. */
export function taskTitle(task: Requirement | CustomTask, cohort: string): string {
    const count = task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0;
    return task.name.replaceAll('{{count}}', String(count));
}

/** One of the count's unit, for wording such as "exercise 421"; the plan's suffixes are regular plurals. */
export function singularUnit(unit: string): string {
    return unit.endsWith('s') ? unit.slice(0, -1) : unit;
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

/** The keys the pointer has passed in a mapped book, every item at or below the current count. */
export function pointerDone(
    items: StudyItem[],
    pointer: number,
    mapping: BookMapping,
): Set<string> {
    if (!mapping.mapped) {
        return new Set();
    }
    return new Set(
        items.slice(0, Math.max(0, pointer - mapping.startCount)).map((item) => item.key),
    );
}
