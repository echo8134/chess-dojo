import { canOpenCourse, Course, CourseType } from '@/database/course';
import {
    CustomTask,
    getCurrentCount,
    hasMaterial,
    Requirement,
    TaskMaterial,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { ALL_COHORTS, compareCohorts, dojoCohorts, User } from '@/database/user';
import { itemsOf, StudyBook, StudyItem } from './book';
import { isWorkbook, taskCohort, taskTitle } from './selectors';

export interface OverviewInput {
    user: User;
    requirements: Requirement[];
    courses: Course[];
    /** The member's timeline, any order; the newest entries decide last activity. */
    entries: TimelineEntry[];
    /**
     * The cohort the page shows, the member's own by default. Another cohort's studies open in
     * browse mode.
     */
    viewCohort?: string;
    /**
     * The books loaded so far for the cohort studies, keyed by task id. They name the next item.
     */
    books?: Map<string, StudyBook>;
}

/** A training plan task with material for the cohort the page shows. */
export interface CohortStudy {
    task: Requirement;
    cohort: string;
    /** For a workbook, done and total are counted from the task's start, in its unit. */
    done: number;
    total: number;
    minutes: number;
    courseName?: string;
    lastEntry?: TimelineEntry;
    /** The task's name with the cohort's count in it. */
    name: string;
    /** For a set, the item after the last studied one, or the first. A workbook names a position. */
    next?: StudyItem;
    /** True when the page shows another cohort. The tile then opens in browse mode. */
    browse: boolean;
    /** The count's unit of a workbook, lower case. Empty for a set. */
    unit: string;
    /**
     * For a workbook, the position after the pointer. The tile names it before the book has loaded.
     */
    nextPosition?: number;
}

/** A custom task with material. */
export interface StudyRow {
    task: CustomTask;
    cohort: string;
    done: number;
    total: number;
    source: TaskMaterial;
    /** The course's name for course material; folders would need a fetch. */
    sourceName?: string;
    lastEntry?: TimelineEntry;
}

export interface CourseRow {
    course: Course;
    /** The course's cohorts include the member's; the rest sit behind a switch. */
    inCohort: boolean;
}

export interface OverviewModel {
    cohortStudies: CohortStudy[];
    studies: StudyRow[];
    courses: CourseRow[];
    /** Every cohort a study covers, in order, for the cohort switch. */
    cohorts: string[];
}

function newestFirst(entries: TimelineEntry[]): TimelineEntry[] {
    return [...entries].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function total(task: Requirement | CustomTask, cohort: string): number {
    return task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0;
}

function courseOf(courses: Course[], material: TaskMaterial | undefined): Course | undefined {
    if (material?.kind !== 'COURSE') return undefined;
    return courses.find((c) => c.type === material.courseType && c.id === material.courseId);
}

function nextItem(book: StudyBook | undefined, lastEntry: TimelineEntry | undefined) {
    if (!book) {
        return undefined;
    }
    const items = itemsOf(book);
    const lastKey = lastEntry?.studyInfo?.itemKey;
    const index = lastKey ? items.findIndex((item) => item.key === lastKey) : -1;
    return items[index + 1] ?? items[0];
}

/** The Reader overview from what the frontend already holds. Nothing here fetches. */
export function buildOverview(input: OverviewInput): OverviewModel {
    const { user, requirements, courses } = input;
    const entries = newestFirst(input.entries);
    const withMaterial = requirements.filter(hasMaterial);
    const viewCohort = input.viewCohort ?? user.dojoCohort;
    const browse = viewCohort !== user.dojoCohort;

    const cohortStudies: CohortStudy[] = withMaterial
        .filter((task) => task.counts[viewCohort] !== undefined || task.counts[ALL_COHORTS])
        .map((task) => {
            const cohort = browse ? viewCohort : taskCohort(task, user);
            const progress = user.progress[task.id];
            const lastEntry = entries.find((e) => e.requirementId === task.id && e.studyInfo);
            const workbook = isWorkbook(task);
            const start = workbook ? task.startCount : 0;
            const pointer = getCurrentCount({
                cohort,
                requirement: task,
                progress,
                timeline: entries,
            });
            const target = total(task, cohort);
            const totalUnits = Math.max(0, target - start);
            return {
                task,
                cohort,
                name: taskTitle(task, cohort),
                done: Math.min(totalUnits, Math.max(0, pointer - start)),
                total: totalUnits,
                minutes: progress?.minutesSpent?.[cohort] ?? 0,
                // A book in several parts is named by the task; one part's name would mislead.
                courseName:
                    task.material?.length === 1
                        ? courseOf(courses, task.material[0])?.name
                        : undefined,
                lastEntry,
                // The study page holds the whole book and the mapping, so it picks a workbook's item.
                next: workbook ? undefined : nextItem(input.books?.get(task.id), lastEntry),
                browse,
                unit: workbook ? task.progressBarSuffix.trim().toLowerCase() : '',
                // A count below the task's start still starts at the first position of the book.
                nextPosition:
                    workbook && pointer < target ? Math.max(pointer, start) + 1 : undefined,
            };
        });

    // The plan lists a custom task only when its counts name the member's cohort; so does the Reader.
    const customTasks = (user.customTasks ?? []).filter(
        (task) => hasMaterial(task) && task.counts[user.dojoCohort] !== undefined,
    );
    const studies: StudyRow[] = customTasks
        .flatMap((task): StudyRow[] => {
            const source = task.material?.[0];
            if (!source) return [];
            const cohort = taskCohort(task, user);
            const progress = user.progress[task.id];
            return [
                {
                    task,
                    cohort,
                    done: getCurrentCount({
                        cohort,
                        requirement: task,
                        progress,
                        timeline: entries,
                    }),
                    total: total(task, cohort),
                    source,
                    sourceName: courseOf(courses, source)?.name,
                    lastEntry: entries.find((e) => e.requirementId === task.id),
                },
            ];
        })
        .sort((a, b) => {
            if (a.lastEntry && b.lastEntry) {
                return b.lastEntry.createdAt.localeCompare(a.lastEntry.createdAt);
            }
            return a.lastEntry ? -1 : b.lastEntry ? 1 : 0;
        });

    const studiedCourses = new Set(
        customTasks.flatMap((task) =>
            (task.material ?? []).flatMap((m) => (m.kind === 'COURSE' ? [m.courseId] : [])),
        ),
    );
    const courseRows: CourseRow[] = courses
        .filter(
            (course) =>
                course.type !== CourseType.Study &&
                !studiedCourses.has(course.id) &&
                canOpenCourse(user, course),
        )
        .map((course) => ({ course, inCohort: course.cohorts.includes(user.dojoCohort) }));

    const cohorts = [
        ...new Set(
            withMaterial.flatMap((task) =>
                task.counts[ALL_COHORTS] ? dojoCohorts : Object.keys(task.counts),
            ),
        ),
    ]
        .filter((cohort) => cohort !== ALL_COHORTS)
        .sort(compareCohorts);

    return { cohortStudies, studies, courses: courseRows, cohorts };
}
