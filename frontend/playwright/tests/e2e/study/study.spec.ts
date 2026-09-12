import { expect, Page, test } from '@playwright/test';
import { getEnv } from '../../../lib/env';

/**
 * The study page over the "Study Master Games" task. Needs the task's material on dev
 * (the backend field and the seeded courses); until then the page reports no material
 * and this spec skips. Repeatable: it always works on the last catalog row and undoes
 * what it wrote through the API afterwards.
 */
const TASK_NAME = 'Study Master Games';
const API = getEnv('apiBaseUrl');

interface Written {
    copy?: { cohort: string; id: string };
    entry?: { id: string; requirementId: string };
    progressBefore?: unknown;
    taskId?: string;
}

async function idToken(page: Page): Promise<string> {
    const cookies = await page.context().cookies();
    const cookie = cookies.find((c) => c.name.endsWith('.idToken'));
    if (!cookie) throw new Error('no id token cookie');
    return cookie.value;
}

/** The underboard folds its overflow tabs into a More menu when narrow. */
async function openShareTab(page: Page) {
    const share = page.getByTestId('underboard-button-share').first();
    if (await share.isVisible()) {
        await share.click();
        return;
    }
    await page.getByRole('button', { name: 'More' }).last().click();
    await page.getByRole('menuitem', { name: /share/i }).click();
}

/** The task and the user's progress on it, from the plan; skips the test when the page cannot run yet. */
async function studyTask(page: Page) {
    const headers = { Authorization: `Bearer ${await idToken(page)}` };
    const user = (await (await page.request.get(`${API}/user`, { headers })).json()) as {
        dojoCohort: string;
        progress: Record<string, unknown>;
    };
    const list = (await (
        await page.request.get(`${API}/requirements/${user.dojoCohort}?scoreboardOnly=false`, {
            headers,
        })
    ).json()) as { requirements: { id: string; name: string; material?: unknown[] }[] };
    const task = list.requirements.find((r) => r.name === TASK_NAME);
    test.skip(!task, `${TASK_NAME} is not in the ${user.dojoCohort} plan`);
    test.skip(!task?.material?.length, `${TASK_NAME} has no material on dev yet`);
    return { task, progress: user.progress[task?.id ?? ''] };
}

test.describe('Study page', () => {
    const written: Written = {};

    test.afterEach(async ({ page }) => {
        const token = await idToken(page);
        const headers = { Authorization: `Bearer ${token}` };
        if (written.entry && written.taskId) {
            const progress = written.progressBefore ?? {
                requirementId: written.taskId,
                counts: {},
                minutesSpent: {},
                updatedAt: '',
            };
            await page.request.post(`${API}/user/progress/timeline/v2`, {
                headers,
                data: {
                    requirementId: written.taskId,
                    progress,
                    updated: [],
                    deleted: [written.entry],
                },
            });
            written.entry = undefined;
        }
        if (written.copy) {
            await page.request.post(`${API}/game/delete`, { headers, data: [written.copy] });
            written.copy = undefined;
        }
    });

    test("opens the task, keeps the student's edits in a copy, and records a game as done", async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const { task, progress } = await studyTask(page);
        written.taskId = task?.id;
        written.progressBefore = progress;

        await page.goto(`/study/${task?.id}`);
        await expect(page.getByTestId('study-catalog')).toBeVisible();
        await expect(page.getByTestId('study-breadcrumb')).toContainText(TASK_NAME);

        const rows = page.getByTestId('study-item');
        await expect(rows.first()).toBeVisible();
        const last = rows.last();
        await expect(last.getByTestId('study-item-done')).toHaveCount(0);
        await last.click();
        const itemKey = await last.getAttribute('data-item-key');
        expect(itemKey).toBeTruthy();
        await expect(page.getByTestId('chessground-board').first()).toBeVisible();
        await expect(page.getByTestId('study-your-copy')).toHaveCount(0);

        // First edit creates the copy; the second one rides a follow-up update.
        const comments = page.getByRole('textbox', { name: 'Comments' });
        const created = page.waitForResponse(
            (r) => r.url().endsWith('/game2') && r.request().method() === 'POST',
        );
        await comments.fill('Study note one');
        const createResp = await created;
        expect(createResp.status()).toBe(200);
        const game = (await createResp.json()) as { cohort: string; id: string; pgn: string };
        written.copy = { cohort: game.cohort, id: game.id };
        expect(game.pgn).toContain(`[StudyItem "${itemKey}"]`);

        const updated = page.waitForResponse(
            (r) => r.url().includes('/game2/') && r.request().method() === 'PUT',
        );
        await comments.fill('Study note one, then two');
        expect((await updated).status()).toBe(200);
        await expect(page.getByTestId('study-your-copy')).toBeVisible();

        // Reopening lands on the copy with both edits.
        await page.goto(`/study/${task?.id}?item=${encodeURIComponent(itemKey ?? '')}`);
        await expect(page.getByTestId('study-your-copy')).toBeVisible();
        await expect(page.getByText('Study note one, then two').first()).toBeVisible();
        await openShareTab(page);
        await expect(page.getByRole('button', { name: 'Copy URL' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Copy PGN' })).toHaveCount(0);

        // Mark done: the request names the game, the count moves by one, the row gets its check.
        await page.getByTestId('study-mark-done').click();
        const posted = page.waitForResponse(
            (r) => r.url().endsWith('/user/progress/v3') && r.request().method() === 'POST',
        );
        await page.getByTestId('task-updater-save-button').click();
        const resp = await posted;
        expect(resp.status()).toBe(200);
        const sent = resp.request().postDataJSON() as {
            studyInfo?: { itemKey: string };
            newCount: number;
            previousCount: number;
        };
        expect(sent.studyInfo?.itemKey).toBe(itemKey);
        expect(sent.newCount).toBe(sent.previousCount + 1);
        const body = (await resp.json()) as {
            timelineEntry: { id: string; requirementId: string };
        };
        written.entry = body.timelineEntry;
        await expect(page.getByTestId('study-breadcrumb')).toContainText(`${sent.newCount} / `);
        await expect(
            page.locator(`[data-item-key="${itemKey}"]`).getByTestId('study-item-done'),
        ).toBeVisible();
    });

    test('the task dialog offers Study', async ({ page }) => {
        await studyTask(page);
        await page.goto('/profile?view=progress');
        const header = page.getByTestId('Middlegames-+-Strategy-header');
        await expect(header).toBeVisible({ timeout: 30_000 });
        const entry = page.getByTestId(`${TASK_NAME.replaceAll(' ', '-')}-training-plan-entry`);
        if (!(await entry.isVisible())) {
            await header.click();
        }
        await expect(entry).toBeVisible();
        await entry.locator('#task-details').click();
        await expect(page.getByRole('dialog')).toBeVisible();
        const study = page.getByTestId('task-study-button');
        await expect(study).toBeVisible();
        await study.click();
        await expect(page).toHaveURL(/\/study\//);
        await expect(page.getByTestId('study-catalog')).toBeVisible();
    });
});
