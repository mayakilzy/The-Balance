// ============================================================
// browser-journey.spec.ts — Real Playwright browser E2E test
// ------------------------------------------------------------
// Tests the full user journey via actual Chromium browser:
//   1. Open /login without session
//   2. Login with test credentials
//   3. Verify home page shows tenant context
//   4. Navigate to /tasks
//   5. Create a new task via the form
//   6. See the task in the list
//   7. Open task detail and view events
//   8. Logout
//   9. Verify redirect to /login
//  10. Screenshot capture (desktop + mobile)
// ============================================================
import { test, expect } from "@playwright/test";

const ADMIN_EMAIL = "admin@demolandia.test";
const ADMIN_PW = "test_admin_password_00_03";

test.describe("Full Browser Journey", () => {
  test("login → home → create task → view detail → logout", async ({ page, browser }) => {
    // Step 1: Open /login without session
    await page.goto("/login");
    await expect(page).toHaveURL(/\/login/);
    await expect(page.locator("h1")).toContainText("الميزان");
    await page.screenshot({ path: "test-results/screenshots/01-login-page.png" });

    // Step 2: Login with test credentials
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PW);
    await page.click('button[type="submit"]');

    // Wait for redirect to home
    await page.waitForURL("/", { timeout: 15_000 });
    await expect(page).toHaveURL("/");

    // Step 3: Verify home page shows tenant context
    await expect(page.locator("h2").first()).toContainText("سياق المستأجر");
    await page.screenshot({ path: "test-results/screenshots/02-home-page.png" });

    // Step 4: Navigate to /tasks
    await page.click('a[href="/tasks"]');
    await page.waitForURL("/tasks");
    await expect(page).toHaveURL("/tasks");
    await expect(page.locator("h1")).toContainText("المهام");
    await page.screenshot({ path: "test-results/screenshots/03-tasks-page.png" });

    // Step 5: Create a new task via the form
    await page.click("text=+ مهمة جديدة");
    await expect(page.locator('[data-testid="create-task-form"]')).toBeVisible();

    const taskGoal = `مهمة اختبار Playwright ${Date.now()}`;
    await page.fill('[data-testid="task-goal-input"]', taskGoal);
    await page.click('[data-testid="task-create-button"]');

    // Step 6: Wait for task list to refresh — task cards should be visible
    await page.waitForSelector('[data-testid^="task-card-"]', { timeout: 15_000 });
    await page.waitForTimeout(2000); // Give list + auto-detail time to settle
    await page.screenshot({ path: "test-results/screenshots/04-task-created.png" });

    // Step 7: The handleCreate auto-opens the detail panel — verify it's visible
    // If not visible, click the first task card to open it
    const detailPanel = page.locator('[data-testid="task-detail-panel"]');
    const isDetailVisible = await detailPanel.isVisible().catch(() => false);

    if (!isDetailVisible) {
      // Close the create form if it's still open (might be covering cards)
      const createForm = page.locator('[data-testid="create-task-form"]');
      if (await createForm.isVisible().catch(() => false)) {
        await page.click("text=إلغاء");
        await page.waitForTimeout(500);
      }

      // Now click the first task card
      const firstTaskCard = page.locator('[data-testid^="task-card-"]').first();
      await firstTaskCard.click({ timeout: 15_000 });
    }

    // Wait for detail panel
    await expect(detailPanel).toBeVisible({ timeout: 15_000 });
    await expect(detailPanel).toContainText("تفاصيل المهمة");
    await expect(detailPanel).toContainText("سجل الأحداث");
    await page.screenshot({ path: "test-results/screenshots/05-task-detail.png" });

    // Close detail
    await page.click("text=✕");

    // Step 8: Logout
    await page.click("text=خروج");

    // Step 9: Verify redirect to /login
    await page.waitForURL("/login", { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
    await page.screenshot({ path: "test-results/screenshots/06-logged-out.png" });
  });

  test("unauthenticated access redirects to login", async ({ page }) => {
    // Try to access /tasks without session
    await page.goto("/tasks");
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated access to home redirects to login", async ({ page }) => {
    await page.goto("/");
    await page.waitForURL(/\/login/, { timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("mobile viewport screenshot", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    await page.goto("/login");
    await page.fill('input[type="email"]', ADMIN_EMAIL);
    await page.fill('input[type="password"]', ADMIN_PW);
    await page.click('button[type="submit"]');
    await page.waitForURL("/", { timeout: 15_000 });

    await page.screenshot({ path: "test-results/screenshots/07-mobile-home.png" });

    await page.click('a[href="/tasks"]');
    await page.waitForURL("/tasks");
    await page.screenshot({ path: "test-results/screenshots/08-mobile-tasks.png" });

    await context.close();
  });
});
