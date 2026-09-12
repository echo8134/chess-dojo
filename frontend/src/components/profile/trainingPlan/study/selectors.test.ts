import { TimelineEntry } from '@/database/timeline';
import { describe, expect, it } from 'vitest';
import { StudyItem } from './book';
import { chooseCurrent, doneKeys } from './selectors';

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
