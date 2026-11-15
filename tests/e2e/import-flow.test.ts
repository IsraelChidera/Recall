import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import puppeteer, { type Browser, type ElementHandle, type Page } from "puppeteer-core";
import { afterAll, beforeAll, expect, it } from "vitest";

import { makeConversation, makeConversations, makeExportZip, makeZip } from "../fixtures/claude-export";

/**
 * The whole import journey in a real browser: sign in, preview, save,
 * re-import, incremental import and deletion, checked against what is
 * actually stored in the Firestore emulator.
 */
const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const PROJECT = "demo-recall";
const AUTH = "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1";
const FIRESTORE = `http://127.0.0.1:8080/v1/projects/${PROJECT}/databases/(default)/documents`;
const EMAIL = "e2e@example.com";
const PASSWORD = "correct-horse-battery";
const CHROME = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium-browser"].find(
  (path): path is string => Boolean(path && existsSync(path)),
);

let server: ChildProcess;
let browser: Browser;
let page: Page;
let uid = "";
const files = { first: "", same: "", newer: "", projects: "" };
const consoleErrors: string[] = [];

async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Counts stored documents with rules bypassed, as an administrator would. */
async function storedCount(path: string): Promise<number> {
  const response = await fetch(`${FIRESTORE}/users/${uid}/${path}?pageSize=300`, {
    headers: { Authorization: "Bearer owner" },
  });
  const body = (await response.json()) as { documents?: unknown[] };
  return body.documents?.length ?? 0;
}

/** Waits for text to appear; on timeout, reports what the page showed instead. */
async function waitForText(text: string, timeout = 120_000) {
  try {
    await page.waitForFunction((needle) => document.body.innerText.includes(needle), { timeout }, text);
  } catch {
    const shown = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 600));
    throw new Error(`Timed out waiting for "${text}". The page showed: ${shown}`);
  }
}

/** Saves a screenshot when E2E_SCREENSHOTS names a folder; CI uploads them for review. */
async function shot(name: string) {
  const dir = process.env.E2E_SCREENSHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
  // Optionally also write a small copy into the log, for reviewing a CI run
  // from somewhere the artifact store cannot be reached. Synthetic data only.
  if (process.env.E2E_SCREENSHOTS_TO_LOG === "true") {
    const jpeg = Buffer.from(await page.screenshot({ type: "jpeg", quality: 55, fullPage: true })).toString("base64");
    const size = 3000;
    const parts = Math.ceil(jpeg.length / size);
    for (let part = 0; part < parts; part++) {
      console.log(`SHOT ${name} ${part + 1}/${parts} ${jpeg.slice(part * size, (part + 1) * size)}`);
    }
  }
}

type StoredDoc = { name: string; fields?: Record<string, { stringValue?: string }> };

async function storedDocs(path: string): Promise<StoredDoc[]> {
  const response = await fetch(`${FIRESTORE}/users/${uid}/${path}?pageSize=300`, {
    headers: { Authorization: "Bearer owner" },
  });
  return ((await response.json()) as { documents?: StoredDoc[] }).documents ?? [];
}

async function clickTab(label: string) {
  const handle = await page.waitForFunction(
    (needle) => [...document.querySelectorAll("[role=tab]")].find((tab) => tab.textContent?.startsWith(needle)),
    { timeout: 120_000 },
    label,
  );
  await (handle.asElement() as ElementHandle<Element>).click();
}

async function clickButton(label: string) {
  const handle = await page.waitForFunction(
    (needle) =>
      [...document.querySelectorAll("button")].find(
        (button) => button.textContent?.trim() === needle && !button.disabled,
      ),
    { timeout: 120_000 },
    label,
  );
  await (handle.asElement() as ElementHandle<Element>).click();
}

async function upload(...paths: string[]) {
  const input = (await page.waitForSelector("#export-files")) as ElementHandle<HTMLInputElement>;
  await input.uploadFile(...paths);
}

beforeAll(async () => {
  if (!CHROME) throw new Error("Chrome not found. Set CHROME_PATH.");

  const dir = mkdtempSync(join(tmpdir(), "recall-e2e-"));
  const original = makeConversations(60);
  const withBroken = [...original, { name: "unreadable" }];
  const grown = makeConversation(1, { planted: "brainstorm", branch: false, turns: 12 });
  const newer = [original[0], grown, ...original.slice(2), makeConversation(500), makeConversation(501)];
  files.first = join(dir, "conversations-000.zip");
  files.newer = join(dir, "conversations-newer.zip");
  files.projects = join(dir, "projects-000.zip");
  writeFileSync(files.first, await makeExportZip(withBroken));
  writeFileSync(files.newer, await makeExportZip(newer));
  writeFileSync(files.projects, await makeZip({ "projects/a.json": "{}" }));

  const account = await post(`${AUTH}/accounts:signUp?key=demo-key`, {
    email: EMAIL,
    password: PASSWORD,
    returnSecureToken: true,
  });
  uid = String(account.localId);
  await post(
    `${AUTH}/accounts:update?key=demo-key`,
    { localId: uid, emailVerified: true },
    { Authorization: "Bearer owner" },
  );

  // The test runner sets NODE_ENV=test, under which Next.js ignores .env.local.
  // The app under test must run as it does in production.
  server = spawn("npx", ["next", "start", "-p", String(PORT)], {
    stdio: "ignore",
    detached: true,
    env: { ...process.env, NODE_ENV: "production" },
  });
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch(BASE)).ok) break;
    } catch {
      // not up yet
    }
    if (attempt > 60) throw new Error("The app did not start.");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 1000 });
  // The Firestore emulator sometimes holds a streamed request for close to a
  // minute before answering. Waits are sized so that slows a run down
  // without failing it.
  page.setDefaultTimeout(120_000);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${String(error)}`));

  await page.goto(`${BASE}/login`);
  await page.waitForSelector("#email");
  await new Promise((resolve) => setTimeout(resolve, 500));
  await page.type("#email", EMAIL);
  await page.type("#password", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForFunction(() => location.pathname === "/dashboard", { timeout: 30_000 });
});

afterAll(async () => {
  await browser?.close();
  if (server?.pid) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
});

it("creates the profile document on first entry", async () => {
  await waitForText("Nothing imported yet");
  await expect
    .poll(async () => (await fetch(`${FIRESTORE}/users/${uid}`, { headers: { Authorization: "Bearer owner" } })).status, {
      timeout: 15_000,
    })
    .toBe(200);
  expect(await page.evaluate(() => document.body.innerText)).not.toContain("could not reach your workspace");
});

it("previews an export without saving anything", async () => {
  await page.goto(`${BASE}/import`);
  await waitForText("Nothing has been saved yet.");
  await upload(files.first, files.projects);
  await waitForText("Found 60 conversations");
  await waitForText("60 new and 0 changed");
  await waitForText("1 conversation could not be read");
  expect(await storedCount("conversations")).toBe(0);
  expect(await storedCount("imports")).toBe(0);
});

it("saves the conversations when asked", async () => {
  await clickButton("Save 60 conversations");
  await waitForText("Saved 60 conversations");
  await shot("import-saved");
  expect(await storedCount("conversations")).toBe(60);
  expect(await storedCount("imports")).toBe(1);
  expect(await storedCount("sources")).toBe(1);
  await waitForText("60 saved");
});

it("finds nothing to save when the same export is uploaded again", async () => {
  await clickButton("Import more");
  await upload(files.first);
  await waitForText("Nothing new in this export");
  const saveButtons = await page.evaluate(
    () => [...document.querySelectorAll("button")].filter((b) => b.textContent?.startsWith("Save ")).length,
  );
  expect(saveButtons).toBe(0);
  expect(await storedCount("conversations")).toBe(60);
  expect(await storedCount("imports")).toBe(1);
});

it("saves only what is new or changed from a newer export", async () => {
  await clickButton("Import different files");
  await upload(files.newer);
  await waitForText("2 new and 1 changed");
  await clickButton("Save 3 conversations");
  await waitForText("Saved 3 conversations");
  expect(await storedCount("conversations")).toBe(62);
  expect(await storedCount("imports")).toBe(2);
});

it("asks for consent before any AI request is made", async () => {
  await page.goto(`${BASE}/dashboard`);
  await waitForText("Before Recall reads your conversations with AI");
  await shot("dashboard-consent");
  const disabled = await page.evaluate(
    () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Allow AI analysis")?.disabled,
  );
  expect(disabled).toBe(true);
  expect(await storedCount("usage")).toBe(0);
  expect(await storedCount("jobs")).toBe(0);

  await page.click("input[type=checkbox]");
  await clickButton("Allow AI analysis");
  await waitForText("62 conversations are waiting to be analysed");
});

it("lets the user leave a conversation out", async () => {
  await page.click("details > summary");
  const first = await page.waitForSelector("details input[type=checkbox]");
  await first!.click();
  await waitForText("1 left out");
  await waitForText("61 conversations are waiting to be analysed");
});

it("analyses the conversations and shows findings with their quotes", async () => {
  await clickButton("Start analysis");
  await waitForText("Analysis complete", 150_000);
  await waitForText("1 discovery to review");
  await shot("dashboard-analysis-complete");
  await waitForText("I will finish the synthetic migration report by Friday.");
  // 15 identical commitments merged into one open task; 15 already finished.
  expect(await storedCount("tasks")).toBe(16);
  expect(await storedCount("projects")).toBe(1);
  expect(await storedCount("usage")).toBe(1);
  expect(await storedCount("jobs")).toBe(1);
  expect(await page.evaluate(() => document.body.innerText)).toMatch(/\d+ of 150 AI requests used today/);
});

it("reviews a discovery in the inbox: edit, approve, undo, approve", async () => {
  await page.click('main a[href="/inbox"]');
  await page.waitForFunction(() => location.pathname === "/inbox");
  await waitForText("I will finish the synthetic migration report by Friday.");
  await waitForText("Open in Claude");
  await shot("inbox-to-review");

  await clickButton("Edit");
  const title = (await page.waitForSelector('input[id$="-title"]')) as ElementHandle<HTMLInputElement>;
  await title.click({ count: 3 });
  await title.type("Send the synthetic migration report");
  await page.select('select[id$="-priority"]', "high");
  await shot("inbox-editing");
  await clickButton("Save changes");
  await waitForText("Saved changes: ");
  await waitForText("Send the synthetic migration report");
  await waitForText("High priority");

  await clickButton("Approve");
  await waitForText("Approved: ");
  await waitForText("Nothing is waiting for you");
  await clickButton("Undo");
  await waitForText("I will finish the synthetic migration report by Friday.");
  await clickButton("Approve");
  await waitForText("Nothing is waiting for you");

  const approved = (await storedDocs("tasks")).filter((task) => task.fields?.status?.stringValue === "approved");
  expect(approved).toHaveLength(1);
  expect(approved[0]!.fields?.title?.stringValue).toBe("Send the synthetic migration report");
  expect(approved[0]!.fields?.priority?.stringValue).toBe("high");

  await clickTab("Approved");
  await waitForText("Move back to review");
  await shot("inbox-approved");
  await clickTab("Done");
  await waitForText("Reopen", 5_000).catch(() => {});
  await shot("inbox-done");
});

it("shows a project with its outstanding work and conversations", async () => {
  await page.goto(`${BASE}/projects`);
  const link = (await page.waitForSelector('main a[href^="/projects/"]')) as ElementHandle<HTMLAnchorElement>;
  await shot("projects-list");
  await link.click();
  await waitForText("Related conversations");
  await waitForText("Outstanding (");
  await shot("project-detail");
  await page.setViewport({ width: 390, height: 900 });
  await shot("project-detail-mobile");
  await page.goto(`${BASE}/inbox`);
  await waitForText("To review");
  await clickTab("Approved");
  await waitForText("Move back to review");
  await shot("inbox-approved-mobile");
  await page.setViewport({ width: 1280, height: 1000 });
});

it("runs approved work from the Execution Inbox: start, remind, regroup", async () => {
  await page.goto(`${BASE}/execute`);
  await waitForText("Send the synthetic migration report");
  await waitForText("High priority (1)");
  await clickButton("Start");
  await waitForText("Started: ");
  await waitForText("In progress");

  await clickButton("Edit");
  const remind = (await page.waitForSelector('input[id$="-remind"]')) as ElementHandle<HTMLInputElement>;
  const tomorrow = new Date(Date.now() + 86_400_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  // Typed the way a person types into a date field: month, day, year.
  await remind.type(`${pad(tomorrow.getMonth() + 1)}${pad(tomorrow.getDate())}${tomorrow.getFullYear()}`);
  await clickButton("Save changes");
  await waitForText("Reminder ");

  const [stored] = (await storedDocs("tasks")).filter((task) => task.fields?.status?.stringValue === "in_progress");
  expect(stored?.fields?.title?.stringValue).toBe("Send the synthetic migration report");
  expect((stored?.fields?.remindOn as { timestampValue?: string } | undefined)?.timestampValue).toBeTruthy();

  await clickButton("Project");
  await waitForText("Synthetic work (1)");
  await clickButton("Status");
  await waitForText("In progress (1)");
  await shot("execution");
});

it("shows the commitment under Forgotten Work, with the reason", async () => {
  await page.goto(`${BASE}/forgotten`);
  // The synthetic conversations are dated months ago, so the commitment has gone quiet.
  await waitForText("You said you would do this, and the conversation has been quiet for");
  await waitForText("It is marked as in progress.");
  await waitForText("Send the synthetic migration report");
  await shot("forgotten");
});

it("summarises the week and the day", async () => {
  await page.goto(`${BASE}/weekly`);
  await waitForText("Suggested priorities");
  // The reminder is set for tomorrow, so it is not yet the reason.
  await waitForText("High priority, and you have already started.");
  await waitForText("Projects needing attention");
  await shot("weekly");

  await page.goto(`${BASE}/dashboard`);
  await waitForText("Needs your attention");
  await waitForText("1 commitment has gone quiet");
  await waitForText("Important commitments");
  await waitForText("Active projects");
  await waitForText("Reminders");
  await shot("dashboard-overview");
  await page.setViewport({ width: 390, height: 900 });
  await shot("dashboard-overview-mobile");
  await page.setViewport({ width: 1280, height: 1000 });
});

it("deletes everything on request, including what was discovered", async () => {
  await page.goto(`${BASE}/import`);
  await clickButton("Delete all imported conversations");
  await clickButton("Delete everything");
  await waitForText("Nothing has been saved yet.");
  expect(await storedCount("conversations")).toBe(0);
  expect(await storedCount("imports")).toBe(0);
  expect(await storedCount("sourceIndex")).toBe(0);
  expect(await storedCount("tasks")).toBe(0);
  expect(await storedCount("projects")).toBe(0);
});

it("logs no errors in the browser console", () => {
  expect(consoleErrors).toEqual([]);
});
