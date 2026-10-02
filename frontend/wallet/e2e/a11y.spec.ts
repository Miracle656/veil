import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const routes = [
  "/",
  "/dashboard",
  "/send",
  "/receive",
  "/settings",
];

for (const route of routes) {
  test(`Accessibility audit: ${route}`, async ({ page }) => {
    const response = await page.goto(route);

    expect(response?.ok()).toBeTruthy();

    // Wait for any entry animations to finish before auditing
    await page.waitForTimeout(500);

    const results = await new AxeBuilder({ page }).analyze();

    expect(results.violations).toEqual([]);
  });
}