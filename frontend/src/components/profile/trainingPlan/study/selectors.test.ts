import {
    CustomTask,
    Requirement,
    RequirementCategory,
    RequirementStatus,
    ScoreboardDisplay,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { describe, expect, it } from 'vitest';
import { StudyItem } from './book';
import {
    bookMapping,
    chooseCurrent,
    cohortSlice,
    doneKeys,
    isWorkbook,
    pointerDone,
    singularUnit,
    taskTitle,
} from './selectors';

const items: StudyItem[] = [
    {
        kind: 'canonical',
        key: 'k1',
        name: 'One',
        pgn: '',
        orientation: 'white',
        allowExport: false,
    },
    {
        kind: 'canonical',
        key: 'k2',
        name: 'Two',
        pgn: '',
        orientation: 'white',
        allowExport: false,
    },
    {
        kind: 'canonical',
        key: 'k3',
        name: 'Three',
        pgn: '',
        orientation: 'white',
        allowExport: false,
    },
];
const copies = new Map([
    ['k1', { cohort: 'c', id: '1' }],
    ['k2', { cohort: 'c', id: '2' }],
]);

describe('chooseCurrent', () => {
    it('takes the URL item when it exists', () => {
        expect(chooseCurrent(items, 'k2', copies)?.key).toBe('k2');
    });

    it('falls back to the first item without a copy', () => {
        expect(chooseCurrent(items, null, copies)?.key).toBe('k3');
        expect(chooseCurrent(items, 'missing', copies)?.key).toBe('k3');
    });

    it('falls back to the first item when every item has a copy', () => {
        const all = new Map(copies);
        all.set('k3', { cohort: 'c', id: '3' });
        expect(chooseCurrent(items, null, all)?.key).toBe('k1');
    });

    it('treats own games as never started', () => {
        const own: StudyItem[] = [
            { kind: 'own', key: 'game:c/9', name: 'Mine', game: { cohort: 'c', id: '9' } },
        ];
        expect(chooseCurrent(own, null, new Map())?.key).toBe('game:c/9');
    });

    it('is undefined for an empty book', () => {
        expect(chooseCurrent([], 'k1', copies)).toBeUndefined();
    });
});

describe('doneKeys', () => {
    it("collects item keys only from this task's entries that carry studyInfo", () => {
        const entries = [
            { requirementId: 't', studyInfo: { itemKey: 'k1', itemName: 'One' } },
            { requirementId: 't', studyInfo: { itemKey: 'k1', itemName: 'One' } },
            { requirementId: 't' },
            { requirementId: 'other', studyInfo: { itemKey: 'k2', itemName: 'Two' } },
            { requirementId: 't', studyInfo: { itemKey: 'k3', itemName: 'Three' } },
        ] as TimelineEntry[];
        expect([...doneKeys(entries, 't')].sort()).toEqual(['k1', 'k3']);
    });
});

/** A requirement shaped like a dev row. isRequirement keys on sortPriority. */
function requirement(overrides: Partial<Requirement>): Requirement {
    return {
        id: 'r',
        status: RequirementStatus.Active,
        category: RequirementCategory.Tactics,
        name: 'Task',
        description: '',
        freeDescription: '',
        counts: { '1000-1100': 10 },
        startCount: 0,
        numberOfCohorts: 1,
        unitScore: 1,
        unitScoreOverride: {},
        totalScore: 0,
        videoUrls: [],
        positions: [],
        scoreboardDisplay: ScoreboardDisplay.ProgressBar,
        progressBarSuffix: '',
        updatedAt: '',
        sortPriority: '1',
        expirationDays: -1,
        isFree: false,
        blockers: [],
        atomic: false,
        expectedMinutes: 0,
        ...overrides,
    };
}

const polgarM2 = requirement({
    name: 'Solve Polgar M2s through Problem {{count}}',
    startCount: 306,
    progressBarSuffix: 'Exercises',
    counts: { '600-700': 340, '1000-1100': 650, '1800-1900': 2100, '2400+': 3718 },
});
const polgarM1 = requirement({
    name: 'Solve Polgar M1s through Problem {{count}}',
    progressBarSuffix: 'Exercises',
    counts: { '0-300': 50, '900-1000': 306 },
});
const silmanPart2 = requirement({
    name: 'Read Silman Endgame, Part 2',
    startCount: 30,
    progressBarSuffix: ' Pages',
    counts: { '1000-1100': 54, '1100-1200': 54, '1200-1300': 54, '1300-1400': 54 },
});
const woodpecker = requirement({
    name: 'Read Woodpecker Method',
    progressBarSuffix: 'Exercises',
    counts: { '2000-2100': 984, '2100-2200': 1128 },
});
/** On dev the plain row is one cohort with one count; only the "through Exercise" row carries a count across cohorts. */
const efcwPlain = requirement({
    name: "Everyone's First Chess Workbook",
    progressBarSuffix: 'Exercises',
    counts: { '600-700': 692 },
});
const efcwThrough = requirement({
    name: "Read Everyone's First Chess Workbook through Exercise {{count}}",
    progressBarSuffix: 'Exercises',
    counts: { '0-300': 114, '300-400': 300, '400-500': 500, '500-600': 738 },
});
const masterGames = requirement({
    name: 'Study Master Games',
    counts: { '1500-1600': 45 },
});
const winningChessTactics = requirement({
    name: 'Read Winning Chess Tactics',
    progressBarSuffix: 'Chapters',
    counts: { '1000-1100': 23 },
});
const logicalChess = requirement({
    name: 'Read Logical Chess Move by Move',
    progressBarSuffix: 'Games',
    counts: { '1000-1100': 33, '1100-1200': 33 },
});
const steinitz = requirement({
    name: 'Memorize Steinitz - von Bardeleben',
    scoreboardDisplay: ScoreboardDisplay.Checkbox,
    counts: { '1000-1100': 1 },
});
const customTask = {
    id: 'c',
    owner: 'student',
    name: 'My folder',
    description: '',
    counts: { '1000-1100': 3, '1100-1200': 5 },
    scoreboardDisplay: ScoreboardDisplay.ProgressBar,
    category: RequirementCategory.Games,
    updatedAt: '',
    numberOfCohorts: 1,
    progressBarSuffix: 'Exercises',
    startCount: 2,
} as CustomTask;

function itemList(count: number): StudyItem[] {
    return Array.from({ length: count }, (_, i) => ({
        kind: 'canonical',
        key: `k${i + 1}`,
        name: `Problem ${i + 1}`,
        pgn: '',
        orientation: 'white',
        allowExport: false,
    }));
}

describe('isWorkbook', () => {
    it('is true for a start above zero or a target that differs by cohort', () => {
        expect(isWorkbook(polgarM2)).toBe(true);
        expect(isWorkbook(polgarM1)).toBe(true);
        expect(isWorkbook(silmanPart2)).toBe(true);
        expect(isWorkbook(woodpecker)).toBe(true);
        expect(isWorkbook(efcwThrough)).toBe(true);
    });

    it('is false for a single cohort with one count, whatever the book', () => {
        expect(isWorkbook(efcwPlain)).toBe(false);
    });

    it('is false for sets, whatever their suffix says, and for custom tasks', () => {
        expect(isWorkbook(masterGames)).toBe(false);
        expect(isWorkbook(winningChessTactics)).toBe(false);
        expect(isWorkbook(logicalChess)).toBe(false);
        expect(isWorkbook(steinitz)).toBe(false);
        expect(isWorkbook(customTask)).toBe(false);
    });

    it('is false when the count is kept per cohort', () => {
        expect(isWorkbook(requirement({ ...polgarM2, numberOfCohorts: 3 }))).toBe(false);
    });
});

describe('bookMapping', () => {
    it('maps a workbook with one item per unit', () => {
        expect(bookMapping(polgarM2, 3412)).toEqual({
            mapped: true,
            startCount: 306,
            unit: 'exercises',
        });
    });

    it('does not map a workbook whose items are not its units', () => {
        expect(bookMapping(silmanPart2, 49)).toEqual({
            mapped: false,
            startCount: 30,
            unit: 'pages',
        });
    });

    it('never maps a set', () => {
        expect(bookMapping(masterGames, 45)).toEqual({ mapped: false, startCount: 0, unit: '' });
    });
});

describe('cohortSlice and pointerDone', () => {
    const items = itemList(3412);
    const mapping = bookMapping(polgarM2, items.length);

    it('cuts the book at the cohort target', () => {
        expect(cohortSlice(items, polgarM2, '1000-1100', mapping)).toHaveLength(344);
        expect(cohortSlice(items, polgarM2, '1800-1900', mapping)).toHaveLength(1794);
        expect(cohortSlice(items, polgarM2, '2400+', mapping)).toHaveLength(3412);
    });

    it('leaves an unmapped book whole', () => {
        const pages = itemList(49);
        expect(cohortSlice(pages, silmanPart2, '1000-1100', bookMapping(silmanPart2, 49))).toBe(
            pages,
        );
    });

    it('marks every item at or below the pointer', () => {
        const done = pointerDone(items, 420, mapping);
        expect(done.size).toBe(114);
        expect(done.has('k114')).toBe(true);
        expect(done.has('k115')).toBe(false);
        expect(pointerDone(items, 306, mapping).size).toBe(0);
        expect(pointerDone(items, 420, bookMapping(silmanPart2, 49)).size).toBe(0);
    });
});

describe('taskTitle and singularUnit', () => {
    it('puts the cohort count into the name', () => {
        expect(taskTitle(polgarM2, '1000-1100')).toBe('Solve Polgar M2s through Problem 650');
        expect(taskTitle(polgarM2, '2400+')).toBe('Solve Polgar M2s through Problem 3718');
        expect(taskTitle(masterGames, '1500-1600')).toBe('Study Master Games');
    });

    it('names one of the unit', () => {
        expect(singularUnit('exercises')).toBe('exercise');
        expect(singularUnit('pages')).toBe('page');
        expect(singularUnit('')).toBe('');
    });
});
