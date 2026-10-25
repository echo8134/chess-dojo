import { describe, expect, it, vi } from 'vitest';
import { User } from '../database/user';

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));
vi.mock('./axiosService', () => ({ axiosService: { post: mockPost } }));

import { updateUserProgress, updateUserTimeline } from './userApi';

/** The record as the server held it when it built the response, with the clock still running. */
const response = {
    username: 'student',
    progress: { 'task-a': { requirementId: 'task-a', counts: { ALL_COHORTS: 11 } } },
    timerSeconds: 0,
    timerStartedAt: '2026-10-24T18:00:00.000Z',
    timerTaskId: 'task-a',
} as unknown as User;

/** The record this tab holds, after the member paused the clock while the post was in flight. */
function pausedLocally() {
    const local = { ...response, timerSeconds: 90, timerStartedAt: '', progress: {} } as User;
    return { local, apply: vi.fn((update: Partial<User>) => Object.assign(local, update)) };
}

describe('userApi progress responses', () => {
    it('updateUserProgress applies the progress and leaves a locally paused clock paused', async () => {
        mockPost.mockResolvedValueOnce({ data: { user: response, timelineEntry: {} } });
        const { local, apply } = pausedLocally();
        await updateUserProgress(
            'token',
            {
                cohort: '1500-1600',
                requirementId: 'task-a',
                previousCount: 10,
                newCount: 11,
                incrementalMinutesSpent: 7,
                date: null,
                notes: '',
            },
            apply,
        );
        expect(apply).toHaveBeenCalledTimes(1);
        expect(local.progress).toEqual(response.progress);
        expect(local).toMatchObject({
            timerSeconds: 90,
            timerStartedAt: '',
            timerTaskId: 'task-a',
        });
    });

    it('updateUserTimeline applies the progress and leaves a locally paused clock paused', async () => {
        mockPost.mockResolvedValueOnce({ data: response });
        const { local, apply } = pausedLocally();
        await updateUserTimeline(
            'token',
            {
                requirementId: 'task-a',
                progress: response.progress['task-a'],
                updated: [],
                deleted: [],
            },
            apply,
        );
        expect(apply).toHaveBeenCalledTimes(1);
        expect(local.progress).toEqual(response.progress);
        expect(local).toMatchObject({
            timerSeconds: 90,
            timerStartedAt: '',
            timerTaskId: 'task-a',
        });
    });
});
