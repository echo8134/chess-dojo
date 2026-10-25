import { EventType as AnalyticsEvent, trackEvent } from '@/analytics/events';
import { useApi } from '@/api/Api';
import { useRequirements } from '@/api/cache/requirements';
import { isGame } from '@/api/gameApi';
import { Request, useRequest } from '@/api/Request';
import { AuthStatus, useAuth } from '@/auth/Auth';
import { BoardApi } from '@/board/Board';
import { GameContextType } from '@/context/useGame';
import { Course } from '@/database/course';
import { Game, GameKey } from '@/database/game';
import {
    CustomTask,
    getCurrentCount,
    isRequirement,
    Requirement,
    TaskMaterial,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { ALL_COHORTS, User } from '@/database/user';
import { useNextSearchParams } from '@/hooks/useNextSearchParams';
import { Chess, Event, EventType } from '@jackstenglein/chess';
import { GameImportTypes } from '@jackstenglein/chess-dojo-common/src/database/game';
import { DateTime } from 'luxon';
import { MutableRefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    CanonicalItem,
    concatBooks,
    courseBook,
    directoryBook,
    itemsOf,
    sliceBook,
    StudyBook,
    StudyItem,
} from './book';
import { copyHeaders, exportAllowed, findCopies, studyStamp } from './copies';
import { loadCourse } from './courseCache';
import {
    bookMapping,
    BookMapping,
    chooseCurrent,
    cohortSlice,
    countsItems,
    dayEntry,
    doneKeys,
    editDayEntry,
    pointerDone,
    presetMode,
    resolveMode,
    StudyMode,
    taskCohort,
    taskTitle,
} from './selectors';
import { Session } from './timerSession';
import { useTimerSession } from './useTimerSession';

export type { StudyMode } from './selectors';

export type StudyTask = Requirement | CustomTask;

/**
 * A task with study material or a standalone course. An explicit cohort opens the task's
 * material in browse mode, without a progress session.
 */
export type StudySource =
    | { kind: 'task'; taskId: string; cohort?: string }
    | { kind: 'course'; courseType: string; courseId: string };

export type StudyState =
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'no-material'; task: StudyTask }
    | { status: 'blocked'; course: Course }
    | { status: 'empty'; book: StudyBook }
    | StudyReady;

/** Task progress and completion controls. Absent in browse mode. */
export interface StudySessionState {
    task: StudyTask;
    cohort: string;
    currentCount: number;
    totalCount: number;
    /** Maps book items to progress counts and supplies the displayed unit. */
    mapping: BookMapping;
    done: Set<string>;
    historyComplete: boolean;
    /** The reader's hold on the work timer. */
    timer: Session;
    /**
     * Posts the item as done with the timer's minutes. The count rises by one when the item is
     * the unit and stays where it is otherwise. The day's first mark creates the entry and later
     * marks grow it, so a sitting is one card in the feed. With `stop`, as from the Done button,
     * the clock stops with the remainder until another game of the task opens. A solve the board
     * marks leaves it running.
     */
    markItemDone: (item: StudyItem, opts?: { stop?: boolean }) => Promise<void>;
    /**
     * Reverts the last mark when it is the given item's, by taking the item out of its entry
     * and counting the progress back down. The minutes stay logged, and a clock that Done
     * stopped starts again. Does nothing once a later mark has replaced it.
     */
    undoMark: (itemKey: string) => Promise<void>;
    /** True while the last mark belongs to the current item. */
    canUndo: boolean;
}

export interface StudyReady {
    status: 'ready';
    session?: StudySessionState;
    book: StudyBook;
    current: StudyItem;
    /** Returns false while the current item has unsaved edits. */
    select: (item: StudyItem) => boolean;
    /** Overrides the item's preset mode for this session. Returns false while edits are unsaved. */
    setMode: (item: StudyItem, kind: StudyMode['kind']) => boolean;
    workedOn: Set<string>;
    /** True from the first edit of a canonical game until its copy holds every edit. */
    pendingEdits: boolean;
    /** The board reports its own unsaved edits here; selecting another item waits for them. */
    onBoardUnsaved: (unsaved: boolean) => void;
    copyRequest: Request;
    board?: StudyBoard;
    onBoardInitialize: (board: BoardApi, chess: Chess) => void;
}

/** Board props for the selected item. The context updates when a copy is saved. */
export interface StudyBoard {
    /** Changes with the item and with its mode, so the board remounts on either. */
    key: string;
    /** The item's PGN as loaded. */
    pgn: string;
    /**
     * The PGN for a board that mounts now. It is the game on the item's last read board, with
     * every edit since the load, or pgn when no read board has mounted for the item yet. A board
     * reloads whenever its PGN changes, so a pane reads this once, when it mounts.
     */
    latestPgn: () => string;
    mode: StudyMode;
    orientation: 'white' | 'black';
    context: GameContextType;
    disableExport: boolean;
}

type CopyPhase = 'canonical' | 'creating' | 'reconciling' | 'copyPending' | 'copy';

interface CopyMachine {
    phase: CopyPhase;
    dirty: boolean;
    /** Identifies the item whose version ref this copy updates. */
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

/** What Undo needs to revert a mark. */
interface LastMark {
    itemKey: string;
    entryId: string;
    /** Whether the mark raised the count. A mark at the target or on a book in pages does not. */
    counted: boolean;
}

/** One material entry, loaded. */
type BookPart =
    | { kind: 'blocked'; course: Course }
    | { kind: 'course'; book: StudyBook }
    | { kind: 'folder'; book: StudyBook };

type BookState =
    | { status: 'loading' }
    | { status: 'error'; error: unknown }
    | { status: 'no-material' }
    | { status: 'blocked'; course: Course }
    | { status: 'ready'; book: StudyBook; needsCopies: boolean };

export function useStudy(source: StudySource, urlItemKey: string | null): StudyState {
    const api = useApi();
    const { user, status: authStatus, updateUser } = useAuth();
    const { requirements, request: requirementsRequest } = useRequirements(ALL_COHORTS, false);
    const { updateSearchParams } = useNextSearchParams();
    const copyRequest = useRequest();

    const taskId = source.kind === 'task' ? source.taskId : undefined;
    // An explicit cohort disables timeline loading and the progress session.
    const sessionTaskId = source.kind === 'task' && !source.cohort ? source.taskId : undefined;
    const task = useMemo<StudyTask | undefined>(
        () =>
            taskId
                ? (user?.customTasks?.find((t) => t.id === taskId) ??
                  requirements.find((r) => r.id === taskId))
                : undefined,
        [user?.customTasks, requirements, taskId],
    );
    // The key is the material's content, so a refreshed user record does not rebuild the book
    // or remount the board.
    const materialKey = JSON.stringify(
        source.kind === 'course'
            ? [{ kind: 'COURSE', courseType: source.courseType, courseId: source.courseId }]
            : (task?.material ?? []),
    );
    const materials = useMemo(() => JSON.parse(materialKey) as TaskMaterial[], [materialKey]);
    const cohort =
        task && user ? (source.kind === 'task' && source.cohort) || taskCohort(task, user) : '';
    const bookTitle = task ? taskTitle(task, cohort) : undefined;
    const hasSource = source.kind === 'course' || !!task;

    const [bookState, setBookState] = useState<BookState>({ status: 'loading' });
    const [copies, setCopies] = useState<Map<string, GameKey>>();
    const [entries, setEntries] = useState<TimelineEntry[]>([]);
    // A queued mark grows the entry the mark before it wrote, and state shows that entry only
    // after a render.
    const entriesRef = useRef<TimelineEntry[]>([]);
    const commitEntries = useCallback((update: (prev: TimelineEntry[]) => TimelineEntry[]) => {
        entriesRef.current = update(entriesRef.current);
        setEntries(entriesRef.current);
    }, []);
    const [historyComplete, setHistoryComplete] = useState(false);
    const [current, setCurrent] = useState<StudyItem>();
    const [loadedGame, setLoadedGame] = useState<{ key: string; game: Game }>();
    const [copyGame, setCopyGame] = useState<Game>();
    // Keep a newly created copy on the current board until the item is reselected.
    const [sessionCopyKey, setSessionCopyKey] = useState<string>();
    const [pendingEdits, setPendingEdits] = useState(false);
    const [overrides, setOverrides] = useState(() => new Map<string, StudyMode['kind']>());
    const [lastMark, setLastMark] = useState<LastMark>();
    // A queued undo reads the mark that ran before it, and state shows that mark only after a render.
    const lastMarkRef = useRef<LastMark | undefined>(undefined);
    const rememberMark = useCallback((mark: LastMark | undefined) => {
        lastMarkRef.current = mark;
        setLastMark(mark);
    }, []);
    const pendingEditsRef = useRef(false);
    pendingEditsRef.current = pendingEdits;
    // Edits the board holds for a saved game, pending its auto-save or left over from a failed one.
    const boardUnsavedRef = useRef(false);
    const onBoardUnsaved = useCallback((unsaved: boolean) => {
        boardUnsavedRef.current = unsaved;
    }, []);
    // Timer and progress updates rebuild the API object. Read it through a ref so those
    // updates do not reload the book.
    const apiRef = useRef(api);
    apiRef.current = api;
    // Keep a version ref for each item so a late save response updates the correct game.
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

    // Load and combine material entries in their configured order.
    useEffect(() => {
        if (!hasSource || !username) {
            return;
        }
        if (materials.length === 0) {
            setBookState({ status: 'no-material' });
            return;
        }
        let cancelled = false;
        setBookState({ status: 'loading' });
        const load = async () => {
            const parts = await Promise.all(
                materials.map(async (material): Promise<BookPart> => {
                    if (material.kind === 'COURSE') {
                        const data = await loadCourse(
                            apiRef.current,
                            material.courseType,
                            material.courseId,
                        );
                        if (data.isBlocked || !data.course) {
                            return { kind: 'blocked', course: data.course };
                        }
                        return { kind: 'course', book: courseBook(data.course) };
                    }
                    const resp = await apiRef.current.getDirectory(
                        material.owner,
                        material.directoryId,
                    );
                    return {
                        kind: 'folder',
                        book: await directoryBook(resp.data.directory, username),
                    };
                }),
            );
            if (cancelled) return;
            const books: StudyBook[] = [];
            for (const part of parts) {
                if (part.kind === 'blocked') {
                    setBookState({ status: 'blocked', course: part.course });
                    return;
                }
                books.push(part.book);
            }
            setBookState({
                status: 'ready',
                book: concatBooks(bookTitle ?? books[0].title, books),
                needsCopies: parts.some((part) => part.kind === 'course'),
            });
        };
        load().catch((error: unknown) => {
            if (!cancelled) setBookState({ status: 'error', error });
        });
        return () => {
            cancelled = true;
        };
    }, [hasSource, materials, bookTitle, username]);

    // Search all pages of the student's games for working copies.
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

    // Load timeline pages in the background to collect completion marks. Skip this in browse mode.
    useEffect(() => {
        if (!username || !sessionTaskId) {
            return;
        }
        let cancelled = false;
        commitEntries(() => []);
        setHistoryComplete(false);
        const load = async () => {
            let startKey: string | undefined;
            do {
                const resp = await apiRef.current.listUserTimeline(username, startKey);
                if (cancelled) return;
                commitEntries((prev) => [...prev, ...resp.entries]);
                startKey = resp.lastEvaluatedKey || undefined;
            } while (startKey);
            setHistoryComplete(true);
        };
        // When the load fails, stop waiting and use the marks read so far; the page must still open.
        load().catch(() => {
            if (!cancelled) setHistoryComplete(true);
        });
        return () => {
            cancelled = true;
        };
    }, [username, sessionTaskId, commitEntries]);

    const allItems = useMemo(
        () => (bookState.status === 'ready' ? itemsOf(bookState.book) : []),
        [bookState],
    );
    const mapping = useMemo(
        () =>
            task ? bookMapping(task, allItems.length) : { mapped: false, startCount: 0, unit: '' },
        [task, allItems.length],
    );
    // In task mode the reader shows the cohort's share of the book and nothing past its target.
    const items = useMemo(
        () => (task ? cohortSlice(allItems, task, cohort, mapping) : allItems),
        [allItems, task, cohort, mapping],
    );
    const book = useMemo(
        () => (bookState.status === 'ready' ? sliceBook(bookState.book, items) : undefined),
        [bookState, items],
    );
    const progress = task && user ? user.progress[task.id] : undefined;
    const currentCount = useMemo(
        () =>
            task ? getCurrentCount({ cohort, requirement: task, progress, timeline: entries }) : 0,
        [task, cohort, progress, entries],
    );
    const marks = useMemo(() => doneKeys(entries, sessionTaskId ?? ''), [entries, sessionTaskId]);
    // The count covers items the marks do not explain, and the earliest unmarked items stand
    // in for them.
    const passed = useMemo(
        () => pointerDone(items, currentCount, mapping, marks),
        [items, currentCount, mapping, marks],
    );
    const done = useMemo(() => new Set([...marks, ...passed]), [marks, passed]);

    // Choose the initial item once the book, the copies and, in a session, the done marks have
    // loaded. Keep its key so that Back to a URL without an item returns to it.
    const initialKeyRef = useRef<string | undefined>(undefined);
    useEffect(() => {
        if (current || items.length === 0 || !copies || (sessionTaskId && !historyComplete)) {
            return;
        }
        const chosen = chooseCurrent(items, urlItemKey, copies, done);
        initialKeyRef.current = chosen?.key;
        setCurrent(chosen);
    }, [current, items, copies, urlItemKey, done, sessionTaskId, historyComplete]);

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

    const {
        session: timer,
        peek,
        commit,
        reopen,
    } = useTimerSession(sessionTaskId, bookState.status === 'ready' && !!task && !!sessionTaskId);

    // Track copy creation and follow-up saves for the selected canonical item.
    const machine = useRef<CopyMachine>({ phase: 'canonical', dirty: false });
    const chessRef = useRef<Chess>(null);
    const currentRef = useRef<StudyItem>(undefined);
    currentRef.current = current;
    // Let the board save copies loaded from the server.
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
                // All copy writes have finished. The board can now autosave subsequent edits.
                if (m.key) versionRef(m.key).current = m.updatedAt;
                m.phase = 'copy';
                setCopyGame({ ...m.game, pgn: m.lastWritten ?? m.game.pgn });
                setPendingEdits(false);
                copyRequest.onSuccess();
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

    // Marks, undos and the clock starts that follow them run one after another. Marks post
    // absolute counts, so each waits for the one requested before it, and a start waits for the
    // stop of a Done still posting.
    const markQueue = useRef<Promise<unknown>>(Promise.resolve());
    const enqueue = useCallback((step: () => Promise<void>) => {
        const run = markQueue.current.then(step, step);
        markQueue.current = run;
        return run;
    }, []);

    const applySelection = useCallback(
        (item: StudyItem) => {
            machine.current = { phase: 'canonical', dirty: false };
            chessRef.current = null;
            boardUnsavedRef.current = false;
            setCopyGame(undefined);
            setSessionCopyKey(undefined);
            setLoadedGame(undefined);
            setPendingEdits(false);
            setCurrent(item);
            // Opening any game of the task is working on the task again, so a stop from Done lifts.
            void enqueue(reopen);
        },
        [enqueue, reopen],
    );

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

    // Follow browser history changes unless edits are pending. Selection updates state before
    // the URL, so ignore URL values this hook has already processed.
    const seenUrlKey = useRef(urlItemKey);
    useEffect(() => {
        if (urlItemKey === seenUrlKey.current) return;
        seenUrlKey.current = urlItemKey;
        const targetKey = urlItemKey ?? initialKeyRef.current;
        if (
            !current ||
            !targetKey ||
            targetKey === current.key ||
            pendingEditsRef.current ||
            boardUnsavedRef.current
        ) {
            return;
        }
        const item = items.find((i) => i.key === targetKey);
        if (item) applySelection(item);
    }, [urlItemKey, current, items, applySelection]);

    const totalCount = task ? (task.counts[cohort] ?? task.counts[ALL_COHORTS] ?? 0) : 0;
    // Refresh the count because the progress endpoint writes an absolute value.
    // If the read fails, use this tab's progress.
    const freshCount = useCallback(async () => {
        if (!task) throw new Error('No task to mark');
        let fresh: User | undefined;
        try {
            fresh = (await apiRef.current.getUser()).data;
            updateUser(fresh);
        } catch {
            fresh = undefined;
        }
        const freshProgress = fresh ? fresh.progress[task.id] : progress;
        const count = getCurrentCount({
            cohort,
            requirement: task,
            progress: freshProgress,
            timeline: entriesRef.current,
        });
        return { progress: freshProgress, count, user: fresh };
    }, [task, cohort, progress, updateUser]);

    const postMark = useCallback(
        async (item: StudyItem, stop: boolean) => {
            if (!task) throw new Error('No task to mark');
            const { progress: fresh, count, user: freshUser } = await freshCount();
            // The count rises by one when the item is the unit, never past the target. A book
            // counted in pages records the mark and leaves the count to the member.
            const newCount = countsItems(task, mapping) && count < totalCount ? count + 1 : count;
            // The fetched record carries a pause or a task switch made on another device.
            const minutes = peek(freshUser);
            const now = DateTime.now();
            const at = now.toUTC().toISO();
            const mark = { key: item.key, name: item.name, minutes, at };
            const today = dayEntry(entriesRef.current, task.id, now);
            let entry: TimelineEntry;
            if (today) {
                const edit = editDayEntry(today, {
                    items: [...today.studyInfo.items, mark],
                    newCount,
                    minutes,
                    task,
                    cohort,
                    progress: fresh,
                    at,
                });
                await apiRef.current.updateUserTimeline({
                    requirementId: task.id,
                    progress: edit.progress,
                    updated: [edit.entry],
                    deleted: [],
                });
                entry = edit.entry;
                commitEntries((prev) => prev.map((e) => (e.id === edit.entry.id ? edit.entry : e)));
            } else {
                const resp = await apiRef.current.updateUserProgress({
                    cohort,
                    requirementId: task.id,
                    previousCount: count,
                    newCount,
                    incrementalMinutesSpent: minutes,
                    date: now,
                    notes: '',
                    studyInfo: { items: [mark] },
                });
                // A backend without the study field answers without it. The hook keeps the mark either way.
                const created = { ...resp.data.timelineEntry, studyInfo: { items: [mark] } };
                entry = created;
                commitEntries((prev) => [created, ...prev]);
            }
            trackEvent(AnalyticsEvent.UpdateProgress, {
                requirement_id: task.id,
                requirement_name: task.name,
                is_custom_requirement: !isRequirement(task),
                dojo_cohort: cohort,
                previous_count: count,
                new_count: newCount,
                incremental_minutes: minutes,
            });
            // The seconds this post did not count carry over to the next item.
            const carried = commit(minutes, { stop });
            rememberMark({ itemKey: item.key, entryId: entry.id, counted: newCount !== count });
            // The next mark refreshes the record, and it must read the clock after this deduction.
            await carried;
        },
        [task, cohort, mapping, totalCount, freshCount, peek, commit, commitEntries, rememberMark],
    );

    // One post per item. A second request while the first is queued or posting shares its result.
    const pendingMarks = useRef(new Map<string, Promise<void>>());
    const doneRef = useRef(done);
    doneRef.current = done;
    const markItemDone = useCallback(
        (item: StudyItem, { stop = false }: { stop?: boolean } = {}) => {
            if (doneRef.current.has(item.key)) return Promise.resolve();
            const pending = pendingMarks.current.get(item.key);
            if (pending) return pending;
            const mark = enqueue(() => postMark(item, stop)).finally(() =>
                pendingMarks.current.delete(item.key),
            );
            pendingMarks.current.set(item.key, mark);
            return mark;
        },
        [enqueue, postMark],
    );

    const undoMark = useCallback(
        (itemKey: string) =>
            enqueue(async () => {
                // A mark queued behind the click may have become the last one by now.
                const last = lastMarkRef.current;
                if (!task || last?.itemKey !== itemKey) return;
                const entry = entriesRef.current.find((e) => e.id === last.entryId);
                if (!entry) return;
                const { progress: fresh } = await freshCount();
                const items = (entry.studyInfo?.items ?? []).filter((i) => i.key !== itemKey);
                // The time was still spent, so only the item and its count leave the entry.
                const newCount = last.counted ? entry.newCount - 1 : entry.newCount;
                const edit = editDayEntry(entry, {
                    items,
                    newCount,
                    minutes: 0,
                    task,
                    cohort,
                    progress: fresh,
                    at: DateTime.now().toUTC().toISO(),
                });
                await apiRef.current.updateUserTimeline({
                    requirementId: task.id,
                    progress: edit.progress,
                    updated: [edit.entry],
                    deleted: [],
                });
                commitEntries((prev) => prev.map((e) => (e.id === edit.entry.id ? edit.entry : e)));
                rememberMark(undefined);
                await reopen();
            }),
        [enqueue, task, cohort, freshCount, commitEntries, rememberMark, reopen],
    );

    const setMode = useCallback((item: StudyItem, kind: StudyMode['kind']) => {
        if (pendingEditsRef.current || boardUnsavedRef.current) {
            return false;
        }
        setOverrides((prev) => new Map(prev).set(item.key, kind));
        return true;
    }, []);

    const workedOn = useMemo(() => new Set(copies?.keys() ?? []), [copies]);

    const loadedGameRef = useRef(loadedGame);
    loadedGameRef.current = loadedGame;
    const copyGameRef = useRef(copyGame);
    copyGameRef.current = copyGame;
    // Match save responses to the loaded game before applying them. Update its version ref
    // here because settings saves do not update that ref.
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
        const modeFor = (pgn: string) => resolveMode(presetMode(pgn), overrides.get(current.key));
        // applySelection clears chessRef when the item changes, so chessRef holds this item's game.
        const latest = (pgn: string) => () => chessRef.current?.renderPgn() ?? pgn;
        if (savedKey) {
            if (loadedGame?.key !== current.key) return undefined;
            const game = loadedGame.game;
            const mode = modeFor(game.pgn);
            return {
                key: `${current.key}:${mode.kind}`,
                pgn: game.pgn,
                latestPgn: latest(game.pgn),
                mode,
                orientation: game.orientation ?? 'white',
                context: {
                    game,
                    onUpdateGame,
                    isOwner: true,
                    updatedAtRef: versionRef(current.key),
                    setHasUnsavedGameChanges: onBoardUnsaved,
                },
                disableExport: !exportAllowed(game.headers),
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
        const mode = modeFor(current.pgn);
        return {
            key: `${current.key}:${mode.kind}`,
            pgn: current.pgn,
            latestPgn: latest(current.pgn),
            mode,
            orientation: current.orientation,
            context,
            disableExport: !current.allowExport,
        };
    }, [
        current,
        savedKey,
        loadedGame,
        copyGame,
        overrides,
        onUpdateGame,
        onBoardUnsaved,
        versionRef,
    ]);

    if (authStatus === AuthStatus.Loading || !user) {
        return { status: 'loading' };
    }
    if (source.kind === 'task' && !task) {
        if (requirementsRequest.isSent() && !requirementsRequest.isLoading()) {
            return { status: 'error', error: new Error('Task not found') };
        }
        return { status: 'loading' };
    }
    if (bookState.status === 'loading') return { status: 'loading' };
    if (bookState.status === 'error') return { status: 'error', error: bookState.error };
    if (bookState.status === 'no-material') {
        if (!task) return { status: 'error', error: new Error('Course not found') };
        return { status: 'no-material', task };
    }
    if (bookState.status === 'blocked') return { status: 'blocked', course: bookState.course };
    if (items.length === 0 || !book) return { status: 'empty', book: bookState.book };
    if (!current) return { status: 'loading' };

    let session: StudySessionState | undefined;
    if (task && sessionTaskId && timer) {
        session = {
            task,
            cohort,
            currentCount,
            totalCount,
            mapping,
            done,
            historyComplete,
            timer,
            markItemDone,
            undoMark,
            canUndo: lastMark?.itemKey === current.key,
        };
    }
    return {
        status: 'ready',
        session,
        book,
        current,
        select,
        setMode,
        workedOn,
        pendingEdits,
        onBoardUnsaved,
        copyRequest,
        board,
        onBoardInitialize,
    };
}
