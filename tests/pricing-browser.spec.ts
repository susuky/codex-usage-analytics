import { expect, test, type Page } from "@playwright/test";

async function seedCatalog(page: Page) {
  await page.goto("/settings");
  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.evaluate(() => {
    const settings = JSON.parse(sessionStorage.getItem("codex-usage-settings")!);
    settings.pricingRules.push(...Array.from({ length: 34 }, (_, index) => ({ ...settings.pricingRules[0], model: `custom-model-${index + 1}` })));
    sessionStorage.setItem("codex-usage-settings", JSON.stringify(settings));
  });
  await page.reload();
}

test("all models are available immediately, global search and name sorting need no paging", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.setViewportSize({ width: 1536, height: 1000 });
  await seedCatalog(page);
  await expect(page.locator(".pricing-table tbody tr")).toHaveCount(41);
  await expect(page.getByRole("button", { name: "下一頁模型" })).toHaveCount(0);
  const names = page.locator(".pricing-model-name");
  const allNames = await names.allTextContents();
  expect(allNames).toEqual([...allNames].sort((a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" })));
  await page.getByRole("button", { name: "模型名稱排序" }).click();
  await expect(names.first()).toHaveText(allNames.at(-1)!);
  await page.getByLabel("搜尋模型價格").fill("custom-model-34");
  await expect(names).toHaveCount(1);
  await page.getByRole("button", { name: "編輯 custom-model-34 價格" }).click();
  await page.getByLabel("模型名稱", { exact: true }).fill("renamed-model");
  await page.getByLabel("renamed-model input 價格").fill("7.25");
  await expect(page.getByRole("button", { name: "保存價格" })).toBeInViewport();
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByText("renamed-model 的價格已保存。")).toBeVisible();
  await page.reload();
  await page.getByLabel("搜尋模型價格").fill("renamed");
  await page.getByRole("button", { name: "編輯 renamed-model 價格" }).click();
  await expect(page.getByLabel("renamed-model input 價格")).toHaveValue("7.25");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("button", { name: "編輯 renamed-model 價格" })).toBeFocused();
  await page.getByRole("button", { name: "清除模型搜尋" }).click();
  await page.getByRole("link", { name: "模型價格" }).click();
  const section = await page.locator("#pricing-settings").boundingBox();
  const table = await page.locator(".pricing-table").boundingBox();
  expect(table!.y - section!.y).toBeLessThan(235);
  await page.screenshot({ path: testInfo.outputPath("01-catalog.png") });
  expect(errors).toEqual([]);
});

test("edit dialog has visible save and cancel, keyboard focus stays inside, and cancel discards edits", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await page.getByLabel("搜尋模型價格").fill("gpt-5.6-sol");
  const edit = page.getByRole("button", { name: "編輯 gpt-5.6-sol 價格" });
  for (const viewport of [{ width: 1536, height: 1000 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await edit.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(page.getByLabel("gpt-5.6-sol input 價格")).toBeFocused();
    await page.getByLabel("gpt-5.6-sol input 價格").fill("999");
    await expect(page.getByRole("button", { name: "保存價格" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "取消", exact: true })).toBeInViewport();
    const inputBox = await page.getByLabel("gpt-5.6-sol input 價格").boundingBox();
    const footerBox = await page.locator(".price-dialog-footer").boundingBox();
    expect(inputBox!.y + inputBox!.height).toBeLessThanOrEqual(footerBox!.y);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`02-edit-${viewport.width}.png`) });
    await page.getByRole("button", { name: "關閉價格編輯" }).focus();
    await page.keyboard.press("Shift+Tab");
    await expect(page.getByRole("button", { name: "保存價格" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(edit).toBeFocused();
    await edit.click();
    await expect(page.getByLabel("gpt-5.6-sol input 價格")).toHaveValue("4");
    await page.getByRole("button", { name: "取消", exact: true }).click();
  }
});

test("unpriced models stay unpriced until required values are saved and can be removed", async ({ page }, testInfo) => {
  await page.goto("/settings");
  await page.getByLabel("搜尋模型價格").fill("custom-review-model");
  await page.getByRole("button", { name: "新增自訂價格" }).click();
  await page.getByLabel("模型名稱", { exact: true }).fill("custom-review-model");
  await expect(page.getByLabel("custom-review-model input 價格")).toBeEmpty();
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByRole("alert")).toContainText("輸入 Input請填寫價格（0 或正數）。");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator(".pricing-table tbody tr")).toHaveCount(0);
  await page.getByRole("button", { name: "新增自訂價格" }).click();
  await page.getByLabel("模型名稱", { exact: true }).fill("custom-review-model");
  await page.getByLabel("custom-review-model input 價格").fill("1.5");
  await page.getByLabel("custom-review-model output 價格").fill("6");
  await page.getByRole("button", { name: "保存價格" }).click();
  await expect(page.getByText("custom-review-model 的價格已保存。")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("03-saved.png") });
  await page.reload();
  await page.getByRole("button", { name: "編輯 custom-review-model 價格" }).click();
  await expect(page.getByLabel("custom-review-model output 價格")).toHaveValue("6");
  await expect(page.getByLabel("custom-review-model cached input 價格")).toBeEmpty();
  await page.getByRole("button", { name: "移除自訂價格" }).click();
  await page.getByRole("button", { name: "確認移除" }).click();
  await expect(page.getByText("custom-review-model 的自訂價格已移除。")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "custom-review-model" })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("row").filter({ hasText: "custom-review-model" })).toHaveCount(0);
});

test("auto review is fixed at zero after loading legacy prices and needs no price action", async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto("/settings");
  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  await page.evaluate(() => {
    const settings = JSON.parse(sessionStorage.getItem("codex-usage-settings")!);
    settings.pricingRules = settings.pricingRules.filter((rule: { model: string }) => rule.model !== "codex-auto-review");
    settings.pricingRules.push({ ...settings.pricingRules[0], model: " CODEX-AUTO-REVIEW ", inputUsdPerMillion: 99, outputUsdPerMillion: 99, unavailableRates: ["cached", "fast"] });
    sessionStorage.setItem("codex-usage-settings", JSON.stringify(settings));
  });
  await page.reload();
  await page.getByLabel("搜尋模型價格").fill("codex-auto-review");
  const row = page.locator(".pricing-table tbody tr");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("不計費");
  await expect(row).toContainText("保留用量紀錄，費用固定為 0。");
  await expect(row).not.toContainText("尚未定價");
  await expect(row.getByRole("button")).toHaveCount(0);
  for (let index = 0; index < 3; index++) await expect(row.getByRole("cell").nth(index)).toHaveText("0");
  await page.getByRole("button", { name: "保存設定" }).click();
  await expect(page.getByText("設定已保存，既有費用已重新計算")).toBeVisible();
  const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("codex-usage-settings")!).pricingRules.find((rule: { model: string }) => rule.model === "codex-auto-review"));
  expect(stored).toMatchObject({ inputUsdPerMillion: 0, cachedUsdPerMillion: 0, cacheWriteUsdPerMillion: 0, outputUsdPerMillion: 0, priorityMultiplier: 0, longInputMultiplier: 1, longOutputMultiplier: 1, unavailableRates: [] });
  for (const viewport of [{ width: 1536, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("link", { name: "模型價格" }).click();
    await expect(row).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`auto-review-${viewport.width}.png`) });
  }
  await page.goto("/models");
  const model = page.getByRole("row").filter({ hasText: "codex-auto-review" });
  await expect(model).toContainText("$0.00");
  await expect(model).not.toContainText("未定價");
  await model.getByRole("link").click();
  await expect(page.locator("tbody tr")).toHaveCount(7);
  await page.locator("tbody a").first().click();
  await expect(page.getByRole("heading", { name: "每回合用量" })).toBeVisible();
  await expect(page.locator("tbody tr")).toHaveCount(12);
  for (const amount of await page.locator("tbody td:last-child").allTextContents()) expect(amount).toBe("US$0.00");
  await page.getByRole("link", { name: "返回 Sessions" }).click();
  await page.getByRole("combobox", { name: "估算狀態", exact: true }).selectOption("unpriced");
  await expect(page.getByRole("heading", { name: "沒有符合條件的 Session" })).toBeVisible();
  expect(errors).toEqual([]);
});
