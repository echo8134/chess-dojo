import { BoardApi } from '@/board/Board';
import { Timer, TimerContext } from '@/components/timer/TimerContext';
import { Course, CourseModuleType, CourseType } from '@/database/course';
import { Game } from '@/database/game';
import {
    Requirement,
    RequirementCategory,
    RequirementStatus,
    ScoreboardDisplay,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { Chess } from '@jackstenglein/chess';
import { act, renderHook, waitFor } from '@testing-library/react';
import { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useStudy } from './useStudy';

const PGN_A = '[Event "A"]\n[White "Keres"]\n[Black "Smyslov"]\n[Result "*"]\n\n*';
const PGN_B = '[Event "B"]\n[White "Tal"]\n[Black "Botvinnik"]\n[Result "*"]\n\n*';
const KEY_A = 'course:STUDY/study-1/m1/0';
const KEY_B = 'course:STUDY/study-1/m2/0';

const course = {
    type: CourseType.Study,
    id: 'study-1',
    name: 'Master Games',
    allowExport: false,
    chapters: [
        { name: 'Keres vs Smyslov', modules: [pgnModule('m1', PGN_A)] },
        { name: 'Tal vs Botvinnik', modules: [pgnModule('m2', PGN_B)] },
    ],
} as unknown as Course;

function pgnModule(id: string, pgn: string) {
    return {
        id,
        name: '',
        type: CourseModuleType.PgnViewer,
        description: '',
        postscript: '',
        videoUrls: [],
        pgns: [pgn],
        coach: '',
        positions: [],
        boardOrientation: 'white',
    };
}

const task = {
    id: 'task-1',
    status: RequirementStatus.Active,
    category: RequirementCategory.Middlegames,
    name: 'Study Master Games',
    description: '',
    freeDescription: '',
    counts: { '1500-1600': 45 },
    startCount: 0,
    numberOfCohorts: 1,
    unitScore: 1,
    unitScoreOverride: {},
    totalScore: 0,
    videoUrls: [],
    positions: [],
    scoreboardDisplay: ScoreboardDisplay.ProgressBar,
    progressBarSuffix: 'Games',
    updatedAt: '',
    sortPriority: '1',
    expirationDays: -1,
    isFree: false,
    blockers: [],
    atomic: false,
    expectedMinutes: 0,
    material: [{ kind: 'COURSE', courseType: 'STUDY', courseId: 'study-1' }],
} as Requirement;

function copyOf(id: string, key: string, pgn: string): Game {
    return {
        cohort: '1500-1600',
        id,
        owner: 'student',
        pgn,
        orientation: 'white',
        updatedAt: `${id}-v1`,
        headers: {
            White: 'Keres',
            Black: 'Smyslov',
            Date: '',
            Site: '',
            Result: '*',
            StudyItem: key,
        },
    } as unknown as Game;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

const mocks = vi.hoisted(() => ({
    api: {
        getCourse: vi.fn(),
        getDirectory: vi.fn(),
        listGamesByOwner: vi.fn(),
        listUserTimeline: vi.fn(),
        getGame: vi.fn(),
        createGame: vi.fn(),
        updateGame: vi.fn(),
    },
    updateSearchParams: vi.fn(),
}));

vi.mock('@/api/Api', () => ({ useApi: () => mocks.api }));
vi.mock('@/auth/Auth', () => ({
    AuthStatus: { Loading: 'Loading', Authenticated: 'Authenticated' },
    useAuth: () => ({
        status: 'Authenticated',
        user: { username: 'student', dojoCohort: '1500-1600', progress: {}, customTasks: [] },
    }),
}));
vi.mock('@/api/cache/requirements', () => ({
    useRequirements: () => ({
        requirements: [task],
        request: { isSent: () => true, isLoading: () => false },
    }),
}));
vi.mock('@/hooks/useNextSearchParams', () => ({
    useNextSearchParams: () => ({
        searchParams: new URLSearchParams(),
        updateSearchParams: mocks.updateSearchParams,
    }),
}));

const timer = {
    isRunning: false,
    isPaused: false,
    timerSeconds: 0,
    task: undefined,
    onStart: vi.fn(),
    onPause: vi.fn(),
} as unknown as Timer;

const wrapper = ({ children }: { children: ReactNode }) => (
    <TimerContext.Provider value={timer}>{children}</TimerContext.Provider>
);

function renderStudy(urlKey: string | null = null) {
    return renderHook(() => useStudy('task-1', urlKey), { wrapper });
}

async function ready(urlKey: string | null = null) {
    const rendered = renderStudy(urlKey);
    await waitFor(() => expect(rendered.result.current.status).toBe('ready'));
    const study = () => {
        const s = rendered.result.current;
        if (s.status !== 'ready') throw new Error(`status ${s.status}`);
        return s;
    };
    return { ...rendered, study };
}

/** Mounts a real chess instance on the hook, the way PgnBoard's onInitialize does. */
function attachBoard(study: ReturnType<typeof useStudy>, pgn: string): Chess {
    if (study.status !== 'ready') throw new Error('not ready');
    const chess = new Chess({ pgn });
    study.onBoardInitialize({} as BoardApi, chess);
    return chess;
}

beforeEach(() => {
    for (const fn of Object.values(mocks.api)) fn.mockReset();
    mocks.updateSearchParams.mockReset();
    mocks.api.getCourse.mockResolvedValue({ data: { course, isBlocked: false } });
    mocks.api.listGamesByOwner.mockResolvedValue({ data: { games: [] } });
    mocks.api.listUserTimeline.mockResolvedValue({ entries: [], lastEvaluatedKey: '' });
    (timer.onStart as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useStudy: book, current item and done marks', () => {
    it('opens on the URL item when it exists', async () => {
        const { study } = await ready(KEY_B);
        expect(study().current.key).toBe(KEY_B);
        expect(study().book.chapters).toHaveLength(2);
    });

    it('opens on the first item without a working copy otherwise', async () => {
        const copy = copyOf('copy-a', KEY_A, PGN_A);
        mocks.api.listGamesByOwner.mockResolvedValue({ data: { games: [copy] } });
        const { study } = await ready();
        expect(study().current.key).toBe(KEY_B);
    });

    it('starts the timer on the task when it is idle, once', async () => {
        await ready();
        expect(timer.onStart).toHaveBeenCalledTimes(1);
        expect(timer.onStart).toHaveBeenCalledWith('task-1');
    });

    it('collects done marks across timeline pages and from a new entry at once', async () => {
        const entry = (key: string, requirementId = 'task-1') =>
            ({ requirementId, studyInfo: { itemKey: key, itemName: key } }) as TimelineEntry;
        mocks.api.listUserTimeline
            .mockResolvedValueOnce({ entries: [entry(KEY_A)], lastEvaluatedKey: 'page-2' })
            .mockResolvedValueOnce({ entries: [entry(KEY_B, 'other')], lastEvaluatedKey: '' });
        const { study } = await ready();
        await waitFor(() => expect(study().historyComplete).toBe(true));
        expect([...study().done]).toEqual([KEY_A]);

        act(() => study().onMarkedDone(entry(KEY_B)));
        expect([...study().done].sort()).toEqual([KEY_A, KEY_B]);
    });
});

describe('useStudy: the board for the current item', () => {
    it('shows a canonical game silently unsaved when there is no copy', async () => {
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        expect(study().board).toMatchObject({
            key: KEY_A,
            pgn: PGN_A,
            disableExport: true,
            context: { isOwner: true, unsaved: true, silentUnsaved: true },
        });
        expect(study().board?.context.game).toBeUndefined();
    });

    it('opens the saved copy when one exists', async () => {
        const copy = copyOf('copy-a', KEY_A, PGN_A + ' 1. e4');
        mocks.api.listGamesByOwner.mockResolvedValue({ data: { games: [copy] } });
        mocks.api.getGame.mockResolvedValue({ data: copy });
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        expect(mocks.api.getGame).toHaveBeenCalledWith('1500-1600', 'copy-a');
        expect(study().board?.context).toMatchObject({ isOwner: true, game: { id: 'copy-a' } });
        expect(study().board?.context.unsaved).toBeUndefined();
    });
});

describe('useStudy: the first-change copy', () => {
    it('creates the copy from the first edit, folds later edits into one update, then flips', async () => {
        const create = deferred<{ data: Game }>();
        mocks.api.createGame.mockReturnValue(create.promise);
        mocks.api.updateGame.mockImplementation(
            (_c: string, id: string, req: { pgnText: string }) =>
                Promise.resolve({
                    data: { ...copyOf(id, KEY_A, req.pgnText), updatedAt: `${id}-v2` },
                }),
        );
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);

        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(mocks.api.createGame).toHaveBeenCalledTimes(1));
        expect(study().pendingEdits).toBe(true);
        const [createReq] = mocks.api.createGame.mock.calls[0] as [
            { pgnText: string; type: string },
        ];
        expect(createReq.type).toBe('clone');
        expect(createReq.pgnText).toContain(`[StudyItem "${KEY_A}"]`);
        expect(createReq.pgnText).toContain('[StudyExport "false"]');
        expect(createReq.pgnText).toMatch(/\[StudyStamp "[0-9a-f]{12}"\]/);
        expect(createReq.pgnText).toContain('1. e4');
        expect(createReq.pgnText).not.toContain('e5');

        act(() => {
            chess.move('e5');
        });
        expect(mocks.api.updateGame).not.toHaveBeenCalled();

        act(() => create.resolve({ data: copyOf('copy-a', KEY_A, createReq.pgnText) }));
        await waitFor(() => expect(study().board?.context.game).toBeDefined());

        expect(mocks.api.createGame).toHaveBeenCalledTimes(1);
        expect(mocks.api.updateGame).toHaveBeenCalledTimes(1);
        const [cohort, id, updateReq] = mocks.api.updateGame.mock.calls[0] as [
            string,
            string,
            { pgnText: string; updatedAt: string; type: string },
        ];
        expect([cohort, id]).toEqual(['1500-1600', 'copy-a']);
        expect(updateReq.type).toBe('editor');
        expect(updateReq.updatedAt).toBe('copy-a-v1');
        expect(updateReq.pgnText).toContain('e5');
        expect(study().pendingEdits).toBe(false);
        expect(study().workedOn.has(KEY_A)).toBe(true);
        expect(study().board?.pgn).toBe(PGN_A);
        expect(study().board?.key).toBe(KEY_A);
    });

    it('runs a second update for an edit made during the first and flips once', async () => {
        const create = deferred<{ data: Game }>();
        const update1 = deferred<{ data: Game }>();
        mocks.api.createGame.mockReturnValue(create.promise);
        mocks.api.updateGame
            .mockReturnValueOnce(update1.promise)
            .mockImplementation((_c: string, id: string, req: { pgnText: string }) =>
                Promise.resolve({ data: { ...copyOf(id, KEY_A, req.pgnText), updatedAt: 'v3' } }),
            );
        const { study, result } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);

        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(mocks.api.createGame).toHaveBeenCalledTimes(1));
        act(() => {
            chess.move('e5');
        });
        act(() => create.resolve({ data: copyOf('copy-a', KEY_A, PGN_A) }));
        await waitFor(() => expect(mocks.api.updateGame).toHaveBeenCalledTimes(1));
        act(() => {
            chess.move('Nf3');
        });
        expect(study().board?.context.game).toBeUndefined();

        act(() => update1.resolve({ data: { ...copyOf('copy-a', KEY_A, ''), updatedAt: 'v2' } }));
        await waitFor(() => expect(mocks.api.updateGame).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        const second = mocks.api.updateGame.mock.calls[1] as [
            string,
            string,
            { pgnText: string; updatedAt: string },
        ];
        expect(second[2].updatedAt).toBe('v2');
        expect(second[2].pgnText).toContain('Nf3');
        expect(result.current.status === 'ready' && result.current.pendingEdits).toBe(false);
    });

    it('stays canonical after a failed create and creates again on the next edit', async () => {
        mocks.api.createGame
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValue({ data: copyOf('copy-a', KEY_A, PGN_A) });
        mocks.api.updateGame.mockImplementation(
            (_c: string, id: string, req: { pgnText: string }) =>
                Promise.resolve({ data: copyOf(id, KEY_A, req.pgnText) }),
        );
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);

        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(study().copyRequest.isFailure()).toBe(true));
        expect(study().board?.context.unsaved).toBe(true);
        expect(study().pendingEdits).toBe(true);

        act(() => {
            chess.move('e5');
        });
        await waitFor(() => expect(mocks.api.createGame).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        const [secondCreate] = mocks.api.createGame.mock.calls[1] as [{ pgnText: string }];
        expect(secondCreate.pgnText).toContain('e5');
    });

    it('keeps the copy after a failed update and retries against it on the next edit', async () => {
        const create = deferred<{ data: Game }>();
        mocks.api.createGame.mockReturnValue(create.promise);
        mocks.api.updateGame
            .mockRejectedValueOnce(new Error('conflict'))
            .mockImplementation((_c: string, id: string, req: { pgnText: string }) =>
                Promise.resolve({ data: copyOf(id, KEY_A, req.pgnText) }),
            );
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);

        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(mocks.api.createGame).toHaveBeenCalledTimes(1));
        act(() => {
            chess.move('e5');
        });
        act(() => create.resolve({ data: copyOf('copy-a', KEY_A, PGN_A) }));
        await waitFor(() => expect(study().copyRequest.isFailure()).toBe(true));
        expect(mocks.api.updateGame).toHaveBeenCalledTimes(1);
        expect(study().board?.context.game).toBeUndefined();
        expect(study().pendingEdits).toBe(true);

        act(() => {
            chess.move('Nf3');
        });
        await waitFor(() => expect(mocks.api.updateGame).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        expect(mocks.api.createGame).toHaveBeenCalledTimes(1);
        const second = mocks.api.updateGame.mock.calls[1] as [string, string, { pgnText: string }];
        expect(second[1]).toBe('copy-a');
        expect(second[2].pgnText).toContain('Nf3');
    });

    it('refetches a saved game when the item is reopened after switching away', async () => {
        const copy = copyOf('copy-a', KEY_A, PGN_A);
        mocks.api.listGamesByOwner.mockResolvedValue({ data: { games: [copy] } });
        mocks.api.getGame.mockResolvedValue({ data: copy });
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        expect(mocks.api.getGame).toHaveBeenCalledTimes(1);

        act(() => {
            study().select(study().book.chapters[1].items[0]);
        });
        await waitFor(() => expect(study().board?.key).toBe(KEY_B));
        act(() => {
            study().select(study().book.chapters[0].items[0]);
        });
        await waitFor(() => expect(study().board?.context.game).toBeDefined());
        expect(mocks.api.getGame).toHaveBeenCalledTimes(2);
    });

    it('refuses to change item while edits are unsaved after a failed create', async () => {
        mocks.api.createGame.mockRejectedValue(new Error('boom'));
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);
        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(study().copyRequest.isFailure()).toBe(true));
        expect(study().pendingEdits).toBe(true);

        let accepted = true;
        act(() => {
            accepted = study().select(study().book.chapters[1].items[0]);
        });
        expect(accepted).toBe(false);
        expect(study().current.key).toBe(KEY_A);
    });

    it('refuses to change item while a write is pending', async () => {
        const create = deferred<{ data: Game }>();
        mocks.api.createGame.mockReturnValue(create.promise);
        const { study } = await ready(KEY_A);
        await waitFor(() => expect(study().board).toBeDefined());
        const chess = attachBoard(study(), PGN_A);
        act(() => {
            chess.move('e4');
        });
        await waitFor(() => expect(mocks.api.createGame).toHaveBeenCalledTimes(1));

        const other = study().book.chapters[1].items[0];
        let accepted = true;
        act(() => {
            accepted = study().select(other);
        });
        expect(accepted).toBe(false);
        expect(study().current.key).toBe(KEY_A);
        expect(mocks.updateSearchParams).not.toHaveBeenCalled();
    });
});
