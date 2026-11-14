import { readFileSync } from "node:fs";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  collectionGroup,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  updateDoc,
  type Firestore,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";

const ALICE = "alice";
const BOB = "bob";

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-recall",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

function verified(uid: string): Firestore {
  return env
    .authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true })
    .firestore() as unknown as Firestore;
}

function unverified(uid: string): Firestore {
  return env
    .authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: false })
    .firestore() as unknown as Firestore;
}

function anonymous(): Firestore {
  return env.unauthenticatedContext().firestore() as unknown as Firestore;
}

/** Write documents with rules disabled, as the server would. */
async function seed(write: (db: Firestore) => Promise<void>): Promise<void> {
  await env.withSecurityRulesDisabled(async (context) => {
    await write(context.firestore() as unknown as Firestore);
  });
}

const now = () => serverTimestamp();

const userDoc = () => ({ createdAt: now(), updatedAt: now() });

const conversationDoc = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "claude",
  sourceConversationId: "5f0c7b2e-14d9-4a3e-b8c6-91e2f7a0d435",
  title: "Synthetic conversation",
  messageCount: 4,
  chunkCount: 1,
  contentHash: "hash-1",
  excluded: false,
  needsAnalysis: true,
  importId: "import-1",
  createdAt: now(),
  updatedAt: now(),
  ...overrides,
});

const chunkDoc = (overrides: Record<string, unknown> = {}) => ({
  index: 0,
  messages: [{ id: "m1", sender: "human", text: "Synthetic text" }],
  charCount: 14,
  updatedAt: now(),
  ...overrides,
});

const importDoc = (overrides: Record<string, unknown> = {}) => ({
  sourceId: "claude",
  status: "parsing",
  fingerprint: "fp-1",
  cursor: 0,
  createdAt: now(),
  updatedAt: now(),
  ...overrides,
});

const seededTask = {
  title: "Finish the synthetic report",
  description: "",
  status: "awaiting_review",
  priority: "medium",
  priorityRank: 2,
  category: "unfinished_deliverable",
  confidence: 0.8,
  evidence: [{ conversationId: "claude_c1", messageId: "m1", quote: "I will finish it" }],
  sourceConversationId: "claude_c1",
  projectId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const seededProject = {
  name: "Synthetic project",
  description: "",
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** One document of every private kind under a user, written as the server. */
async function seedWorkspace(uid: string): Promise<void> {
  await seed(async (db) => {
    const at = new Date();
    await setDoc(doc(db, `users/${uid}`), { createdAt: at, updatedAt: at });
    await setDoc(doc(db, `users/${uid}/conversations/c1`), {
      ...conversationDoc(),
      createdAt: at,
      updatedAt: at,
    });
    await setDoc(doc(db, `users/${uid}/conversations/c1/chunks/0`), {
      ...chunkDoc(),
      updatedAt: at,
    });
    await setDoc(doc(db, `users/${uid}/imports/import-1`), {
      ...importDoc(),
      createdAt: at,
      updatedAt: at,
    });
    await setDoc(doc(db, `users/${uid}/tasks/t1`), seededTask);
    await setDoc(doc(db, `users/${uid}/projects/p1`), seededProject);
    await setDoc(doc(db, `users/${uid}/jobs/j1`), { stage: "screening", cursor: 0 });
    await setDoc(doc(db, `users/${uid}/usage/2026-11-14`), { aiRequests: 3 });
    await setDoc(doc(db, `users/${uid}/reports/2026-W46`), { summary: "synthetic" });
  });
}

const PRIVATE_PATHS = [
  "",
  "/conversations/c1",
  "/conversations/c1/chunks/0",
  "/imports/import-1",
  "/tasks/t1",
  "/projects/p1",
  "/jobs/j1",
  "/usage/2026-11-14",
  "/reports/2026-W46",
];

describe("1. unauthenticated users cannot read private data", () => {
  it.each(PRIVATE_PATHS)("denies get on users/alice%s", async (suffix) => {
    await seedWorkspace(ALICE);
    await assertFails(getDoc(doc(anonymous(), `users/${ALICE}${suffix}`)));
  });

  it("denies listing a subcollection", async () => {
    await seedWorkspace(ALICE);
    await assertFails(getDocs(collection(anonymous(), `users/${ALICE}/tasks`)));
  });
});

describe("2. unauthenticated users cannot write private data", () => {
  it("denies creating a profile, conversation or import", async () => {
    const db = anonymous();
    await assertFails(setDoc(doc(db, `users/${ALICE}`), userDoc()));
    await assertFails(setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc()));
    await assertFails(setDoc(doc(db, `users/${ALICE}/imports/i1`), importDoc()));
  });

  it("denies deleting existing data", async () => {
    await seedWorkspace(ALICE);
    await assertFails(deleteDoc(doc(anonymous(), `users/${ALICE}/tasks/t1`)));
  });
});

describe("3. user A cannot read user B's documents", () => {
  it.each(PRIVATE_PATHS)("denies bob reading users/alice%s", async (suffix) => {
    await seedWorkspace(ALICE);
    await assertFails(getDoc(doc(verified(BOB), `users/${ALICE}${suffix}`)));
  });

  it("denies bob listing alice's conversations and tasks", async () => {
    await seedWorkspace(ALICE);
    await assertFails(getDocs(collection(verified(BOB), `users/${ALICE}/conversations`)));
    await assertFails(getDocs(collection(verified(BOB), `users/${ALICE}/tasks`)));
  });

  it("denies listing the users collection and collection-group queries", async () => {
    await seedWorkspace(ALICE);
    await assertFails(getDocs(collection(verified(BOB), "users")));
    await assertFails(getDocs(collectionGroup(verified(BOB), "tasks")));
    await assertFails(getDocs(collectionGroup(verified(ALICE), "tasks")));
  });
});

describe("4. user A cannot modify user B's documents", () => {
  it("denies create, update and delete across users", async () => {
    await seedWorkspace(ALICE);
    const db = verified(BOB);
    await assertFails(setDoc(doc(db, `users/${ALICE}/conversations/c2`), conversationDoc()));
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), { status: "dismissed", updatedAt: now() }),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/conversations/c1`), { excluded: true, updatedAt: now() }),
    );
    await assertFails(deleteDoc(doc(db, `users/${ALICE}/conversations/c1`)));
    await assertFails(deleteDoc(doc(db, `users/${ALICE}/tasks/t1`)));
    await assertFails(setDoc(doc(db, `users/${ALICE}`), userDoc()));
  });
});

describe("5. ownership and creation fields cannot be manipulated", () => {
  it("rejects an owner field, because ownership is the path", async () => {
    await assertFails(
      setDoc(doc(verified(ALICE), `users/${ALICE}`), { ...userDoc(), uid: BOB }),
    );
    await assertFails(
      setDoc(
        doc(verified(ALICE), `users/${ALICE}/conversations/c1`),
        conversationDoc({ ownerId: BOB }),
      ),
    );
  });

  it("rejects a client-chosen createdAt", async () => {
    await assertFails(
      setDoc(doc(verified(ALICE), `users/${ALICE}`), {
        createdAt: new Date("2020-01-01"),
        updatedAt: now(),
      }),
    );
  });

  it("rejects changing createdAt or source identifiers after creation", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/conversations/c1`), { createdAt: now(), updatedAt: now() }),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/conversations/c1`), {
        sourceConversationId: "another",
        updatedAt: now(),
      }),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/imports/import-1`), {
        fingerprint: "changed",
        updatedAt: now(),
      }),
    );
  });

  it("rejects deleting the profile document from the client", async () => {
    await seedWorkspace(ALICE);
    await assertFails(deleteDoc(doc(verified(ALICE), `users/${ALICE}`)));
  });
});

describe("6. owners can access their own authorised records", () => {
  it("reads every private document kind", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    for (const suffix of PRIVATE_PATHS) {
      await assertSucceeds(getDoc(doc(db, `users/${ALICE}${suffix}`)));
    }
    await assertSucceeds(getDocs(collection(db, `users/${ALICE}/tasks`)));
  });

  it("creates and updates a profile", async () => {
    const db = verified(ALICE);
    await assertSucceeds(setDoc(doc(db, `users/${ALICE}`), userDoc()));
    await assertSucceeds(
      updateDoc(doc(db, `users/${ALICE}`), {
        aiConsentAccepted: true,
        aiConsentAt: now(),
        aiConsentVersion: 1,
        updatedAt: now(),
      }),
    );
  });

  it("runs the import writes: source, index, import, conversation, chunk", async () => {
    const db = verified(ALICE);
    await assertSucceeds(
      setDoc(doc(db, `users/${ALICE}/sources/claude`), {
        platform: "claude",
        adapterVersion: 1,
        createdAt: now(),
        updatedAt: now(),
      }),
    );
    await assertSucceeds(
      setDoc(doc(db, `users/${ALICE}/sourceIndex/claude_0`), {
        sourceId: "claude",
        entries: { c1: "hash-1" },
        updatedAt: now(),
      }),
    );
    await assertSucceeds(setDoc(doc(db, `users/${ALICE}/imports/i1`), importDoc()));
    await assertSucceeds(
      updateDoc(doc(db, `users/${ALICE}/imports/i1`), {
        status: "writing",
        cursor: 20,
        updatedAt: now(),
      }),
    );
    await assertSucceeds(setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc()));
    await assertSucceeds(setDoc(doc(db, `users/${ALICE}/conversations/c1/chunks/0`), chunkDoc()));
    await assertSucceeds(
      updateDoc(doc(db, `users/${ALICE}/conversations/c1`), { excluded: true, updatedAt: now() }),
    );
    await assertSucceeds(deleteDoc(doc(db, `users/${ALICE}/conversations/c1/chunks/0`)));
    await assertSucceeds(deleteDoc(doc(db, `users/${ALICE}/conversations/c1`)));
  });

  it("records review decisions on a task and edits a project", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    await assertSucceeds(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), {
        status: "approved",
        priority: "high",
        priorityRank: 3,
        lastReviewedAt: now(),
        updatedAt: now(),
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, `users/${ALICE}/projects/p1`), { name: "Renamed", updatedAt: now() }),
    );
    await assertSucceeds(
      setDoc(doc(db, `users/${ALICE}/activityLogs/a1`), {
        type: "task_approved",
        targetId: "t1",
        createdAt: now(),
      }),
    );
    await assertSucceeds(deleteDoc(doc(db, `users/${ALICE}/tasks/t1`)));
  });
});

describe("7. unknown paths are denied", () => {
  it("denies every client the shared usage counter", async () => {
    await seed(async (db) => {
      await setDoc(doc(db, "usage/2026-11-14"), { aiRequests: 3 });
    });
    for (const db of [verified(ALICE), unverified(ALICE), anonymous()]) {
      await assertFails(getDoc(doc(db, "usage/2026-11-14")));
      await assertFails(setDoc(doc(db, "usage/2026-11-14"), { aiRequests: 0 }));
      await assertFails(deleteDoc(doc(db, "usage/2026-11-14")));
    }
  });

  it("denies top-level collections other than users", async () => {
    const db = verified(ALICE);
    await assertFails(setDoc(doc(db, "admin/config"), { open: true }));
    await assertFails(getDoc(doc(db, "admin/config")));
    await assertFails(setDoc(doc(db, "tasks/t1"), { title: "x" }));
  });

  it("denies unknown subcollections under the owner's own path", async () => {
    const db = verified(ALICE);
    await assertFails(setDoc(doc(db, `users/${ALICE}/unknown/x`), { a: 1 }));
    await assertFails(getDoc(doc(db, `users/${ALICE}/unknown/x`)));
    await assertFails(setDoc(doc(db, `users/${ALICE}/evidence/e1`), { quote: "x" }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/tasks/t1/notes/n1`), { a: 1 }));
  });
});

describe("8. invalid fields are rejected", () => {
  it("rejects unknown fields", async () => {
    const db = verified(ALICE);
    await assertFails(setDoc(doc(db, `users/${ALICE}`), { ...userDoc(), role: "admin" }));
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc({ extra: 1 })),
    );
    await assertFails(setDoc(doc(db, `users/${ALICE}/imports/i1`), importDoc({ extra: 1 })));
  });

  it("rejects wrong types", async () => {
    const db = verified(ALICE);
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc({ messageCount: "4" })),
    );
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc({ excluded: "no" })),
    );
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/conversations/c1`), conversationDoc({ messageCount: -1 })),
    );
  });

  it("rejects missing required fields", async () => {
    const withoutHash = Object.fromEntries(
      Object.entries(conversationDoc()).filter(([key]) => key !== "contentHash"),
    );
    await assertFails(
      setDoc(doc(verified(ALICE), `users/${ALICE}/conversations/c1`), withoutHash),
    );
  });

  it("rejects oversize strings and lists", async () => {
    const db = verified(ALICE);
    await assertFails(
      setDoc(
        doc(db, `users/${ALICE}/conversations/c1`),
        conversationDoc({ title: "x".repeat(501) }),
      ),
    );
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/conversations/c1/chunks/0`), chunkDoc({ charCount: 300001 })),
    );
    await assertFails(
      setDoc(
        doc(db, `users/${ALICE}/imports/i1`),
        importDoc({ errors: Array.from({ length: 51 }, () => "e") }),
      ),
    );
  });

  it("rejects invalid enum values", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    await assertFails(setDoc(doc(db, `users/${ALICE}/imports/i2`), importDoc({ status: "done" })));
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), { status: "archived", updatedAt: now() }),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), {
        priority: "urgent",
        priorityRank: 3,
        updatedAt: now(),
      }),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), {
        priority: "high",
        priorityRank: 1,
        updatedAt: now(),
      }),
    );
    await assertFails(
      setDoc(doc(db, `users/${ALICE}/sources/chatgpt`), {
        platform: "chatgpt",
        adapterVersion: 1,
        createdAt: now(),
        updatedAt: now(),
      }),
    );
  });
});

describe("9. clients cannot write server-owned data", () => {
  it("denies creating tasks and projects", async () => {
    const db = verified(ALICE);
    await assertFails(setDoc(doc(db, `users/${ALICE}/tasks/t9`), seededTask));
    await assertFails(setDoc(doc(db, `users/${ALICE}/projects/p9`), seededProject));
  });

  it("denies editing evidence, confidence, category or source on a task", async () => {
    await seedWorkspace(ALICE);
    const ref = doc(verified(ALICE), `users/${ALICE}/tasks/t1`);
    await assertFails(updateDoc(ref, { evidence: [], updatedAt: now() }));
    await assertFails(updateDoc(ref, { confidence: 1, updatedAt: now() }));
    await assertFails(updateDoc(ref, { category: "follow_up", updatedAt: now() }));
    await assertFails(updateDoc(ref, { sourceConversationId: "other", updatedAt: now() }));
  });

  it("denies writing jobs, usage and reports", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    await assertFails(updateDoc(doc(db, `users/${ALICE}/usage/2026-11-14`), { aiRequests: 0 }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/usage/2026-11-15`), { aiRequests: 0 }));
    await assertFails(deleteDoc(doc(db, `users/${ALICE}/usage/2026-11-14`)));
    await assertFails(updateDoc(doc(db, `users/${ALICE}/jobs/j1`), { cursor: 99 }));
    await assertFails(setDoc(doc(db, `users/${ALICE}/reports/2026-W47`), { summary: "x" }));
  });

  it("denies setting or changing the analysis field on a conversation", async () => {
    await seedWorkspace(ALICE);
    const db = verified(ALICE);
    await assertFails(
      setDoc(
        doc(db, `users/${ALICE}/conversations/c2`),
        conversationDoc({ analysis: { state: "done" } }),
      ),
    );
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/conversations/c1`), {
        analysis: { state: "done" },
        updatedAt: now(),
      }),
    );
  });

  it("denies editing an activity log entry", async () => {
    const db = verified(ALICE);
    const ref = doc(db, `users/${ALICE}/activityLogs/a1`);
    await assertSucceeds(setDoc(ref, { type: "import_started", createdAt: now() }));
    await assertFails(updateDoc(ref, { type: "data_deleted" }));
  });
});

describe("10. unverified accounts cannot write", () => {
  it("denies writes but allows reading the owner's own data", async () => {
    await seedWorkspace(ALICE);
    const db = unverified(ALICE);
    await assertFails(setDoc(doc(db, `users/${ALICE}/conversations/c2`), conversationDoc()));
    await assertFails(
      updateDoc(doc(db, `users/${ALICE}/tasks/t1`), { status: "approved", updatedAt: now() }),
    );
    await assertFails(deleteDoc(doc(db, `users/${ALICE}/tasks/t1`)));
    await assertSucceeds(getDoc(doc(db, `users/${ALICE}/tasks/t1`)));
  });

  it("denies creating a profile before verification", async () => {
    await assertFails(setDoc(doc(unverified(ALICE), `users/${ALICE}`), userDoc()));
  });
});
