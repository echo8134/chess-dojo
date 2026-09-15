import { renderWithIntl } from '@/i18n/intl.test';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyPage } from './StudyPage';

const mocks = vi.hoisted(() => ({
    searchParams: new URLSearchParams(),
    provider: vi.fn(),
    useStudy: vi.fn(),
}));

vi.mock('@/auth/Auth', () => ({
    useAuth: () => ({ user: { username: 'student', dojoCohort: '1500-1600' } }),
    useFreeTier: () => false,
}));
vi.mock('@/hooks/useNextSearchParams', () => ({
    useNextSearchParams: () => ({ searchParams: mocks.searchParams, setSearchParams: vi.fn() }),
}));
vi.mock('@/components/profile/trainingPlan/study/useStudy', () => ({
    useStudy: mocks.useStudy,
}));
vi.mock('@/components/profile/activity/useTimeline', () => ({
    TimelineProvider: ({ children }: { children: React.ReactNode }) => {
        mocks.provider();
        return <div data-testid='timeline-provider'>{children}</div>;
    },
}));
vi.mock('@/loading/LoadingPage', () => ({ default: () => <div data-testid='loading' /> }));
vi.mock('@/board/pgn/PgnBoard', () => ({ default: () => null }));
vi.mock('@/components/profile/trainingPlan/ProgressUpdater', () => ({
    ProgressUpdater: () => null,
}));
vi.mock(
    '@/app/[locale]/(scoreboard)/courses/[type]/[id]/[chapter]/[module]/PurchaseCoursePage',
    () => ({ default: () => null }),
);
vi.mock('next-navigation-guard', () => ({
    useNavigationGuard: () => ({ active: false, accept: vi.fn(), reject: vi.fn() }),
}));

const TASK = { kind: 'task', taskId: 'task-1' } as const;

describe('StudyPage: the timeline provider', () => {
    beforeEach(() => {
        mocks.searchParams = new URLSearchParams();
        mocks.provider.mockReset();
        mocks.useStudy.mockReset().mockReturnValue({ status: 'loading' });
    });

    afterEach(() => {
        cleanup();
    });

    it("wraps the member's own session", async () => {
        renderWithIntl(<StudyPage source={TASK} />);
        await screen.findByTestId('loading');
        expect(mocks.provider).toHaveBeenCalled();
        expect(mocks.useStudy).toHaveBeenCalledWith(TASK, null);
    });

    it("keeps the session when the cohort param is the member's own", async () => {
        mocks.searchParams = new URLSearchParams({ cohort: '1500-1600', item: 'k1' });
        renderWithIntl(<StudyPage source={TASK} />);
        await screen.findByTestId('loading');
        expect(mocks.provider).toHaveBeenCalled();
        expect(mocks.useStudy).toHaveBeenCalledWith(TASK, 'k1');
    });

    it("skips the history load when browsing another cohort's share", async () => {
        mocks.searchParams = new URLSearchParams({ cohort: '1000-1100' });
        renderWithIntl(<StudyPage source={TASK} />);
        await screen.findByTestId('loading');
        expect(mocks.provider).not.toHaveBeenCalled();
        expect(mocks.useStudy).toHaveBeenCalledWith({ ...TASK, cohort: '1000-1100' }, null);
    });

    it('skips the history load for a course without a task', async () => {
        const course = { kind: 'course', courseType: 'STUDY', courseId: 'c1' } as const;
        renderWithIntl(<StudyPage source={course} />);
        await screen.findByTestId('loading');
        expect(mocks.provider).not.toHaveBeenCalled();
        expect(mocks.useStudy).toHaveBeenCalledWith(course, null);
    });
});
