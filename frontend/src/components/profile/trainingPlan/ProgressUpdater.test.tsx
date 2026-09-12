import { Timer, TimerContext } from '@/components/timer/TimerContext';
import {
    Requirement,
    RequirementCategory,
    RequirementProgress,
    RequirementStatus,
    ScoreboardDisplay,
} from '@/database/requirement';
import { TimelineEntry } from '@/database/timeline';
import { renderWithIntl } from '@/i18n/intl.test';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProgressUpdater } from './ProgressUpdater';

const cohort = '1500-1600';

const requirement: Requirement = {
    id: 'study-master-games',
    status: RequirementStatus.Active,
    category: RequirementCategory.Middlegames,
    name: 'Study Master Games',
    description: '',
    freeDescription: '',
    counts: { [cohort]: 45 },
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
};

const progress: RequirementProgress = {
    requirementId: requirement.id,
    counts: { ALL_COHORTS: 5 },
    minutesSpent: {},
    updatedAt: '',
};

const createdEntry = { id: 'entry-1', requirementId: requirement.id } as TimelineEntry;

const mocks = vi.hoisted(() => ({
    api: { updateUserProgress: vi.fn() },
    onNewEntry: vi.fn(),
}));

vi.mock('@/api/Api', () => ({
    useApi: () => mocks.api,
}));
vi.mock('@/auth/Auth', () => ({
    useAuth: () => ({ user: { username: 'student' } }),
}));
vi.mock('@/components/profile/activity/useTimeline', () => ({
    useTimelineContext: () => ({ entries: [], onNewEntry: mocks.onNewEntry }),
}));
vi.mock('@/analytics/events', () => ({
    EventType: { UpdateProgress: 'UpdateProgress' },
    trackEvent: vi.fn(),
}));
vi.mock('@mui/x-date-pickers-pro', () => ({
    DateTimePicker: ({ label }: { label: string }) => <input aria-label={label} readOnly />,
}));
vi.mock('./InputSlider', () => ({
    InputSlider: ({ value }: { value: number }) => <div data-testid='slider-value'>{value}</div>,
}));

const timer = {
    timerSeconds: 0,
    task: undefined,
    onClear: vi.fn(),
} as unknown as Timer;

function renderUpdater(props: Partial<React.ComponentProps<typeof ProgressUpdater>> = {}) {
    return renderWithIntl(
        <TimerContext.Provider value={timer}>
            <ProgressUpdater
                requirement={requirement}
                progress={progress}
                cohort={cohort}
                onClose={vi.fn()}
                {...props}
            />
        </TimerContext.Provider>,
    );
}

function submittedBody(): Record<string, unknown> {
    const [body] = mocks.api.updateUserProgress.mock.calls[0] as [Record<string, unknown>];
    return body;
}

describe('ProgressUpdater', () => {
    beforeEach(() => {
        mocks.api.updateUserProgress
            .mockReset()
            .mockResolvedValue({ data: { user: {}, timelineEntry: createdEntry } });
        mocks.onNewEntry.mockReset();
    });

    afterEach(cleanup);

    it('prefills the count, sends the study item and hands back the created entry', async () => {
        const onSuccess = vi.fn();
        const onClose = vi.fn();
        const studyInfo = { itemKey: 'course:STUDY/x/m1/0', itemName: 'Keres vs Smyslov (1939)' };
        renderUpdater({ initialCount: 6, studyInfo, onSuccess, onClose });

        expect(screen.getByTestId('slider-value')).toHaveTextContent('6');
        fireEvent.click(screen.getByTestId('task-updater-save-button'));

        await waitFor(() => expect(onSuccess).toHaveBeenCalledWith(createdEntry));
        expect(submittedBody()).toMatchObject({
            requirementId: requirement.id,
            previousCount: 5,
            newCount: 6,
            studyInfo,
        });
        expect(mocks.onNewEntry).toHaveBeenCalledWith(createdEntry);
        const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
            fn.mock.invocationCallOrder[0];
        expect(order(mocks.onNewEntry)).toBeLessThan(order(onSuccess));
        expect(order(onSuccess)).toBeLessThan(order(onClose));
    });

    it('sends the same request as before without the study props', async () => {
        renderUpdater();

        expect(screen.getByTestId('slider-value')).toHaveTextContent('5');
        fireEvent.click(screen.getByTestId('task-updater-save-button'));

        await waitFor(() => expect(mocks.api.updateUserProgress).toHaveBeenCalledTimes(1));
        const body = submittedBody();
        expect(body).toMatchObject({ previousCount: 5, newCount: 5 });
        expect(body).not.toHaveProperty('studyInfo');
    });
});
