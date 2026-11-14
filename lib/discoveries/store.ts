import {
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
  writeBatch,
  type DocumentSnapshot,
  type Firestore,
} from "firebase/firestore";

import type { TaskStatus } from "@/lib/domain/discovery";

import {
  activityTypeFor,
  projectPatch,
  taskPatch,
  toProjectView,
  toTaskView,
  type ProjectView,
  type TaskEdit,
  type TaskView,
} from "./model";

/**
 * Reads and review writes for discoveries, from the browser under the
 * signed-in user's security rules. Users change only their own decisions
 * (status, priority, wording, project); evidence stays server-owned.
 */
const userPath = (uid: string, ...segments: string[]) => ["users", uid, ...segments].join("/");

export const PAGE_SIZE = 25;

export type TaskPage = { tasks: TaskView[]; cursor: DocumentSnapshot | null };

export async function listTasks(
  db: Firestore,
  uid: string,
  status: TaskStatus,
  after: DocumentSnapshot | null = null,
): Promise<TaskPage> {
  const base = [where("status", "==", status), orderBy("discoveredAt", "desc")];
  const snapshot = await getDocs(
    query(
      collection(db, userPath(uid, "tasks")),
      ...base,
      ...(after ? [startAfter(after)] : []),
      limit(PAGE_SIZE),
    ),
  );
  return {
    tasks: snapshot.docs.map((entry) => toTaskView(entry.id, entry.data())),
    cursor: snapshot.size === PAGE_SIZE ? (snapshot.docs.at(-1) ?? null) : null,
  };
}

/** Records a user's decision on a task, with an activity log entry, atomically. */
export async function reviewTask(db: Firestore, uid: string, taskId: string, edit: TaskEdit): Promise<void> {
  const patch = taskPatch(edit);
  const batch = writeBatch(db);
  batch.update(doc(db, userPath(uid, "tasks", taskId)), {
    ...patch,
    lastReviewedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  batch.set(doc(collection(db, userPath(uid, "activityLogs"))), {
    type: activityTypeFor(edit),
    targetId: taskId,
    createdAt: serverTimestamp(),
  });
  await batch.commit();
}

export async function listProjects(db: Firestore, uid: string): Promise<ProjectView[]> {
  const snapshot = await getDocs(
    query(collection(db, userPath(uid, "projects")), orderBy("lastActivityAt", "desc"), limit(100)),
  );
  return snapshot.docs.map((entry) => toProjectView(entry.id, entry.data()));
}

export type ConversationLink = { id: string; title: string; sourceUrl: string | null; updated: Date | null };

export type ProjectDetail = {
  project: ProjectView;
  tasks: TaskView[];
  conversations: ConversationLink[];
};

const MAX_LINKED_CONVERSATIONS = 20;

export async function loadProject(db: Firestore, uid: string, projectId: string): Promise<ProjectDetail | null> {
  const snapshot = await getDoc(doc(db, userPath(uid, "projects", projectId)));
  if (!snapshot.exists()) return null;
  const project = toProjectView(snapshot.id, snapshot.data());

  const taskSnapshot = await getDocs(
    query(collection(db, userPath(uid, "tasks")), where("projectId", "==", projectId), limit(200)),
  );
  const conversations = await Promise.all(
    project.conversationIds.slice(0, MAX_LINKED_CONVERSATIONS).map(async (id) => {
      const entry = await getDoc(doc(db, userPath(uid, "conversations", id)));
      const data = entry.data();
      if (!data) return null;
      const updated = data.updatedAtSource as { toDate?: () => Date } | null | undefined;
      return {
        id,
        title: typeof data.title === "string" && data.title ? data.title : "Untitled conversation",
        sourceUrl: typeof data.sourceUrl === "string" ? data.sourceUrl : null,
        updated: updated?.toDate ? updated.toDate() : null,
      } satisfies ConversationLink;
    }),
  );

  return {
    project,
    tasks: taskSnapshot.docs.map((entry) => toTaskView(entry.id, entry.data())),
    conversations: conversations.filter((entry): entry is ConversationLink => entry !== null),
  };
}

export async function editProject(
  db: Firestore,
  uid: string,
  projectId: string,
  edit: { name?: string; description?: string; archived?: boolean },
): Promise<void> {
  const batch = writeBatch(db);
  batch.update(doc(db, userPath(uid, "projects", projectId)), {
    ...projectPatch(edit),
    updatedAt: serverTimestamp(),
  });
  await batch.commit();
}
