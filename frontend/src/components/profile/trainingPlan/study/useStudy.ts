import { useApi } from '@/api/Api';
import { useRequirements } from '@/api/cache/requirements';
import { isGame } from '@/api/gameApi';
import { Request, useRequest } from '@/api/Request';
import { AuthStatus, useAuth } from '@/auth/Auth';
import { BoardApi } from '@/board/Board';
import { TimerContext } from '@/components/timer/TimerContext';
import { GameContextType } from '@/context/useGame';
import { Course } from '@/database/course';
import { Game, GameKey } from '@/database/game';
import {
    CustomTask,
    getCurrentCount,
    Requirement,
    RequirementProgress,
    TaskMaterial,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { ALL_COHORTS, compareCohorts, dojoCohorts, User } from '@/database/user';
import { useNextSearchParams } from '@/hooks/useNextSearchParams';
import { Chess, Event, EventType } from '@jackstenglein/chess';
import { GameImportTypes } from '@jackstenglein/chess-dojo-common/src/database/game';
import { MutableRefObject, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanonicalItem, courseBook, directoryBook, itemsOf, StudyBook, StudyItem } from './book';
import { copyHeaders, findCopies, studyStamp } from './copies';
import { chooseCurrent, doneKeys } from './selectors';

export type StudyTask = Requirement | CustomTask;

export type StudyState =
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'no-material'; task: StudyTask }
    | { status: 'blocked'; task: StudyTask; course: Course }
    | { status: 'empty'; task: StudyTask; book: StudyBook }
    | StudyReady;

export interface StudyReady {
    status: 'ready';
    task: StudyTask;
    cohort: string;
    progress?: RequirementProgress;
    currentCount: number;
    totalCount: number;
    book: StudyBook;
    current: StudyItem;
    /** Refused, returning false, while a copy write is in flight. */
    select: (item: StudyItem) => boolean;
    done: Set<string>;
    workedOn: Set<string>;
    historyComplete: boolean;
    /** True from the first edit of a canonical game until its copy holds every edit. */
    pendingEdits: boolean;
    /** The board reports its own unsaved edits here; selecting another item waits for them. */
    onBoardUnsaved: (unsaved: boolean) => void;
    copyRequest: Request;
    board?: StudyBoard;
    onBoardInitialize: (board: BoardApi, chess: Chess) => void;
    onMarkedDone: (entry: TimelineEntry) => void;
}

/** What the page hands to PgnBoard for the current item. Constant while the item stays selected. */
export interface StudyBoard {
    key: string;
    pgn: string;
    orientation: 'white' | 'black';
    context: GameContextType;
    disableExport: boolean;
}

type CopyPhase = 'canonical' | 'creating' | 'reconciling' | 'copyPending' | 'copy';

interface CopyMachine {
    phase: CopyPhase;
    dirty: boolean;
    /** The item the copy belongs to, so the version lands on that item's ref. */
    key?: string;
    game?: Game;
    updatedAt?: string;
    lastWritten?: string;
}

const EDIT_EVENTS = [
    EventType.NewVariation,
    EventType.UpdateComment,
    EventType.UpdateCommand,
    EventType.UpdateNags,
    EventType.UpdateDrawables,
    EventType.DeleteMove,
    EventType.DeleteBeforeMove,
    EventType.PromoteVariation,
    EventType.UpdateHeader,
];

function sameGame(a: Game, b: Game): boolean {
    return a.cohort === b.cohort && a.id === b.id;
}

type BookState =
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'no-material' }
    | { status: 'blocked'; course: Course }
    | { status: 'ready'; book: StudyBook; needsCopies: boolean };

/** The cohort whose count the task tracks for this user, as the task dialog picks it. */
export function taskCohort(task: StudyTask, user: User): string {
    const options = task.counts[ALL_COHORTS] ? dojoCohorts : Object.keys(task.counts);
    if (options.includes(user.dojoCohort)) {
        return user.dojoCohort;
    }
    return [...options].sort(compareCohorts)[0] ?? user.dojoCohort;
}

export function useStudy(taskId: string, urlItemKey: string | null): StudyState {
    const api = useApi();
    const { user, status: authStatus } = useAuth();
    const { requirements, request: requirementsRequest } = useRequirements(ALL_COHORTS, false);
    const timer = use(TimerContext);
    const { updateSearchParams } = useNextSearchParams();
    const copyRequest = useRequest();

    const task = useMemo<StudyTask | undefined>(
        () =>
            user?.customTasks?.find((t) => t.id === taskId) ??
            requirements.find((r) => r.id === taskId),
        [user?.customTasks, requirements, taskId],
    );
    // Keyed by value, so a refreshed user record does not rebuild the book or remount the board.
    const materialKey = JSON.stringify(task?.material?.[0] ?? null);
    const material = useMemo(() => JSON.parse(materialKey) as TaskMaterial | null, [materialKey]);
    const hasTask = !!task;

    const [bookState, setBookState] = useState<BookState>({ status: 'loading' });
    const [copies, setCopies] = useState<Map<string, GameKey>>();
    const [entries, setEntries] = useState<TimelineEntry[]>([]);
    const [historyComplete, setHistoryComplete] = useState(false);
    const [current, setCurrent] = useState<StudyItem>();
    const [loadedGame, setLoadedGame] = useState<{ key: string; game: Game }>();
    const [copyGame, setCopyGame] = useState<Game>();
    // The item whose copy was created in this session; it stays on the first-change path until reselected.
    const [sessionCopyKey, setSessionCopyKey] = useState<string>();
    const [pendingEdits, setPendingEdits] = useState(false);
    const pendingEditsRef = useRef(false);
    pendingEditsRef.current = pendingEdits;
    // Edits the board holds for a saved game, pending its auto-save or left over from a failed one.
    const boardUnsavedRef = useRef(false);
    const onBoardUnsaved = useCallback((unsaved: boolean) => {
        boardUnsavedRef.current = unsaved;
    }, []);
    // Every user update rebuilds the api object, the timer and a progress post among them, so
    // the effects read it through a ref and never rerun for it. A rerun would reload the book.
    const apiRef = useRef(api);
    apiRef.current = api;
    // One version ref per item. The board's auto-save reads the ref of the game it saves,
    // so a save that lands after the student switched games still carries that game's version.
    const versionRefs = useRef(new Map<string, MutableRefObject<string | undefined>>());
    const versionRef = useCallback((key: string) => {
        let ref = versionRefs.current.get(key);
        if (!ref) {
            ref = { current: undefined };
            versionRefs.current.set(key, ref);
        }
        return ref;
    }, []);

    const username = user?.username;

    // The book is the task's first material entry, resolved through the existing endpoints.
    useEffect(() => {
        if (!hasTask || !username) {
            return;
        }
        if (!material) {
            setBookState({ status: 'no-material' });
            return;
        }
        let cancelled = false;
        setBookState({ status: 'loading' });
        const load = async () => {
            if (material.kind === 'COURSE') {
                const resp = await apiRef.current.getCourse(material.courseType, material.courseId);
                if (cancelled) return;
                if (resp.data.isBlocked || !resp.data.course) {
                    setBookState({ status: 'blocked', course: resp.data.course });
                    return;
                }
                setBookState({
                    status: 'ready',
                    book: courseBook(resp.data.course),
                    needsCopies: true,
                });
            } else {
                const resp = await apiRef.current.getDirectory(
                    material.owner,
                    material.directoryId,
                );
                if (cancelled) return;
                setBookState({
                    status: 'ready',
                    book: directoryBook(resp.data.directory, username),
                    needsCopies: false,
                });
            }
        };
        load().catch((error: unknown) => {
            if (!cancelled) setBookState({ status: 'error', error });
        });
        return () => {
            cancelled = true;
        };
    }, [hasTask, material, username]);

    // The student's games, paged to the end once, to find working copies.
    useEffect(() => {
        if (bookState.status !== 'ready' || !username) {
            return;
        }
        if (!bookState.needsCopies) {
            setCopies(new Map());
            return;
        }
        let cancelled = false;
        const load = async () => {
            const games = [];
            let startKey: string | undefined;
            do {
                const resp = await apiRef.current.listGamesByOwner(username, startKey);
                games.push(...resp.data.games);
                startKey = resp.data.lastEvaluatedKey;
            } while (startKey && !cancelled);
            if (!cancelled) setCopies(findCopies(games));
        };
        load().catch((error: unknown) => {
            if (!cancelled) setBookState({ status: 'error', error });
        });
        return () => {
            cancelled = true;
        };
    }, [bookState, username]);

    // The student's timeline, cumulatively and in the background, for done marks.
    useEffect(() => {
        if (!username) {
            return;
        }
        let cancelled = false;
        setEntries([]);
        setHistoryComplete(false);
        const load = async () => {
            let startKey: string | undefined;
            do {
                const resp = await apiRef.current.listUserTimeline(username, startKey);
                if (cancelled) return;
                setEntries((prev) => [...prev, ...resp.entries]);
                startKey = resp.lastEvaluatedKey || undefined;
            } while (startKey);
            setHistoryComplete(true);
        };
        load().catch(() => undefined);
        return () => {
            cancelled = true;
        };
    }, [username]);

    const items = useMemo(
        () => (bookState.status === 'ready' ? itemsOf(bookState.book) : []),
        [bookState],
    );

    // The initial item, once the book and the copies are known.
    useEffect(() => {
        if (current || items.length === 0 || !copies) {
            return;
        }
        setCurrent(chooseCurrent(items, urlItemKey, copies));
    }, [current, items, copies, urlItemKey]);

    // The saved game behind an own item or a canonical item with a copy.
    const savedKey = useMemo(() => {
        if (!current) return undefined;
        if (current.kind === 'own') return current.game;
        if (current.key === sessionCopyKey) return undefined;
        return copies?.get(current.key);
    }, [current, copies, sessionCopyKey]);

    useEffect(() => {
        if (!current || !savedKey || loadedGame?.key === current.key) {
            return;
        }
        let cancelled = false;
        const key = current.key;
        apiRef.current
            .getGame(savedKey.cohort, savedKey.id)
            .then((resp) => {
                if (cancelled) return;
                versionRef(key).current = resp.data.updatedAt;
                setLoadedGame({ key, game: resp.data });
            })
            .catch((error: unknown) => {
                if (!cancelled) setBookState({ status: 'error', error });
            });
        return () => {
            cancelled = true;
        };
    }, [current, savedKey, loadedGame?.key, versionRef]);

    // Start the timer on this task when it is idle. A timer on another task is left alone.
    const timerStarted = useRef(false);
    useEffect(() => {
        if (timerStarted.current || bookState.status !== 'ready' || !task) {
            return;
        }
        timerStarted.current = true;
        if (!timer.isRunning && (!timer.task || timer.task.id === task.id)) {
            timer.onStart(task.id);
        }
    }, [bookState.status, task, timer]);

    // The first-change copy. One machine per selected canonical item.
    const machine = useRef<CopyMachine>({ phase: 'canonical', dirty: false });
    const chessRef = useRef<Chess>(null);
    const currentRef = useRef<StudyItem>(undefined);
    currentRef.current = current;
    // The board saves an item whose copy already exists; the machine stays out of it.
    const savedKeyRef = useRef<GameKey | undefined>(undefined);
    savedKeyRef.current = savedKey;
    const stampRef = useRef<Promise<string>>(null);

    const reconcile = useCallback(
        async (chess: Chess) => {
            const m = machine.current;
            if (!m.game) return;
            m.phase = 'reconciling';
            try {
                do {
                    m.dirty = false;
                    const pgn = chess.renderPgn();
                    if (pgn !== m.lastWritten) {
                        const resp = await apiRef.current.updateGame(m.game.cohort, m.game.id, {
                            type: GameImportTypes.editor,
                            pgnText: pgn,
                            updatedAt: m.updatedAt,
                        });
                        m.updatedAt = resp.data.updatedAt;
                        m.lastWritten = pgn;
                        m.game = resp.data;
                    }
                } while (m.dirty);
                // Nothing is unsaved and none of our writes is in flight, so the
                // board's own auto-save can take over from a clean baseline.
                if (m.key) versionRef(m.key).current = m.updatedAt;
                m.phase = 'copy';
                setCopyGame({ ...m.game, pgn: m.lastWritten ?? m.game.pgn });
                setPendingEdits(false);
            } catch (error) {
                m.phase = 'copyPending';
                copyRequest.onFailure(error);
            }
        },
        [copyRequest, versionRef],
    );

    const createCopy = useCallback(
        async (item: CanonicalItem, chess: Chess) => {
            const m = machine.current;
            m.phase = 'creating';
            m.dirty = false;
            m.key = item.key;
            setPendingEdits(true);
            try {
                stampRef.current ??= studyStamp(username ?? '');
                const stamp = await stampRef.current;
                for (const [name, value] of Object.entries(copyHeaders(item, stamp))) {
                    chess.setHeader(name, value);
                }
                const snapshot = chess.renderPgn();
                const resp = await apiRef.current.createGame({
                    type: GameImportTypes.clone,
                    pgnText: snapshot,
                    orientation: item.orientation,
                });
                if (!isGame(resp.data)) {
                    throw new Error('Unexpected response when creating the working copy');
                }
                m.game = resp.data;
                m.updatedAt = resp.data.updatedAt;
                m.lastWritten = snapshot;
                const key = { cohort: resp.data.cohort, id: resp.data.id };
                setSessionCopyKey(item.key);
                setCopies((prev) => new Map(prev).set(item.key, key));
            } catch (error) {
                m.phase = 'canonical';
                stampRef.current = null;
                copyRequest.onFailure(error);
                return;
            }
            await reconcile(chess);
        },
        [copyRequest, reconcile, username],
    );

    const onEdit = useCallback(() => {
        const chess = chessRef.current;
        const item = currentRef.current;
        if (!chess || item?.kind !== 'canonical' || savedKeyRef.current) {
            return;
        }
        const m = machine.current;
        switch (m.phase) {
            case 'canonical':
                void createCopy(item, chess);
                break;
            case 'creating':
            case 'reconciling':
                m.dirty = true;
                break;
            case 'copyPending':
                void reconcile(chess);
                break;
            case 'copy':
                break;
        }
    }, [createCopy, reconcile]);

    const onBoardInitialize = useCallback(
        (_board: BoardApi, chess: Chess) => {
            chessRef.current = chess;
            const observer = { types: EDIT_EVENTS, handler: (_event: Event) => onEdit() };
            chess.addObserver(observer);
        },
        [onEdit],
    );

    const applySelection = useCallback((item: StudyItem) => {
        machine.current = { phase: 'canonical', dirty: false };
        chessRef.current = null;
        boardUnsavedRef.current = false;
        setCopyGame(undefined);
        setSessionCopyKey(undefined);
        setLoadedGame(undefined);
        setPendingEdits(false);
        setCurrent(item);
    }, []);

    const select = useCallback(
        (item: StudyItem) => {
            if (item.key === currentRef.current?.key) {
                return true;
            }
            if (pendingEditsRef.current || boardUnsavedRef.current) {
                return false;
            }
            applySelection(item);
            updateSearchParams({ item: item.key });
            return true;
        },
        [applySelection, updateSearchParams],
    );

    // The browser's back and forward buttons change the URL's item; follow them the way a
    // click would, unless a copy write is pending. Our own select updates the URL after the
    // state, so only a URL change that this hook has not seen yet counts.
    const seenUrlKey = useRef(urlItemKey);
    useEffect(() => {
        if (urlItemKey === seenUrlKey.current) return;
        seenUrlKey.current = urlItemKey;
        if (
            !current ||
            !urlItemKey ||
            urlItemKey === current.key ||
            pendingEditsRef.current ||
            boardUnsavedRef.current
        ) {
            return;
        }
        const item = items.find((i) => i.key === urlItemKey);
        if (item) applySelection(item);
    }, [urlItemKey, current, items, applySelection]);

    const onMarkedDone = useCallback((entry: TimelineEntry) => {
        setEntries((prev) => [entry, ...prev]);
    }, []);

    const done = useMemo(() => doneKeys(entries, taskId), [entries, taskId]);
    const workedOn = useMemo(() => new Set(copies?.keys() ?? []), [copies]);

    const loadedGameRef = useRef(loadedGame);
    loadedGameRef.current = loadedGame;
    const copyGameRef = useRef(copyGame);
    copyGameRef.current = copyGame;
    // A save's response updates the game it was for, and only that one. A late response for
    // the game the student left must not take over the one now on the board. The version
    // moves with it, since a settings save does not touch the ref itself.
    const onUpdateGame = useCallback(
        (g: Game) => {
            const loaded = loadedGameRef.current;
            if (loaded && sameGame(loaded.game, g)) {
                versionRef(loaded.key).current = g.updatedAt;
                setLoadedGame({ ...loaded, game: { ...g, pgn: loaded.game.pgn } });
            }
            const copy = copyGameRef.current;
            if (copy && sameGame(copy, g)) {
                const key = machine.current.key;
                if (key) versionRef(key).current = g.updatedAt;
                machine.current.updatedAt = g.updatedAt;
                setCopyGame({ ...g, pgn: copy.pgn });
            }
        },
        [versionRef],
    );

    const board = useMemo<StudyBoard | undefined>(() => {
        if (!current) return undefined;
        if (savedKey) {
            if (loadedGame?.key !== current.key) return undefined;
            const game = loadedGame.game;
            return {
                key: current.key,
                pgn: game.pgn,
                orientation: game.orientation ?? 'white',
                context: {
                    game,
                    onUpdateGame,
                    isOwner: true,
                    updatedAtRef: versionRef(current.key),
                    setHasUnsavedGameChanges: onBoardUnsaved,
                },
                disableExport: false,
            };
        }
        if (current.kind !== 'canonical') return undefined;
        const context: GameContextType = copyGame
            ? {
                  game: copyGame,
                  onUpdateGame,
                  isOwner: true,
                  updatedAtRef: versionRef(current.key),
                  setHasUnsavedGameChanges: onBoardUnsaved,
              }
            : { isOwner: true, unsaved: true, silentUnsaved: true };
        return {
            key: current.key,
            pgn: current.pgn,
            orientation: current.orientation,
            context,
            disableExport: !current.allowExport,
        };
    }, [current, savedKey, loadedGame, copyGame, onUpdateGame, onBoardUnsaved, versionRef]);

    if (authStatus === AuthStatus.Loading || !user) {
        return { status: 'loading' };
    }
    if (!task) {
        if (requirementsRequest.isSent() && !requirementsRequest.isLoading()) {
            return { status: 'error', error: new Error('Task not found') };
        }
        return { status: 'loading' };
    }
    if (bookState.status === 'loading') return { status: 'loading' };
    if (bookState.status === 'error') return { status: 'error', error: bookState.error };
    if (bookState.status === 'no-material') return { status: 'no-material', task };
    if (bookState.status === 'blocked')
        return { status: 'blocked', task, course: bookState.course };
    if (items.length === 0) return { status: 'empty', task, book: bookState.book };
    if (!current) return { status: 'loading' };

    const cohort = taskCohort(task, user);
    const progress = user.progress[task.id];
    return {
        status: 'ready',
        task,
        cohort,
        progress,
        currentCount: getCurrentCount({ cohort, requirement: task, progress, timeline: entries }),
        totalCount: task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0,
        book: bookState.book,
        current,
        select,
        done,
        workedOn,
        historyComplete,
        pendingEdits,
        onBoardUnsaved,
        copyRequest,
        board,
        onBoardInitialize,
        onMarkedDone,
    };
}
