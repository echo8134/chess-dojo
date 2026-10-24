import { useRequirement } from '@/api/cache/requirements';
import { AuthStatus } from '@/auth/Auth';
import { formatTime } from '@/board/pgn/boardTools/underboard/clock/ClockUsage';
import {
    CustomTask,
    Requirement,
    RequirementCategory,
    RequirementStatus,
    ScoreboardDisplay,
} from '@/database/requirement';
import { renderWithIntl } from '@/i18n/intl.test';
import { RatingSystem, User } from '@jackstenglein/chess-dojo-common/src/database/user';
import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { use } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimerContext, TimerContextProvider, TimerControlsContext } from './TimerContext';

const apiUpdateUser = vi.fn();
const apiGetUser = vi.fn();

const authState = vi.hoisted(() => ({
    user: null as User | null,
    status: 'Authenticated' as AuthStatus,
    listeners: new Set<() => void>(),
}));

// The provider derives the clock from the user record, so an update has to re-render it the way
// AuthProvider does.
const updateUserImpl = vi.hoisted(() =>
    vi.fn((partial: Partial<User>) => {
        if (authState.user) {
            authState.user = { ...authState.user, ...partial };
            authState.listeners.forEach((notify) => notify());
        }
    }),
);

vi.mock('@/api/Api', () => ({
    useApi: () => ({ updateUser: apiUpdateUser, getUser: apiGetUser }),
}));

vi.mock('@/api/cache/requirements', () => ({
    useRequirement: vi.fn(() => ({ requirement: undefined })),
}));

vi.mock('@/auth/Auth', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/auth/Auth')>();
    const { useSyncExternalStore } = await import('react');
    const subscribe = (notify: () => void) => {
        authState.listeners.add(notify);
        return () => {
            authState.listeners.delete(notify);
        };
    };
    return {
        ...actual,
        useAuth: () => ({
            user: useSyncExternalStore(subscribe, () => authState.user),
            status: authState.status,
            updateUser: updateUserImpl,
        }),
    };
});

function makeUser(overrides: Partial<User> = {}): User {
    return {
        username: 'testuser',
        displayName: 'Test User',
        discordUsername: 'test',
        dojoCohort: '1000-1100',
        bio: '',
        ratingSystem: RatingSystem.Chesscom,
        ratings: {},
        progress: {},
        disableBookingNotifications: false,
        disableCancellationNotifications: false,
        isAdmin: false,
        isCalendarAdmin: false,
        isTournamentAdmin: false,
        isBetaTester: false,
        isCoach: false,
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        numberOfGraduations: 0,
        previousCohort: '',
        lastGraduatedAt: '',
        enableLightMode: false,
        enableZenMode: false,
        timezoneOverride: '',
        timeFormat: '24h',
        hasCreatedProfile: true,
        followerCount: 0,
        followingCount: 0,
        referralSource: '',
        ...overrides,
    } as User;
}

function TimerConsumer({ taskId, restartFrom }: { taskId?: string; restartFrom?: number }) {
    const timer = use(TimerContext);
    const taskName =
        timer.task && 'shortName' in timer.task
            ? timer.task.shortName || timer.task.name
            : timer.task?.name;
    return (
        <div>
            <span data-testid='seconds'>{timer.timerSeconds}</span>
            <span data-testid='isRunning'>{String(timer.isRunning)}</span>
            <span data-testid='isPaused'>{String(timer.isPaused)}</span>
            <span data-testid='taskName'>{taskName ?? ''}</span>
            <span data-testid='label'>{timer.getLabel(taskId)}</span>
            <button type='button' data-testid='start' onClick={() => timer.onStart(taskId)}>
                Start
            </button>
            <button type='button' data-testid='pause' onClick={() => timer.onPause(taskId)}>
                Pause
            </button>
            <button type='button' data-testid='clear' onClick={() => timer.onClear()}>
                Clear
            </button>
            <button type='button' data-testid='toggle' onClick={() => timer.onToggle(taskId)}>
                Toggle
            </button>
            <button
                type='button'
                data-testid='restart'
                onClick={() => timer.onRestart(taskId ?? '', restartFrom)}
            >
                Restart
            </button>
        </div>
    );
}

function renderTimer(taskId?: string, restartFrom?: number) {
    return renderWithIntl(
        <TimerContextProvider>
            <TimerConsumer taskId={taskId} restartFrom={restartFrom} />
        </TimerContextProvider>,
    );
}

/** Advances the fake clock and lets a renewal's fetch settle. */
const advance = (ms: number) =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });

const RUNNING_SINCE_11_59 = {
    timerSeconds: 0,
    timerStartedAt: '2026-05-27T11:59:00.000Z',
    timerTaskId: 'task-a',
};

describe('TimerContextProvider', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-05-27T12:00:00Z'));
        document.title = 'ChessDojo';
        authState.user = makeUser();
        authState.status = AuthStatus.Authenticated;
        apiUpdateUser.mockReset();
        // What the server holds in these tests is the hoisted user, unless a test says otherwise.
        apiGetUser.mockReset();
        apiGetUser.mockImplementation(() => Promise.resolve({ data: authState.user }));
        updateUserImpl.mockClear();
        vi.mocked(useRequirement).mockReturnValue({ requirement: undefined } as ReturnType<
            typeof useRequirement
        >);
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
        document.title = 'ChessDojo';
    });

    it('renders children without a provider while auth is loading', () => {
        authState.status = AuthStatus.Loading;
        renderWithIntl(
            <TimerContextProvider>
                <div data-testid='child'>child</div>
            </TimerContextProvider>,
        );
        expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('renders children without a provider when there is no user', () => {
        authState.user = null;
        renderWithIntl(
            <TimerContextProvider>
                <div data-testid='child'>child</div>
            </TimerContextProvider>,
        );
        expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('initializes elapsed seconds from timerStartedAt', () => {
        const startedAt = new Date('2026-05-27T11:59:30Z').toISOString();
        authState.user = makeUser({ timerSeconds: 60, timerStartedAt: startedAt });
        renderTimer();
        expect(screen.getByTestId('seconds')).toHaveTextContent('90');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
    });

    it('reports paused when timer seconds exist but the timer is not running', () => {
        authState.user = makeUser({ timerSeconds: 45, timerStartedAt: '' });
        renderTimer();
        expect(screen.getByTestId('seconds')).toHaveTextContent('45');
        expect(screen.getByTestId('isPaused')).toHaveTextContent('true');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
    });

    it('returns Start Timer label when idle', () => {
        renderTimer();
        expect(screen.getByTestId('label')).toHaveTextContent('Start Timer');
    });

    it('returns Pause Timer label while running', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({ timerSeconds: 0, timerStartedAt: startedAt });
        renderTimer();
        expect(screen.getByTestId('label')).toHaveTextContent(`Pause Timer (${formatTime(60)})`);
    });

    it('returns Resume Timer label when paused', () => {
        authState.user = makeUser({ timerSeconds: 125, timerStartedAt: '' });
        renderTimer();
        expect(screen.getByTestId('label')).toHaveTextContent(`Resume Timer (${formatTime(125)})`);
    });

    it('returns Clear and Restart Timer for a different task', () => {
        authState.user = makeUser({
            timerTaskId: 'task-a',
            timerSeconds: 30,
            timerStartedAt: new Date('2026-05-27T11:59:00Z').toISOString(),
        });
        renderTimer('task-b');
        expect(screen.getByTestId('label')).toHaveTextContent('Clear and Restart Timer');
    });

    it('returns Resume Timer label right after a pause', () => {
        authState.user = makeUser(RUNNING_SINCE_11_59);
        renderTimer('task-a');
        fireEvent.click(screen.getByTestId('pause'));
        expect(screen.getByTestId('label')).toHaveTextContent('Resume Timer (01:00)');
    });

    it('starts the timer and persists to the API', () => {
        renderTimer();
        fireEvent.click(screen.getByTestId('start'));

        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
        expect(updateUserImpl).toHaveBeenCalledWith(
            expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                timerStartedAt: expect.any(String),
            }),
        );
        expect(apiUpdateUser).toHaveBeenCalledWith(
            expect.objectContaining({
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                timerStartedAt: expect.any(String),
            }),
        );
    });

    it('resets elapsed seconds when starting a different task', () => {
        authState.user = makeUser({
            timerTaskId: 'task-a',
            timerSeconds: 120,
            timerStartedAt: '',
        });
        renderTimer('task-b');
        fireEvent.click(screen.getByTestId('start'));

        expect(screen.getByTestId('seconds')).toHaveTextContent('0');
        expect(updateUserImpl).toHaveBeenCalledWith(
            expect.objectContaining({ timerSeconds: 0, timerTaskId: 'task-b' }),
        );
        expect(apiUpdateUser).toHaveBeenCalledWith(
            expect.objectContaining({ timerSeconds: 0, timerTaskId: 'task-b' }),
        );
    });

    it('restarts on a task from the seconds given, or zero, in one write', () => {
        authState.user = makeUser({ timerTaskId: 'task-a', timerSeconds: 479, timerStartedAt: '' });
        renderTimer('task-b', 59);
        fireEvent.click(screen.getByTestId('restart'));

        const update = {
            timerSeconds: 59,
            timerStartedAt: '2026-05-27T12:00:00.000Z',
            timerTaskId: 'task-b',
        };
        expect(apiUpdateUser.mock.calls).toEqual([[update]]);
        expect(updateUserImpl).toHaveBeenCalledWith(update);
        expect(screen.getByTestId('seconds')).toHaveTextContent('59');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');

        cleanup();
        apiUpdateUser.mockReset();
        renderTimer('task-b');
        fireEvent.click(screen.getByTestId('restart'));
        expect(apiUpdateUser.mock.calls).toEqual([[{ ...update, timerSeconds: 0 }]]);
        expect(screen.getByTestId('seconds')).toHaveTextContent('0');
    });

    it('pauses the timer and saves elapsed seconds', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({
            timerSeconds: 0,
            timerStartedAt: startedAt,
            timerTaskId: 'task-a',
        });
        renderTimer();
        fireEvent.click(screen.getByTestId('pause'));

        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(updateUserImpl).toHaveBeenCalledWith(
            expect.objectContaining({
                timerSeconds: 60,
                timerStartedAt: '',
                timerTaskId: 'task-a',
            }),
        );
        expect(apiUpdateUser).toHaveBeenCalledWith(
            expect.objectContaining({
                timerSeconds: 60,
                timerStartedAt: '',
                timerTaskId: 'task-a',
            }),
        );
    });

    it('clears the timer', () => {
        authState.user = makeUser({ timerSeconds: 90, timerStartedAt: '' });
        renderTimer();
        fireEvent.click(screen.getByTestId('clear'));

        expect(screen.getByTestId('seconds')).toHaveTextContent('0');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(updateUserImpl).toHaveBeenCalledWith({
            timerSeconds: 0,
            timerStartedAt: '',
            timerTaskId: '',
        });
        expect(apiUpdateUser).toHaveBeenCalledWith({
            timerSeconds: 0,
            timerStartedAt: '',
            timerTaskId: '',
        });
    });

    it('toggles pause when the same task is running', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({ timerTaskId: 'task-a', timerStartedAt: startedAt });
        renderTimer('task-a');
        fireEvent.click(screen.getByTestId('toggle'));

        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(updateUserImpl).toHaveBeenCalledWith(
            expect.objectContaining({ timerSeconds: 60, timerStartedAt: '' }),
        );
    });

    it('toggles start when the timer is not running', () => {
        authState.user = makeUser({ timerTaskId: 'task-a', timerSeconds: 10, timerStartedAt: '' });
        renderTimer('task-a');
        fireEvent.click(screen.getByTestId('toggle'));

        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
        expect(updateUserImpl).toHaveBeenCalledWith(
            expect.objectContaining({
                timerStartedAt: '2026-05-27T12:00:00.000Z',
                timerTaskId: 'task-a',
            }),
        );
    });

    it('ticks every second while running', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({ timerSeconds: 0, timerStartedAt: startedAt });
        renderTimer();
        expect(screen.getByTestId('seconds')).toHaveTextContent('60');

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        expect(screen.getByTestId('seconds')).toHaveTextContent('61');
    });

    it('a controls consumer does not re-render on the tick', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({ timerSeconds: 0, timerStartedAt: startedAt });
        const renders = vi.fn();
        function ControlsConsumer() {
            use(TimerControlsContext);
            renders();
            return null;
        }
        renderWithIntl(
            <TimerContextProvider>
                <TimerConsumer />
                <ControlsConsumer />
            </TimerContextProvider>,
        );
        const rendersBefore = renders.mock.calls.length;

        act(() => {
            vi.advanceTimersByTime(3000);
        });
        expect(screen.getByTestId('seconds')).toHaveTextContent('63');
        expect(renders).toHaveBeenCalledTimes(rendersBefore);
    });

    it('checks in five minutes after the last check-in while running', async () => {
        authState.user = makeUser(RUNNING_SINCE_11_59);
        renderTimer();

        await advance(4 * 60_000);
        const first = {
            timerSeconds: 300,
            timerStartedAt: '2026-05-27T12:04:00.000Z',
            timerTaskId: 'task-a',
        };
        expect(apiUpdateUser.mock.calls).toEqual([[first]]);
        expect(screen.getByTestId('seconds')).toHaveTextContent('300');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');

        await advance(5 * 60_000);
        expect(apiUpdateUser.mock.calls).toEqual([
            [first],
            [{ ...first, timerSeconds: 600, timerStartedAt: '2026-05-27T12:09:00.000Z' }],
        ]);
    });

    it('checks in at once when the clock is already five minutes into its stretch', async () => {
        authState.user = makeUser({
            ...RUNNING_SINCE_11_59,
            timerStartedAt: '2026-05-27T11:53:00.000Z',
        });
        renderTimer();

        await advance(0);
        expect(apiUpdateUser.mock.calls).toEqual([
            [
                {
                    timerSeconds: 420,
                    timerStartedAt: '2026-05-27T12:00:00.000Z',
                    timerTaskId: 'task-a',
                },
            ],
        ]);
        expect(screen.getByTestId('seconds')).toHaveTextContent('420');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
    });

    it('adopts a pause from the server at the check-in instead of renewing', async () => {
        authState.user = makeUser(RUNNING_SINCE_11_59);
        apiGetUser.mockResolvedValueOnce({
            data: { ...authState.user, timerStartedAt: '', timerSeconds: 200 },
        });
        renderTimer();

        await advance(4 * 60_000);
        expect(apiUpdateUser).not.toHaveBeenCalled();
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(screen.getByTestId('isPaused')).toHaveTextContent('true');
        expect(screen.getByTestId('seconds')).toHaveTextContent('200');
    });

    it('adopts another task from the server at the check-in instead of renewing', async () => {
        authState.user = makeUser({
            ...RUNNING_SINCE_11_59,
            customTasks: [{ id: 'task-b', name: 'Task B' } as CustomTask],
        });
        apiGetUser.mockResolvedValueOnce({
            data: {
                ...authState.user,
                timerTaskId: 'task-b',
                timerSeconds: 30,
                timerStartedAt: '',
            },
        });
        renderTimer();

        await advance(4 * 60_000);
        expect(apiUpdateUser).not.toHaveBeenCalled();
        expect(screen.getByTestId('taskName')).toHaveTextContent('Task B');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(screen.getByTestId('seconds')).toHaveTextContent('30');
    });

    it('keeps a pause made while the check-in fetch was in flight', async () => {
        authState.user = makeUser(RUNNING_SINCE_11_59);
        let resolveFetch: ((response: { data: User }) => void) | undefined;
        apiGetUser.mockImplementationOnce(
            () =>
                new Promise<{ data: User }>((resolve) => {
                    resolveFetch = resolve;
                }),
        );
        renderTimer();
        await advance(4 * 60_000);
        expect(apiGetUser).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByTestId('pause'));
        const paused = { timerSeconds: 300, timerStartedAt: '', timerTaskId: 'task-a' };
        expect(apiUpdateUser.mock.calls).toEqual([[paused]]);

        // The server answers with the copy from before the pause.
        await act(async () => {
            resolveFetch?.({ data: makeUser(RUNNING_SINCE_11_59) });
            await vi.advanceTimersByTimeAsync(0);
        });
        expect(apiUpdateUser.mock.calls).toEqual([[paused]]);
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(screen.getByTestId('isPaused')).toHaveTextContent('true');
        expect(screen.getByTestId('seconds')).toHaveTextContent('300');
    });

    it('keeps running and checks in five minutes later when the fetch fails', async () => {
        authState.user = makeUser(RUNNING_SINCE_11_59);
        apiGetUser.mockRejectedValueOnce(new Error('offline'));
        renderTimer();

        await advance(4 * 60_000);
        expect(apiUpdateUser).not.toHaveBeenCalled();
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
        expect(screen.getByTestId('seconds')).toHaveTextContent('300');

        await advance(5 * 60_000);
        expect(apiUpdateUser.mock.calls).toEqual([
            [
                {
                    timerSeconds: 600,
                    timerStartedAt: '2026-05-27T12:09:00.000Z',
                    timerTaskId: 'task-a',
                },
            ],
        ]);
    });

    it('shows zero, not a negative count, for a start that is still ahead', () => {
        renderTimer();
        act(() => {
            updateUserImpl({ ...RUNNING_SINCE_11_59, timerStartedAt: '2026-05-27T12:00:05.000Z' });
        });
        expect(screen.getByTestId('seconds').textContent).toBe('0');
        expect(screen.getByTestId('isRunning')).toHaveTextContent('true');
        expect(document.title).toBe('00:00 - ChessDojo');

        act(() => {
            vi.advanceTimersByTime(6000);
        });
        expect(screen.getByTestId('seconds').textContent).toBe('1');
    });

    it('writes an expired running clock as paused on load', () => {
        const startedAt = new Date('2026-05-27T11:49:00Z').toISOString();
        authState.user = makeUser({
            timerSeconds: 600,
            timerStartedAt: startedAt,
            timerTaskId: 'task-a',
        });
        renderTimer();

        expect(apiUpdateUser.mock.calls).toEqual([
            [{ timerSeconds: 600, timerStartedAt: '', timerTaskId: 'task-a' }],
        ]);
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(screen.getByTestId('isPaused')).toHaveTextContent('true');
        expect(screen.getByTestId('seconds')).toHaveTextContent('600');
    });

    it('repairs an expired clock once when the record arrives a second time', () => {
        const expired = {
            timerSeconds: 600,
            timerStartedAt: new Date('2026-05-27T11:49:00Z').toISOString(),
            timerTaskId: 'task-a',
        };
        authState.user = makeUser(expired);
        renderTimer();
        expect(apiUpdateUser).toHaveBeenCalledTimes(1);

        // A second GET of the user record lands after the repair with the stale running clock.
        act(() => {
            updateUserImpl(expired);
        });
        expect(apiUpdateUser).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId('isRunning')).toHaveTextContent('false');
        expect(screen.getByTestId('isPaused')).toHaveTextContent('true');
        expect(screen.getByTestId('seconds')).toHaveTextContent('600');
    });

    it('updates document title while running and restores it when stopped', () => {
        const startedAt = new Date('2026-05-27T11:59:00Z').toISOString();
        authState.user = makeUser({ timerSeconds: 0, timerStartedAt: startedAt });
        renderTimer();

        act(() => {
            vi.advanceTimersByTime(1000);
        });
        const seconds = Number(screen.getByTestId('seconds').textContent);
        expect(document.title).toBe(`${formatTime(seconds)} - ChessDojo`);

        fireEvent.click(screen.getByTestId('pause'));
        expect(document.title).toBe('ChessDojo');
    });

    it('exposes a custom task from the user', () => {
        const customTask: Partial<CustomTask> = {
            id: 'custom-1',
            name: 'My Custom Task',
            updatedAt: '2024-01-01T00:00:00Z',
        };
        authState.user = makeUser({
            timerTaskId: 'custom-1',
            customTasks: [customTask as CustomTask],
        });
        renderTimer();
        expect(screen.getByTestId('taskName')).toHaveTextContent('My Custom Task');
    });

    it('exposes a requirement task when timerTaskId matches', () => {
        const requirement: Partial<Requirement> = {
            id: 'req-1',
            status: RequirementStatus.Active,
            category: RequirementCategory.Tactics,
            name: 'Full Requirement Name',
            shortName: 'Short Req',
            dailyName: 'Daily',
            description: '',
            freeDescription: '',
            counts: {},
            startCount: 0,
            numberOfCohorts: 1,
            unitScore: 0,
            totalScore: 0,
            scoreboardDisplay: ScoreboardDisplay.Hidden,
            updatedAt: '2024-01-01T00:00:00Z',
            sortPriority: '1',
            isFree: false,
            atomic: false,
        };
        vi.mocked(useRequirement).mockReturnValue({ requirement } as ReturnType<
            typeof useRequirement
        >);
        authState.user = makeUser({ timerTaskId: 'req-1' });
        renderTimer();
        expect(screen.getByTestId('taskName')).toHaveTextContent('Short Req');
    });
});
