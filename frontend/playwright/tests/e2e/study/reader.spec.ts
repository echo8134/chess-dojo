import { expect, Page, test } from '@playwright/test';
import { getEnv } from '../../../lib/env';

/**
 * The Reader overview at /study: the cohort's study first, the member's own material,
 * and a cohort switch that shows another cohort's plan in browse mode. Reads only; nothing to clean up.
 * Skips when the account's cohort has no study with material on dev yet.
 */
const API = getEnv('apiBaseUrl');
const TASK_NAME = 'Study Master Games';

async function idToken(page: Page): Promise<string> {
    const cookies = await page.context().cookies();
    const cookie = cookies.find((c) => c.name.endsWith('.idToken'));
    if (!cookie) throw new Error('no id token cookie');
    return cookie.value;
}

/** The account's cohort, so the spec can tell its own cell from the others. */
async function ownCohort(page: Page): Promise<string> {
    const headers = { Authorization: `Bearer ${await idToken(page)}` };
    const user = (await (await page.request.get(`${API}/user`, { headers })).json()) as {
        dojoCohort: string;
    };
    return user.dojoCohort;
}

test.describe('Reader overview', () => {
    test('is reachable from the Learn menu', async ({ page }) => {
        test.setTimeout(90_000);
        // Wide enough for Learn to sit in the navbar itself rather than the overflow menu.
        await page.setViewportSize({ width: 1600, height: 900 });
        await page.goto('/');
        await page.getByRole('button', { name: 'Learn' }).click();
        await page.getByRole('menuitem', { name: 'Reader' }).click();
        await expect(page).toHaveURL(/\/study$/);
        await expect(page.getByTestId('reader-page')).toBeVisible({ timeout: 30_000 });
    });

    test('shows the cohort study first, switches cohort into browse mode, and opens both', async ({
        page,
    }) => {
        test.setTimeout(120_000);
        const cohort = await ownCohort(page);
        await page.goto('/study');
        // Three list requests to the shared dev backend before anything renders.
        await expect(page.getByTestId('reader-page')).toBeVisible({ timeout: 30_000 });
        // Until the backend returns task material, the page says the cohort has no study, so the skip follows the page.
        test.skip(
            await page.getByTestId('reader-no-cohort-study').isVisible(),
            `${TASK_NAME} has no material on dev yet`,
        );

        // The cohort block may hold several studies; the spec follows the master games one.
        const study = page.getByTestId('reader-cohort-study').filter({ hasText: TASK_NAME });
        await expect(study).toContainText(TASK_NAME);
        // The page names the cohort once, in the switch; the tiles do not repeat it.
        await expect(page.getByRole('combobox', { name: 'Cohort' })).toContainText(cohort);

        await expect(page.getByTestId('reader-viewing-other')).toHaveCount(0);
        await page.getByRole('combobox', { name: 'Cohort' }).click();
        const other = page.getByRole('option').filter({ hasNotText: cohort }).first();
        const otherCohort = (await other.textContent()) ?? '';
        await other.click();
        await expect(page.getByTestId('reader-viewing-other')).toContainText(otherCohort);
        const tile = page.getByTestId('reader-cohort-browse').first();
        await expect(tile).toBeVisible();

        await tile.getByTestId('reader-continue').click();
        await expect(page).toHaveURL(/\/study\/[^/?]+\?.*cohort=/);
        await expect(page.getByTestId('study-browse-notice')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('study-session')).toHaveCount(0);

        await page.goto('/study');
        await page
            .getByTestId('reader-cohort-study')
            .filter({ hasText: TASK_NAME })
            .getByTestId('reader-continue')
            .click();
        await expect(page).toHaveURL(/\/study\/[^/?]+/);
        // The study page pages the account's games before it renders.
        await expect(page.getByTestId('study-session')).toBeVisible({ timeout: 30_000 });
        await expect(page.getByTestId('study-breadcrumb')).toContainText(TASK_NAME);
    });
});
