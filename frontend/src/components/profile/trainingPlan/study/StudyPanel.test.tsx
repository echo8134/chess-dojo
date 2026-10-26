import { Clock } from '@/components/timer/clock';
import { Timer, TimerContext } from '@/components/timer/TimerContext';
import { Requirement } from '@/database/requirement';
import { renderWithIntl } from '@/i18n/intl.test';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StudyBook, StudyItem } from './book';
import { StudyPanel, StudyPanelProps } from './StudyPanel';
import { StudySessionState } from './useStudy';

vi.mock('@/board/pgn/pgnText/PgnText', () => ({
    UnderboardPgnText: () => <div data-testid='pgn-text' />,
}));

const item = (key: string, name: string): StudyItem => ({
    kind: 'canonical',
    key,
    name,
    pgn: '',
    orientation: 'white',
    allowExport: false,
});
const first = item('k1', 'Problem 7');
const second = item('k2', 'Problem 8');
const book: StudyBook = {
    title: 'Polgar',
    chapters: [{ name: 'Problems', items: [first, second] }],
    skipped: 0,
};

const timer = {
    isRunning: false,
    isPaused: false,
    clock: { kind: 'idle' },
    timerSeconds: 0,
    onStart: vi.fn(),
    onPause: vi.fn(),
} as unknown as Timer;

const session = {
    task: { id: 'polgar' },
    timer: { kind: 'attached', pausedBy: 'nobody' },
    timerKept: false,
} as StudySessionState;
/** A session whose clock is elsewhere, with the handlers the banner calls. */
const elsewhere = (timer: StudySessionState['timer'], timerKept = false) =>
    ({
        ...session,
        timer,
        timerKept,
        switchTimer: vi.fn().mockResolvedValue(undefined),
        keepTimer: vi.fn(),
        takeOverTimer: vi.fn().mockResolvedValue(undefined),
    }) as StudySessionState;

function renderPanel(overrides: Partial<StudyPanelProps> = {}, timerValue = timer) {
    const props: StudyPanelProps = {
        book,
        current: first,
        session,
        hasCopy: false,
        isDone: false,
        solveStatus: { kind: 'prompt', toMove: 'white' },
        mark: { canUndo: false, saving: false, onUndo: vi.fn() },
        onMarkDone: vi.fn(),
        onSelect: vi.fn(),
        onSetMode: vi.fn(),
        ...overrides,
    };
    const tree = (p: StudyPanelProps) => (
        <TimerContext.Provider value={timerValue}>
            <StudyPanel {...p} />
        </TimerContext.Provider>
    );
    const view = renderWithIntl(tree(props));
    return {
        props,
        rerender: (more: Partial<StudyPanelProps>) => view.rerender(tree({ ...props, ...more })),
    };
}

afterEach(cleanup);

describe('StudyPanel and the Next arrow', () => {
    const third = item('k3', 'Problem 9');
    const longer: StudyBook = {
        ...book,
        chapters: [{ name: 'Problems', items: [first, second, third] }],
    };

    it('sends Next past an item already done, and to the plain neighbour when none is done', () => {
        const { props } = renderPanel({
            book: longer,
            session: { ...session, done: new Set(['k2']) },
        });
        fireEvent.click(screen.getByTestId('study-next'));
        expect(props.onSelect).toHaveBeenCalledWith(third);

        const plain = renderPanel({ book: longer, session: { ...session, done: new Set() } });
        fireEvent.click(screen.getAllByTestId('study-next')[1]);
        expect(plain.props.onSelect).toHaveBeenCalledWith(second);
    });

    it('sends the primary Next after a mark past an item already done as well', () => {
        const { props } = renderPanel({
            book: longer,
            solveStatus: undefined,
            isDone: true,
            mark: { canUndo: true, saving: false, onUndo: vi.fn() },
            session: { ...session, done: new Set(['k1', 'k2']) },
        });
        fireEvent.click(screen.getByTestId('study-mark-next'));
        expect(props.onSelect).toHaveBeenCalledWith(third);
    });
});

describe('StudyPanel in solve mode', () => {
    it('shows the side to move and Show solution instead of the move list, with Done off', () => {
        const { props } = renderPanel();
        expect(screen.getByText('White to move')).toBeVisible();
        expect(screen.queryByTestId('pgn-text')).toBeNull();
        expect(screen.getByTestId('study-mark-done')).toBeDisabled();
        expect(screen.getByTestId('study-next')).toBeEnabled();
        fireEvent.click(screen.getByTestId('study-show-solution'));
        expect(props.onSetMode).toHaveBeenCalledWith('read');
    });

    it("shows the author's feedback after a wrong move", () => {
        renderPanel({
            solveStatus: { kind: 'wrong', toMove: 'black', feedback: 'The king slips away.' },
        });
        expect(screen.getByText('Black to move')).toBeVisible();
        expect(screen.getByText('The king slips away.')).toBeVisible();
        expect(screen.getByTestId('study-mark-done')).toBeDisabled();
    });

    it('keeps Done off while the solve is posting and offers it once the post failed', () => {
        renderPanel({
            solveStatus: { kind: 'complete' },
            mark: { canUndo: false, saving: true, onUndo: vi.fn() },
        });
        expect(screen.getByTestId('study-mark-done')).toBeDisabled();
        cleanup();

        const { props } = renderPanel({ solveStatus: { kind: 'complete' } });
        expect(screen.getByTestId('study-solve-card')).toHaveTextContent(/^Solved\.$/);
        expect(screen.getByTestId('study-mark-done')).toBeEnabled();
        expect(screen.queryByTestId('study-mark-next')).toBeNull();
        fireEvent.click(screen.getByTestId('study-mark-done'));
        expect(props.onMarkDone).toHaveBeenCalledTimes(1);
    });

    it('swaps Done for Undo and makes Next primary once solved and marked, with only the status on the card', () => {
        const onUndo = vi.fn();
        const { props } = renderPanel({
            isDone: true,
            solveStatus: { kind: 'complete' },
            mark: { canUndo: true, saving: false, onUndo },
        });
        expect(screen.getByTestId('study-solve-card')).toHaveTextContent(/^Solved\.$/);
        expect(screen.queryByTestId('study-mark-done')).toBeNull();
        fireEvent.click(screen.getByTestId('study-undo-mark'));
        expect(onUndo).toHaveBeenCalledTimes(1);
        const next = screen.getByTestId('study-mark-next');
        expect(next).toHaveClass('MuiButton-contained');
        fireEvent.click(next);
        expect(props.onSelect).toHaveBeenCalledWith(second);
    });

    it('keeps Undo in the footer when the member comes back to an item they solved', () => {
        const onUndo = vi.fn();
        renderPanel({ isDone: true, mark: { canUndo: true, saving: false, onUndo } });
        expect(screen.getByText('White to move')).toBeVisible();
        expect(screen.queryByTestId('study-mark-done')).toBeNull();
        expect(screen.getByTestId('study-mark-next')).toHaveClass('MuiButton-contained');
        fireEvent.click(screen.getByTestId('study-undo-mark'));
        expect(onUndo).toHaveBeenCalledTimes(1);
    });

    it('flips the mode from the footer switch', () => {
        const { props } = renderPanel();
        fireEvent.click(screen.getByTestId('study-mode-read'));
        expect(props.onSetMode).toHaveBeenCalledWith('read');
    });
});

describe('StudyPanel in read mode', () => {
    it('keeps the move list and Prev, Done, Next before a mark', () => {
        const { props } = renderPanel({ solveStatus: undefined });
        expect(screen.getByTestId('pgn-text')).toBeInTheDocument();
        expect(screen.queryByTestId('study-solve-card')).toBeNull();
        expect(screen.getByTestId('study-prev')).toBeDisabled();
        expect(screen.getByTestId('study-mark-done')).toBeEnabled();
        expect(screen.getByTestId('study-next')).toBeEnabled();
        expect(screen.queryByTestId('study-undo-mark')).toBeNull();
        expect(screen.queryByTestId('study-mark-next')).toBeNull();
        fireEvent.click(screen.getByTestId('study-mode-solve'));
        expect(props.onSetMode).toHaveBeenCalledWith('solve');
    });

    it('keeps Done off while the mark posts', () => {
        renderPanel({
            solveStatus: undefined,
            mark: { canUndo: false, saving: true, onUndo: vi.fn() },
        });
        expect(screen.getByTestId('study-mark-done')).toBeDisabled();
        expect(screen.queryByTestId('study-undo-mark')).toBeNull();
    });

    it('swaps Done for Undo and makes Next the primary action once marked', () => {
        const onUndo = vi.fn();
        const { props } = renderPanel({
            solveStatus: undefined,
            isDone: true,
            mark: { canUndo: true, saving: false, onUndo },
        });
        expect(screen.getByTestId('pgn-text')).toBeInTheDocument();
        expect(screen.queryByTestId('study-mark-done')).toBeNull();
        expect(screen.queryByTestId('study-next')).toBeNull();
        fireEvent.click(screen.getByTestId('study-undo-mark'));
        expect(onUndo).toHaveBeenCalledTimes(1);
        const next = screen.getByTestId('study-mark-next');
        expect(next).toHaveClass('MuiButton-contained');
        expect(next).toHaveTextContent('Next');
        fireEvent.click(next);
        expect(props.onSelect).toHaveBeenCalledWith(second);
    });

    it('keeps Undo off while the undo posts', () => {
        renderPanel({
            solveStatus: undefined,
            isDone: true,
            mark: { canUndo: true, saving: true, onUndo: vi.fn() },
        });
        expect(screen.getByTestId('study-undo-mark')).toBeDisabled();
        expect(screen.getByTestId('study-mark-next')).toBeEnabled();
    });

    it('offers Undo with the chevron still off on the last item', () => {
        renderPanel({
            current: second,
            solveStatus: undefined,
            isDone: true,
            mark: { canUndo: true, saving: false, onUndo: vi.fn() },
        });
        expect(screen.getByTestId('study-undo-mark')).toBeEnabled();
        expect(screen.queryByTestId('study-mark-next')).toBeNull();
        expect(screen.getByTestId('study-next')).toBeDisabled();
    });

    it('brings Done and the chevron back once the mark is undone', () => {
        const { rerender } = renderPanel({
            solveStatus: undefined,
            isDone: true,
            mark: { canUndo: true, saving: false, onUndo: vi.fn() },
        });
        expect(screen.getByTestId('study-undo-mark')).toBeVisible();
        rerender({ isDone: false, mark: { canUndo: false, saving: false, onUndo: vi.fn() } });
        expect(screen.queryByTestId('study-undo-mark')).toBeNull();
        expect(screen.queryByTestId('study-mark-next')).toBeNull();
        expect(screen.getByTestId('study-mark-done')).toBeEnabled();
        expect(screen.getByTestId('study-next')).toBeEnabled();
    });
});

describe('StudyPanel timer', () => {
    const onPolgarM3: Clock = { kind: 'running', taskId: 'polgar-m3', base: 0, since: 0 };
    const polgarM3 = {
        id: 'polgar-m3',
        name: 'Solve Polgar M3s through Problem {{count}}',
        shortName: 'Polgar M3s',
        sortPriority: '0',
    } as Requirement;
    const foreign: StudySessionState['timer'] = { kind: 'foreign' };
    const handedOff: StudySessionState['timer'] = { kind: 'handed-off' };
    const noFooterClock = () => {
        expect(screen.queryByTestId('study-pause-timer')).toBeNull();
        expect(screen.queryByTestId('study-start-timer')).toBeNull();
    };

    it('asks whether to log the other task and time this one, naming the task as the navbar does', () => {
        const s = elsewhere(foreign);
        renderPanel(
            { session: s },
            { ...timer, isRunning: true, clock: onPolgarM3, task: polgarM3, timerSeconds: 1_395 },
        );
        expect(screen.getByTestId('study-timer-other')).toHaveTextContent(
            'Timer on another taskYour timer is on Polgar M3s with 23m. This task is not being timed.',
        );
        expect(screen.getByTestId('study-timer-switch')).toHaveTextContent(
            /^Log 23m and time this task$/,
        );
        expect(screen.getByTestId('study-timer-keep')).toHaveTextContent(
            /^Keep timing Polgar M3s$/,
        );
        noFooterClock();
        fireEvent.click(screen.getByTestId('study-timer-keep'));
        expect(s.keepTimer).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByTestId('study-timer-switch'));
        expect(s.switchTimer).toHaveBeenCalledTimes(1);
    });

    it('shows hours once the other task has them', () => {
        renderPanel(
            { session: elsewhere(foreign) },
            { ...timer, isRunning: true, clock: onPolgarM3, task: polgarM3, timerSeconds: 3_900 },
        );
        expect(screen.getByTestId('study-timer-other')).toHaveTextContent(
            'Your timer is on Polgar M3s with 1h 5m.',
        );
    });

    it('calls the other task "another task" before it has loaded', () => {
        renderPanel(
            { session: elsewhere(foreign) },
            { ...timer, isRunning: true, clock: onPolgarM3, timerSeconds: 120 },
        );
        expect(screen.getByTestId('study-timer-other')).toHaveTextContent(
            'Your timer is on another task with 2m.',
        );
        expect(screen.getByTestId('study-timer-keep')).toHaveTextContent(
            /^Keep timing another task$/,
        );
    });

    it('offers a plain switch under one minute', () => {
        const s = elsewhere(foreign);
        renderPanel(
            { session: s },
            { ...timer, isRunning: true, clock: onPolgarM3, task: polgarM3, timerSeconds: 40 },
        );
        expect(screen.getByTestId('study-timer-other')).toHaveTextContent(
            'Your timer is on Polgar M3s. This task is not being timed.',
        );
        expect(screen.getByTestId('study-timer-switch')).toHaveTextContent(
            /^Time this task instead$/,
        );
        fireEvent.click(screen.getByTestId('study-timer-switch'));
        expect(s.switchTimer).toHaveBeenCalledTimes(1);
    });

    it('takes one switch at a time and reports a failed one', async () => {
        const s = elsewhere(foreign);
        let reject!: (reason: unknown) => void;
        vi.mocked(s.switchTimer).mockReturnValue(
            new Promise<void>((_, rej) => {
                reject = rej;
            }),
        );
        renderPanel(
            { session: s },
            { ...timer, isRunning: true, clock: onPolgarM3, task: polgarM3, timerSeconds: 1_395 },
        );
        fireEvent.click(screen.getByTestId('study-timer-switch'));
        expect(screen.getByTestId('study-timer-switch')).toBeDisabled();
        fireEvent.click(screen.getByTestId('study-timer-switch'));
        expect(s.switchTimer).toHaveBeenCalledTimes(1);
        await act(async () => {
            reject(new Error('offline'));
            await Promise.resolve();
        });
        expect(screen.getByTestId('study-timer-switch')).toBeEnabled();
        expect(screen.getByTestId('error-snackbar')).toHaveTextContent('offline');
    });

    it('shows nothing for the clock once the member keeps timing the other task', () => {
        renderPanel(
            { session: elsewhere(foreign, true) },
            { ...timer, isRunning: true, clock: onPolgarM3, task: polgarM3, timerSeconds: 1_395 },
        );
        expect(screen.queryByTestId('study-timer-other')).toBeNull();
        noFooterClock();
        expect(screen.getByTestId('study-mark-done')).toBeInTheDocument();
    });

    it('says the timing moved to another tab and offers to take it back', () => {
        const s = elsewhere(handedOff);
        const onPolgar: Clock = { kind: 'running', taskId: 'polgar', base: 0, since: 0 };
        renderPanel(
            { session: s },
            { ...timer, isRunning: true, clock: onPolgar, timerSeconds: 90 },
        );
        expect(screen.getByTestId('study-timer-moved')).toHaveTextContent(
            'Timing moved to another tabAnother tab opened this task and has the timer now. This tab is not being timed.',
        );
        noFooterClock();
        expect(screen.queryByTestId('study-timer-other')).toBeNull();
        fireEvent.click(screen.getByTestId('study-timer-take'));
        expect(s.takeOverTimer).toHaveBeenCalledTimes(1);
    });

    it('offers to pause a clock running without a task', () => {
        const taskless: Clock = { kind: 'running', taskId: '', base: 0, since: 0 };
        renderPanel({}, { ...timer, isRunning: true, clock: taskless, timerSeconds: 45 });
        expect(screen.getByTestId('study-pause-timer')).toHaveTextContent('00:45');
        expect(screen.queryByText(/^The timer is running on/)).toBeNull();
    });

    it('offers to resume a clock paused on this task', () => {
        const onPolgar: Clock = { kind: 'paused', taskId: 'polgar', seconds: 90 };
        renderPanel({}, { ...timer, clock: onPolgar, timerSeconds: 90 });
        expect(screen.getByTestId('study-start-timer')).toHaveTextContent('01:30');
        expect(screen.queryByText(/^The timer is running on/)).toBeNull();
    });
});
