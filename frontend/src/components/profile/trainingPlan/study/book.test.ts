import { Course, CourseModule, CourseModuleType, CourseType } from '@/database/course';
import {
    Directory,
    DirectoryItemTypes,
} from '@jackstenglein/chess-dojo-common/src/database/directory';
import { describe, expect, it } from 'vitest';
import { courseBook, directoryBook, itemsOf } from './book';

function module(overrides: Partial<CourseModule>): CourseModule {
    return {
        id: 'm',
        name: '',
        type: CourseModuleType.PgnViewer,
        description: '',
        postscript: '',
        coach: '',
        videoUrls: [],
        pgns: [],
        positions: [],
        boardOrientation: 'white' as const,
        ...overrides,
    };
}

const course = {
    type: CourseType.Study,
    id: 'study-master-games-1500-1600',
    name: 'Master Games 1500-1600',
    allowExport: false,
    chapters: [
        {
            name: 'Keres vs Smyslov (1939)',
            modules: [module({ id: 'm1', pgns: ['[Event "A"]\n\n1. e4 *'] })],
        },
        {
            name: 'Two games',
            modules: [
                module({
                    id: 'm2',
                    name: 'Pair',
                    pgns: ['[Event "B"]\n\n1. d4 *', '[Event "C"]\n\n1. c4 *'],
                }),
                module({ id: '', pgns: ['[Event "D"]\n\n1. Nf3 *'], boardOrientation: 'black' }),
                module({ id: 'v', type: CourseModuleType.Video, videoUrls: ['x'] }),
            ],
        },
    ],
} as unknown as Course;

function ownedGame(id: string, owner: string, white: string, black: string) {
    return {
        type: DirectoryItemTypes.OWNED_GAME,
        id: `1500-1600/${id}`,
        metadata: {
            cohort: '1500-1600',
            id,
            owner,
            createdAt: '2026-01-01T00:00:00Z',
            white,
            black,
        },
    };
}

const directory = {
    owner: 'student',
    id: 'folder-1',
    parent: 'home',
    name: 'Kasparov',
    visibility: 'PRIVATE',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    itemIds: ['sub', '1500-1600/g1', '1500-1600/g2', '1500-1600/g3'],
    items: {
        sub: {
            type: DirectoryItemTypes.DIRECTORY,
            id: 'sub',
            metadata: {
                createdAt: '2026-01-01T00:00:00Z',
                updatedAt: '2026-01-01T00:00:00Z',
                visibility: 'PRIVATE',
                name: 'Sub',
            },
        },
        '1500-1600/g1': ownedGame('g1', 'student', 'Kasparov', 'Karpov'),
        '1500-1600/g2': ownedGame('g2', 'someone-else', 'Tal', 'Botvinnik'),
        '1500-1600/g3': ownedGame('g3', 'student', 'Fischer', 'Spassky'),
    },
} as unknown as Directory;

describe('courseBook', () => {
    const book = courseBook(course);

    it('keeps chapter names and emits one item per PGN, skipping non-PGN modules', () => {
        expect(book.title).toBe('Master Games 1500-1600');
        expect(book.chapters.map((c) => c.name)).toEqual(['Keres vs Smyslov (1939)', 'Two games']);
        expect(itemsOf(book).map((i) => i.name)).toEqual([
            'Keres vs Smyslov (1939)',
            'Pair 1',
            'Pair 2',
            'Two games',
        ]);
    });

    it('keys items by module id and falls back to position without one', () => {
        expect(itemsOf(book).map((i) => i.key)).toEqual([
            'course:STUDY/study-master-games-1500-1600/m1/0',
            'course:STUDY/study-master-games-1500-1600/m2/0',
            'course:STUDY/study-master-games-1500-1600/m2/1',
            'course:STUDY/study-master-games-1500-1600/c1-m1/0',
        ]);
    });

    it('carries the PGN, orientation and export flag', () => {
        const items = itemsOf(book);
        expect(items[0]).toMatchObject({
            kind: 'canonical',
            pgn: '[Event "A"]\n\n1. e4 *',
            orientation: 'white',
            allowExport: false,
        });
        expect(items[3]).toMatchObject({ orientation: 'black' });
        expect(itemsOf(courseBook({ ...course, allowExport: true }))[0]).toMatchObject({
            allowExport: true,
        });
    });
});

describe('directoryBook', () => {
    const book = directoryBook(directory, 'student');

    it("lists only the student's own games, in folder order, named by the players", () => {
        expect(book.title).toBe('Kasparov');
        expect(book.chapters).toHaveLength(1);
        expect(itemsOf(book)).toEqual([
            {
                kind: 'own',
                key: 'game:1500-1600/g1',
                name: 'Kasparov vs Karpov',
                game: { cohort: '1500-1600', id: 'g1' },
            },
            {
                kind: 'own',
                key: 'game:1500-1600/g3',
                name: 'Fischer vs Spassky',
                game: { cohort: '1500-1600', id: 'g3' },
            },
        ]);
    });

    it("counts other members' games as skipped and ignores subfolders", () => {
        expect(book.skipped).toBe(1);
    });

    it('has no chapters when nothing qualifies', () => {
        const empty = directoryBook(directory, 'stranger');
        expect(empty.chapters).toEqual([]);
        expect(empty.skipped).toBe(3);
    });
});
