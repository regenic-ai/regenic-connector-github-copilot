import { createHash, randomUUID } from "node:crypto";
import type {
  ExecutorContext,
  ExecutorRecipeRef,
  ExecutorResumeInput,
  ExecutorRunHandle,
  ExecutorStartInput,
  TaskExecutor,
  ThreadPrompt,
  WorkRun,
} from "@regenic/connector-contract";
import type {
  CopilotSession as CopilotSessionType,
  PermissionHandler,
  PermissionRequest,
  PermissionRequestResult,
  SessionEvent,
} from "@github/copilot-sdk";
import {
  isCurrentActivation,
  registerActivationResource,
  requireExecutionActivation,
  type ActivationResource,
  type CopilotActivation,
} from "./activation";
import { EXECUTOR_TYPE, SOURCE } from "./constants";
import {
  bounded,
  configureManualPermissions,
  createCopilotClient,
  denyPermission,
  persistedSessionEvents,
  safeRuntimeError,
  sessionConfig,
  stopClient,
  type CopilotClientInstance,
} from "./sdk";
import { summarizeRunEvents } from "./session-events";
import {
  type OwnedSession,
  type SessionStatus,
  type StoredPendingPermission,
} from "./store";

interface PendingPermission {
  activationId: string;
  installationId: string;
  runId: string;
  recipeId: string;
  workItemId: string;
  sessionId: string;
  requestId: string;
  toolName: string;
  requestDigest: string;
  promptId: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
}

interface PermissionCandidate {
  sessionId: string;
  requestDigest: string;
  createdAt: number;
}

interface LiveSession extends ActivationResource {
  activation: CopilotActivation;
  entry: OwnedSession;
  client: CopilotClientInstance;
  session?: CopilotSessionType;
  broker: PermissionBroker;
  unsubscribe: () => void;
  unregister: () => void;
  closed: boolean;
  abortRequested: boolean;
  error?: Error;
  closePromise?: Promise<void>;
}

const liveSessions = new Map<string, LiveSession>();
const readPools = new Map<string, ReadPool>();
const runQueues = new Map<string, Promise<void>>();
const operationTimeoutMs = 8_000;

interface ReadPool extends ActivationResource {
  activation: CopilotActivation;
  client: CopilotClientInstance;
  sessions: Map<string, CopilotSessionType>;
  unregister: () => void;
  closed: boolean;
  closePromise?: Promise<void>;
}

export const githubCopilotTaskExecutor: TaskExecutor = {
  executor_type: EXECUTOR_TYPE,

  capabilities() {
    return {
      start: true,
      resume: true,
      status: true,
      prompts: true,
      local_workspace: false,
      wait: false,
    };
  },

  catalog() {
    return {
      executor_type: EXECUTOR_TYPE,
      label: "GitHub Copilot CLI",
      description: "Run an explicit task through the local GitHub Copilot CLI SDK.",
      source: SOURCE,
      attach: "absentee",
      fields: [],
    };
  },

  async start(input: ExecutorStartInput, context: ExecutorContext): Promise<ExecutorRunHandle> {
    const activation = requireExecutionActivation(context);
    const runId = input.run_id;
    if (!runId || !input.recipe.id || !input.work_item.id) {
      throw new Error("A durable run, recipe, and work-item identity are required.");
    }

    const existing = await activation.store.getByRunId(runId);
    if (existing) {
      assertRunOwnership(existing, activation, input.recipe, input.work_item.id);
      return handleForEntry(existing, await eventsForExisting(activation, existing));
    }

    const prompt = input.evidence_text.trim();
    if (!prompt) {
      throw new Error("The Copilot task prompt is empty.");
    }
    const sessionId = randomUUID();
    const entry: OwnedSession = {
      sessionId,
      installationId: activation.installationId,
      orgId: activation.orgId,
      runId,
      recipeId: input.recipe.id,
      workItemId: input.work_item.id,
      activationId: activation.activationId,
      copilotHome: activation.paths.copilotHome,
      workingDirectory: activation.paths.workingDirectory,
      availableTools: [...activation.settings.available_tools],
      createdAt: new Date().toISOString(),
      status: "creating",
      pendingPermissions: [],
    };
    await activation.store.begin(entry);

    let live: LiveSession | undefined;
    const deadline = Date.now() + operationTimeoutMs;
    try {
      live = await createLiveSession(activation, entry, false, undefined, deadline);
      const activeLive = live;
      const submission = await serializeRunOperation(
        activation,
        sessionId,
        async () => {
          const current = await activation.store.get(sessionId);
          if (!current || isTerminal(current.status)) {
            return { entry: current ?? entry };
          }
          if (current.status === "creating") {
            await activation.store.setStatus(sessionId, "created");
            current.status = "created";
          }
          if (current.status !== "created") {
            throw new Error("The Copilot run is not ready to send its prompt.");
          }
          await activation.store.setStatus(sessionId, "sending");
          current.status = "sending";
          return {
            entry: current,
            sendPromise: requireSession(activeLive).send(prompt),
          };
        },
      );
      entry.status = submission.entry.status;
      if (!submission.sendPromise) {
        await closeLiveSession(live);
        return handleForEntry(
          submission.entry,
          await eventsForExisting(activation, submission.entry),
        );
      }
      const messageId = await bounded(
        submission.sendPromise,
        remainingMs(deadline),
      );
      const current = await activation.store.get(sessionId);
      if (current && isTerminal(current.status)) {
        await closeLiveSession(live, undefined, current.status === "cancelled");
        return handleForEntry(current, await eventsForExisting(activation, current));
      }
      await activation.store.setStatus(sessionId, "sent", messageId);
      entry.status = "sent";
      entry.messageId = messageId;
      return handleForEntry(entry, []);
    } catch (error) {
      if (live) {
        await closeLiveSession(live).catch(() => {
          throw safeRuntimeError();
        });
      }
      const current = await activation.store.get(sessionId);
      if (current && isTerminal(current.status)) {
        return handleForEntry(current, await eventsForExisting(activation, current));
      }
      if (current?.status === "created") {
        await activation.store.setStatus(sessionId, "failed");
        throw safeRuntimeError();
      }
      if (
        current &&
        (current.status === "creating" || current.status === "sending" || current.status === "sent")
      ) {
        await activation.store.setStatus(sessionId, "uncertain").catch(() => undefined);
      }
      return handleForEntry(
        (await activation.store.get(sessionId)) ?? entry,
        [],
        "Copilot task submission is uncertain. It will not be sent again automatically.",
      );
    }
  },

  async resume(input: ExecutorResumeInput, context: ExecutorContext): Promise<ExecutorRunHandle> {
    const activation = requireExecutionActivation(context);
    const entry = await requireRunEntry(
      activation,
      input.run,
      input.recipe,
      input.work_item.id,
    );
    if (input.answer) {
      const live = await ensureLiveSession(activation, entry);
      await live.broker.answer(input.answer);
    }
    return handleForEntry(entry, await eventsForExisting(activation, entry));
  },

  async status(run: WorkRun, context: ExecutorContext): Promise<ExecutorRunHandle> {
    const activation = requireExecutionActivation(context);
    const entry = await requireRunEntry(activation, run, { id: run.recipe_id }, run.work_item_id);
    return handleForEntry(entry, await eventsForExisting(activation, entry));
  },

  async cancel(run: WorkRun, context: ExecutorContext): Promise<void> {
    const activation = requireExecutionActivation(context);
    const entry = await requireRunEntry(activation, run, { id: run.recipe_id }, run.work_item_id);
    if (isTerminal(entry.status)) {
      return;
    }
    await serializeRunOperation(activation, entry.sessionId, async () => {
      const current = await activation.store.get(entry.sessionId);
      if (!current || isTerminal(current.status)) {
        return;
      }
      let live = liveSessions.get(entry.sessionId);
      if (!live && current.status !== "uncertain" && current.status !== "creating") {
        live = await ensureLiveSession(activation, current);
      }
      if (live && live.activation.activationId !== activation.activationId) {
        throw new Error("The Copilot run belongs to a different activation.");
      }
      if (live) {
        try {
          await requestAbort(live);
        } catch {
          live.error = safeRuntimeError();
        }
        await closeLiveSession(live, undefined, true);
      } else {
        await activation.store.setStatus(entry.sessionId, "cancelled");
      }
    });
  },
};

export async function readSessionEvents(
  activation: CopilotActivation,
  entry: OwnedSession,
  signal?: AbortSignal,
): Promise<SessionEvent[]> {
  assertOwnedEntry(entry, activation);
  const live = liveSessions.get(entry.sessionId);
  if (!live && !isTerminal(entry.status) && entry.pendingPermissions.length > 0) {
    await ensureLiveSession(activation, entry, signal);
    return readSessionEvents(activation, entry, signal);
  }
  if (live) {
    if (live.activation.activationId !== activation.activationId || live.closed) {
      throw new Error("The Copilot session belongs to a different activation.");
    }
    if (live.error) {
      throw safeRuntimeError();
    }
    const events = await bounded(
      requireSession(live).getEvents(),
      operationTimeoutMs,
      signal,
    );
    await updateStatusFromEvents(activation, entry, events);
    return persistedSessionEvents(events);
  }
  const session = await getReadSession(activation, entry, signal);
  const events = await bounded(
    session.getEvents(),
    operationTimeoutMs,
    signal,
  );
  await updateStatusFromEvents(activation, entry, events);
  return persistedSessionEvents(events);
}

async function eventsForExisting(
  activation: CopilotActivation,
  entry: OwnedSession,
): Promise<SessionEvent[]> {
  if (
    entry.status === "creating" ||
    entry.status === "uncertain" ||
    entry.status === "cancelled"
  ) {
    return [];
  }
  return readSessionEvents(activation, entry);
}

async function createLiveSession(
  activation: CopilotActivation,
  entry: OwnedSession,
  resume: boolean,
  signal?: AbortSignal,
  deadline = Date.now() + operationTimeoutMs,
): Promise<LiveSession> {
  assertOwnedEntry(entry, activation);
  if (!isCurrentActivation(activation)) {
    throw new Error("The GitHub Copilot installation is stopping.");
  }

  const client = await bounded(
    createCopilotClient(activation.paths),
    remainingMs(deadline),
    signal,
  );
  const broker = new PermissionBroker(activation, entry, activation.settings.permission_timeout_ms);
  let unsubscribe: () => void = () => undefined;
  let unregister: () => void = () => undefined;
  let closePromise: Promise<void> | undefined;
  const live: LiveSession = {
    activation,
    entry,
    client,
    session: undefined,
    broker,
    unsubscribe: () => unsubscribe(),
    unregister: () => unregister(),
    closed: false,
    abortRequested: false,
    error: undefined,
    get closePromise() {
      return closePromise;
    },
    async close(closeSignal?: AbortSignal): Promise<void> {
      if (closePromise) {
        return closePromise;
      }
      live.closed = true;
      closePromise = (async () => {
        unsubscribe();
        const errors: unknown[] = [];
        try {
          await broker.denyAll();
        } catch (error) {
          errors.push(error);
        }
        if (live.session && !isTerminal(live.entry.status)) {
          try {
            await requestAbort(live, closeSignal);
          } catch {
            errors.push(safeRuntimeError());
          }
        }
        try {
          await stopClient(client, operationTimeoutMs, closeSignal);
        } catch (error) {
          errors.push(error);
        } finally {
          unregister();
          if (liveSessions.get(entry.sessionId) === live) {
            liveSessions.delete(entry.sessionId);
          }
        }
        if (errors.length > 0) {
          throw new Error("One or more Copilot runtime resources did not close cleanly.");
        }
      })();
      try {
        await closePromise;
      } catch {
        closePromise = undefined;
        throw new Error("Copilot runtime cleanup failed.");
      }
    },
  };
  broker.setFatalHandler(() => {
    live.error = safeRuntimeError();
    void live.close().catch(() => {
      live.error = safeRuntimeError();
    });
  });

  try {
    unregister = registerActivationResource(activation, live);
    liveSessions.set(entry.sessionId, live);
    await bounded(client.start(), remainingMs(deadline), signal);
    const currentEntry = await activation.store.get(entry.sessionId);
    if (
      !isCurrentActivation(activation) ||
      live.closed ||
      !currentEntry ||
      isTerminal(currentEntry.status)
    ) {
      throw new Error("The GitHub Copilot installation is stopping.");
    }
    const config = sessionConfig(
      activation.paths.workingDirectory,
      entry.availableTools,
      broker.onPermissionRequest,
    );
    const session = resume
      ? await bounded(
          client.resumeSession(entry.sessionId, config),
          remainingMs(deadline),
          signal,
        )
      : await bounded(
          client.createSession({
            ...config,
            sessionId: entry.sessionId,
          }),
          remainingMs(deadline),
          signal,
        );
    if (live.closed) {
      try {
        await bounded(session.abort(), operationTimeoutMs);
      } catch {
        // The client is already being stopped by the concurrent close.
      }
      throw new Error("The Copilot run was stopped during session startup.");
    }
    if (!session || session.sessionId !== entry.sessionId) {
      throw new Error("Copilot returned an unexpected session identity.");
    }
    live.session = session;
    broker.setSession(session);
    if (resume) {
      broker.beginRecovery();
    }
    unsubscribe = session.on((event) => {
      onSessionEvent(live, event);
    });
    await configureManualPermissions(
      session,
      remainingMs(deadline),
      signal,
    );
    if (resume) {
      await broker.restorePending(signal, deadline);
      await activation.store.setActivationId(entry.sessionId, activation.activationId);
      entry.activationId = activation.activationId;
    }
    if (!isCurrentActivation(activation)) {
      throw new Error("The GitHub Copilot installation is stopping.");
    }
    return live;
  } catch (error) {
    await live.close().catch(() => {
      throw safeRuntimeError();
    });
    throw safeRuntimeError();
  }
}

async function getReadSession(
  activation: CopilotActivation,
  entry: OwnedSession,
  signal?: AbortSignal,
): Promise<CopilotSessionType> {
  assertOwnedEntry(entry, activation);
  let pool = readPools.get(activation.activationId);
  if (!pool) {
    const client = await createCopilotClient(activation.paths);
    let unregister: () => void = () => undefined;
    let closePromise: Promise<void> | undefined;
    const newPool: ReadPool = {
      activation,
      client,
      sessions: new Map(),
      unregister: () => unregister(),
      closed: false,
      get closePromise() {
        return closePromise;
      },
      async close(closeSignal?: AbortSignal): Promise<void> {
        if (closePromise) {
          return closePromise;
        }
        newPool.closed = true;
        closePromise = (async () => {
          await stopClient(client, operationTimeoutMs, closeSignal);
          unregister();
          readPools.delete(activation.activationId);
        })();
        try {
          await closePromise;
        } catch {
          closePromise = undefined;
          throw new Error("Copilot read runtime cleanup failed.");
        }
      },
    };
    unregister = registerActivationResource(activation, newPool);
    pool = newPool;
    readPools.set(activation.activationId, pool);
    try {
      await bounded(client.start(), operationTimeoutMs, signal);
    } catch {
      await pool.close().catch(() => {
        throw safeRuntimeError();
      });
      throw safeRuntimeError();
    }
  }
  if (pool.closed || !isCurrentActivation(activation)) {
    throw new Error("The GitHub Copilot installation is stopping.");
  }
  const existing = pool.sessions.get(entry.sessionId);
  if (existing) {
    return existing;
  }
  const session = await bounded(
    pool.client.resumeSession(
      entry.sessionId,
      sessionConfig(
        activation.paths.workingDirectory,
        entry.availableTools,
        () => denyPermission(),
      ),
    ),
    operationTimeoutMs,
    signal,
  );
  if (session.sessionId !== entry.sessionId) {
    throw new Error("Copilot returned an unexpected session identity.");
  }
  await configureManualPermissions(session);
  const pending = await bounded(
    session.rpc.permissions.pendingRequests(),
    operationTimeoutMs,
    signal,
  );
  for (const request of pending.items) {
    await bounded(
      session.rpc.permissions.handlePendingPermissionRequest({
        requestId: request.requestId,
        result: { kind: "user-not-available" },
      }),
      operationTimeoutMs,
      signal,
    );
  }
  pool.sessions.set(entry.sessionId, session);
  return session;
}

async function ensureLiveSession(
  activation: CopilotActivation,
  entry: OwnedSession,
  signal?: AbortSignal,
): Promise<LiveSession> {
  const existing = liveSessions.get(entry.sessionId);
  if (existing) {
    if (
      existing.activation.activationId !== activation.activationId ||
      existing.closed
    ) {
      throw new Error("The Copilot session belongs to a different activation.");
    }
    return existing;
  }
  if (entry.status === "creating" || entry.status === "uncertain") {
    throw new Error("The Copilot session outcome is uncertain; it will not be restarted.");
  }
  const pool = readPools.get(activation.activationId);
  if (pool) {
    await pool.close(signal);
  }
  const live = await createLiveSession(activation, entry, true, signal);
  return live;
}

async function updateStatusFromEvents(
  activation: CopilotActivation,
  entry: OwnedSession,
  events: SessionEvent[],
): Promise<void> {
  const summary = summarizeRunEvents(events);
  if (!summary.complete || isTerminal(entry.status)) {
    return;
  }
  const status: SessionStatus = summary.failed ? "failed" : "completed";
  await activation.store.setStatus(entry.sessionId, status);
  entry.status = status;
}

function onSessionEvent(live: LiveSession, event: SessionEvent): void {
  if (event.type === "permission.requested") {
    void live.broker.permissionEvent(event).catch(() => {
      live.error = safeRuntimeError();
    });
    return;
  }
  if (
    event.agentId ||
    (event.type !== "assistant.turn_end" && event.type !== "session.error")
  ) {
    return;
  }
  void (async () => {
    const events = await requireSession(live).getEvents();
    await updateStatusFromEvents(live.activation, live.entry, events);
    if (live.entry.status === "completed" || live.entry.status === "failed") {
      await closeLiveSession(live);
    }
  })().catch(() => {
    live.error = safeRuntimeError();
  });
}

async function closeLiveSession(
  live: LiveSession,
  signal?: AbortSignal,
  cancel = false,
): Promise<void> {
  await live.close(signal);
  if (cancel && !isTerminal(live.entry.status)) {
    await live.activation.store.setStatus(live.entry.sessionId, "cancelled");
    live.entry.status = "cancelled";
  }
}

async function requestAbort(
  live: LiveSession,
  signal?: AbortSignal,
): Promise<void> {
  if (live.abortRequested || !live.session) {
    return;
  }
  live.abortRequested = true;
  await bounded(live.session.abort(), operationTimeoutMs, signal);
}

async function requireRunEntry(
  activation: CopilotActivation,
  run: WorkRun,
  recipe: Pick<ExecutorRecipeRef, "id">,
  workItemId: string,
): Promise<OwnedSession> {
  if (typeof run.executor_type !== "string" || !run.executor_type) {
    throw new Error("The work run belongs to another executor.");
  }
  if (run.org_id !== activation.orgId || run.recipe_id !== recipe.id) {
    throw new Error("The work run is not owned by this organization and recipe.");
  }
  const entry = await activation.store.getByRunId(run.id);
  if (!entry || entry.sessionId !== run.external_run_id || entry.sessionId !== run.agent_thread_id) {
    throw new Error("The work run is not registered to this pinned Copilot installation.");
  }
  assertRunOwnership(entry, activation, recipe, workItemId);
  return entry;
}

function assertRunOwnership(
  entry: OwnedSession,
  activation: CopilotActivation,
  recipe: Pick<ExecutorRecipeRef, "id">,
  workItemId: string,
): void {
  if (
    entry.installationId !== activation.installationId ||
    entry.orgId !== activation.orgId ||
    entry.recipeId !== recipe.id ||
    entry.workItemId !== workItemId ||
    entry.copilotHome !== activation.paths.copilotHome ||
    entry.workingDirectory !== activation.paths.workingDirectory
  ) {
    throw new Error("The work run is not owned by this pinned Copilot installation.");
  }
}

function assertOwnedEntry(
  entry: OwnedSession,
  activation: CopilotActivation,
): void {
  if (
    entry.installationId !== activation.installationId ||
    entry.orgId !== activation.orgId ||
    entry.copilotHome !== activation.paths.copilotHome ||
    entry.workingDirectory !== activation.paths.workingDirectory
  ) {
    throw new Error("The Copilot session is not owned by this installation.");
  }
}

function handleForEntry(
  entry: OwnedSession,
  events: SessionEvent[],
  overrideSummary?: string,
): ExecutorRunHandle {
  const summary = events.length > 0 ? summarizeRunEvents(events) : undefined;
  const pending = liveSessions.get(entry.sessionId)?.broker.prompts() ?? [];
  const state = stateForEntry(entry, summary, pending.length > 0);
  const resultSummary =
    overrideSummary ??
    summary?.summary ??
    (entry.status === "uncertain" || entry.status === "sending"
      ? "Copilot task submission is uncertain. It will not be sent again automatically."
      : undefined);
  const result = resultSummary
    ? {
        summary: resultSummary,
        ...(summary?.evidenceEventIds.length
          ? { evidence_event_ids: summary.evidenceEventIds }
          : {}),
      }
    : undefined;
  return {
    external_run_id: entry.sessionId,
    agent_thread_id: entry.sessionId,
    status: state,
    ...(result ? { result } : {}),
    ...(pending.length ? { prompts: pending } : {}),
  };
}

function stateForEntry(
  entry: OwnedSession,
  summary: ReturnType<typeof summarizeRunEvents> | undefined,
  hasPending: boolean,
): ExecutorRunHandle["status"] {
  if (entry.status === "cancelled") {
    return "cancelled";
  }
  if (entry.status === "failed" || summary?.failed) {
    return "failed";
  }
  if (entry.status === "completed" || summary?.complete) {
    return "completed";
  }
  return hasPending ? "waiting_human" : "running";
}

function isTerminal(status: SessionStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

class PermissionBroker {
  private readonly candidates: PermissionCandidate[] = [];
  private readonly pending = new Map<string, PendingPermission>();
  private recovering = false;
  private closed = false;

  constructor(
    private readonly activation: CopilotActivation,
    private readonly entry: OwnedSession,
    private readonly timeoutMs: number,
  ) {}

  readonly onPermissionRequest: PermissionHandler = (request, invocation) => {
    this.discardExpiredCandidates();
    if (
      this.closed ||
      !isCurrentActivation(this.activation) ||
      invocation.sessionId !== this.entry.sessionId ||
      !isPromptablePermissionKind(request.kind) ||
      this.candidates.length >= 32
    ) {
      return denyPermission();
    }
    if (this.recovering) {
      return { kind: "no-result" };
    }
    this.candidates.push({
      sessionId: invocation.sessionId,
      requestDigest: digestRequest(request),
      createdAt: Date.now(),
    });
    return { kind: "no-result" };
  };

  async permissionEvent(
    event: Extract<SessionEvent, { type: "permission.requested" }>,
  ): Promise<void> {
    const {
      requestId,
      permissionRequest,
      promptRequest,
      ownerSessionId,
      ownerAgentId,
      resolvedByHook,
    } = event.data;
    if (resolvedByHook || typeof requestId !== "string" || !requestId) {
      return;
    }
    if (this.recovering) {
      return;
    }
    this.discardExpiredCandidates();
    if (
      this.closed ||
      !isCurrentActivation(this.activation) ||
      event.agentId ||
      ownerAgentId ||
      (ownerSessionId && ownerSessionId !== this.entry.sessionId)
    ) {
      await this.respond(requestId, { kind: "reject", feedback: "Permission was not approved." });
      return;
    }
    const digest = digestRequest(permissionRequest);
    const index = this.candidates.findIndex(
      (candidate) =>
        candidate.sessionId === this.entry.sessionId &&
        candidate.requestDigest === digest,
    );
    if (index < 0 || this.pendingHasRequestId(requestId)) {
      await this.respond(requestId, { kind: "reject", feedback: "Permission request could not be verified." });
      return;
    }
    this.candidates.splice(index, 1);
    const promptId = randomUUID();
    if (!isPromptablePermissionKind(permissionRequest.kind)) {
      await this.respond(requestId, {
        kind: "reject",
        feedback: "This permission type is disabled by the connector.",
      });
      return;
    }
    const toolName = safeToolName(promptRequest?.kind ?? permissionRequest.kind);
    const pending: StoredPendingPermission = {
      promptId,
      requestId,
      toolName,
      requestDigest: digestRequest({ permissionRequest, promptRequest }),
      expiresAt: Date.now() + this.timeoutMs,
    };
    try {
      await this.activation.store.addPendingPermission(
        this.entry.sessionId,
        pending,
      );
    } catch {
      await this.respond(requestId, {
        kind: "reject",
        feedback: "Permission could not be safely recorded.",
      });
      this.onFatal();
      throw safeRuntimeError();
    }
    if (this.closed || !isCurrentActivation(this.activation)) {
      await this.activation.store
        .consumePendingPermission(this.entry.sessionId, pending.promptId)
        .catch(() => undefined);
      await this.respond(requestId, {
        kind: "reject",
        feedback: "The Copilot run is stopping.",
      });
      return;
    }
    this.registerPending(pending);
  }

  prompts(): ThreadPrompt[] {
    return [...this.pending.values()]
      .filter((pending) => pending.expiresAt > Date.now())
      .map((pending) => ({
        prompt_id: pending.promptId,
        presentation: "approval",
        title: "Copilot tool approval",
        detail: `Copilot requests permission to use ${pending.toolName}. Arguments are hidden; approval applies to this request only.`,
        questions: [
          {
            id: "decision",
            prompt: "Allow this request once?",
            options: [{ label: "Allow once" }, { label: "Deny" }],
          },
        ],
      }));
  }

  async answer(answer: NonNullable<ExecutorResumeInput["answer"]>): Promise<void> {
    const pending = this.pending.get(answer.prompt_id);
    if (!pending) {
      throw new Error("This permission prompt is unknown, expired, or already consumed.");
    }
    if (
      pending.activationId !== this.activation.activationId ||
      pending.installationId !== this.activation.installationId ||
      pending.runId !== this.entry.runId ||
      pending.recipeId !== this.entry.recipeId ||
      pending.workItemId !== this.entry.workItemId ||
      pending.sessionId !== this.entry.sessionId ||
      pending.expiresAt <= Date.now()
    ) {
      await this.consumeAndDeny(pending);
      throw new Error("This permission prompt is stale and was denied.");
    }
    const selected = answer.answers;
    if (
      !Array.isArray(selected) ||
      selected.length !== 1 ||
      selected[0]?.id !== "decision" ||
      selected[0].custom !== undefined ||
      !Array.isArray(selected[0].selected) ||
      selected[0].selected.length !== 1 ||
      (selected[0].selected[0] !== "Allow once" &&
        selected[0].selected[0] !== "Deny")
    ) {
      throw new Error("The permission answer is invalid.");
    }
    const stored = await this.activation.store.consumePendingPermission(
      this.entry.sessionId,
      pending.promptId,
    );
    this.consume(pending);
    if (
      !stored ||
      stored.requestId !== pending.requestId ||
      stored.promptId !== pending.promptId ||
      stored.toolName !== pending.toolName ||
      stored.requestDigest !== pending.requestDigest ||
      stored.expiresAt !== pending.expiresAt
    ) {
      await this.respond(pending.requestId, {
        kind: "reject",
        feedback: "Permission could not be verified and was denied.",
      });
      throw new Error("This permission prompt is stale and was denied.");
    }
    const result =
      selected[0].selected[0] === "Allow once"
        ? { kind: "approve-once" as const, approvedInteractively: true }
        : { kind: "reject" as const, feedback: "Permission was denied by the user." };
    let response: { success: boolean };
    try {
      response = await this.respond(pending.requestId, result);
    } catch {
      this.onFatal();
      throw safeRuntimeError();
    }
    if (!response.success) {
      throw new Error("The Copilot permission request was already resolved.");
    }
  }

  beginRecovery(): void {
    this.recovering = true;
  }

  async restorePending(
    signal?: AbortSignal,
    deadline = Date.now() + operationTimeoutMs,
  ): Promise<void> {
    this.recovering = true;
    try {
      const sdkPending = await bounded(
        this.requireSession().rpc.permissions.pendingRequests(),
        remainingMs(deadline),
        signal,
      );
      const events = persistedSessionEvents(
        await bounded(
          this.requireSession().getEvents(),
          remainingMs(deadline),
          signal,
        ),
      );
      const requests = new Map<
        string,
        Extract<SessionEvent, { type: "permission.requested" }>
      >();
      for (const event of events) {
        if (
          event.type === "permission.requested" &&
          !event.agentId &&
          !event.data.ownerAgentId &&
          event.data.requestId
        ) {
          if (requests.has(event.data.requestId)) {
            throw new Error("Copilot returned duplicate permission request IDs.");
          }
          requests.set(event.data.requestId, event);
        }
      }
      const stored = await this.activation.store.listPendingPermissions(
        this.entry.sessionId,
      );
      const matchedIds = new Set<string>();
      for (const saved of stored) {
        const event = requests.get(saved.requestId);
        const sdkRequest = sdkPending.items.find(
          (item) => item.requestId === saved.requestId,
        );
        const valid =
          !!event &&
          !!sdkRequest &&
          saved.expiresAt > Date.now() &&
          !event.data.resolvedByHook &&
          (!event.data.ownerSessionId ||
            event.data.ownerSessionId === this.entry.sessionId) &&
          isPromptablePermissionKind(event.data.permissionRequest.kind) &&
          saved.requestDigest ===
            digestRequest({
              permissionRequest: event.data.permissionRequest,
              promptRequest: event.data.promptRequest,
            }) &&
          (!event.data.promptRequest ||
            digestRequest(sdkRequest.request) ===
              digestRequest(event.data.promptRequest)) &&
          saved.toolName ===
            safeToolName(
              event.data.promptRequest?.kind ??
                event.data.permissionRequest.kind,
            );
        if (!valid) {
          await this.activation.store.consumePendingPermission(
            this.entry.sessionId,
            saved.promptId,
          );
          if (sdkRequest) {
            await this.respond(
              sdkRequest.requestId,
              { kind: "user-not-available" },
              signal,
              remainingMs(deadline),
            );
          }
          continue;
        }
        matchedIds.add(saved.requestId);
        this.registerPending(saved);
      }
      for (const item of sdkPending.items) {
        if (!matchedIds.has(item.requestId)) {
          await this.respond(
            item.requestId,
            { kind: "user-not-available" },
            signal,
            remainingMs(deadline),
          );
        }
      }
    } finally {
      this.recovering = false;
    }
  }

  async denyAll(): Promise<void> {
    this.closed = true;
    this.candidates.length = 0;
    const pending = [...this.pending.values()];
    const results = await Promise.allSettled(
      pending.map(async (request) => {
        await this.activation.store.consumePendingPermission(
          this.entry.sessionId,
          request.promptId,
        );
        this.consume(request);
        await this.respond(request.requestId, {
          kind: "reject",
          feedback: "The Copilot run was stopped.",
        });
      }),
    );
    if (results.some((result) => result.status === "rejected")) {
      await this.activation.store
        .clearPendingPermissions(this.entry.sessionId)
        .catch(() => undefined);
      throw new Error("One or more Copilot permission requests could not be denied.");
    }
    await this.activation.store.clearPendingPermissions(this.entry.sessionId);
  }

  setSession(session: CopilotSessionType): void {
    this.session = session;
  }

  private session?: CopilotSessionType;

  private async expire(pending: PendingPermission): Promise<void> {
    if (!this.pending.has(pending.promptId)) {
      return;
    }
    await this.activation.store.consumePendingPermission(
      this.entry.sessionId,
      pending.promptId,
    );
    this.consume(pending);
    await this.respond(pending.requestId, {
      kind: "reject",
      feedback: "Permission request expired without approval.",
    });
  }

  private async consumeAndDeny(pending: PendingPermission): Promise<void> {
    await this.activation.store.consumePendingPermission(
      this.entry.sessionId,
      pending.promptId,
    );
    this.consume(pending);
    await this.respond(pending.requestId, {
      kind: "reject",
      feedback: "Permission request was stale.",
    });
  }

  private consume(pending: PendingPermission): void {
    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(pending.promptId);
  }

  private registerPending(saved: StoredPendingPermission): void {
    const remaining = saved.expiresAt - Date.now();
    if (remaining <= 0) {
      return;
    }
    const pending: PendingPermission = {
      ...saved,
      activationId: this.activation.activationId,
      installationId: this.activation.installationId,
      runId: this.entry.runId,
      recipeId: this.entry.recipeId,
      workItemId: this.entry.workItemId,
      sessionId: this.entry.sessionId,
      timer: setTimeout(() => {
        void this.expire(pending).catch(() => {
          this.onFatal();
        });
      }, remaining),
    };
    pending.timer?.unref();
    this.pending.set(pending.promptId, pending);
  }

  private discardExpiredCandidates(): void {
    const cutoff = Date.now() - operationTimeoutMs;
    for (let index = this.candidates.length - 1; index >= 0; index -= 1) {
      if (this.candidates[index]!.createdAt < cutoff) {
        this.candidates.splice(index, 1);
      }
    }
  }

  private pendingHasRequestId(requestId: string): boolean {
    return [...this.pending.values()].some((item) => item.requestId === requestId);
  }

  private async respond(
    requestId: string,
    result: Parameters<CopilotSessionType["rpc"]["permissions"]["handlePendingPermissionRequest"]>[0]["result"],
    signal?: AbortSignal,
    timeoutMs = operationTimeoutMs,
  ): Promise<{ success: boolean }> {
    const session = this.requireSession();
    return bounded(
      session.rpc.permissions.handlePendingPermissionRequest({ requestId, result }),
      timeoutMs,
      signal,
    );
  }

  private onFatal(): void {
    this.closed = true;
    this.fatalHandler();
  }

  setFatalHandler(handler: () => void): void {
    this.fatalHandler = handler;
  }

  private fatalHandler: () => void = () => undefined;

  private requireSession(): CopilotSessionType {
    if (!this.session) {
      throw new Error("Copilot session is not ready for permission handling.");
    }
    return this.session;
  }
}

function digestRequest(request: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(request))
    .digest("hex");
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Copilot operation timed out.");
  }
  return remaining;
}

function serializeRunOperation<T>(
  activation: CopilotActivation,
  sessionId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = `${activation.installationId}:${sessionId}`;
  const previous = runQueues.get(key) ?? Promise.resolve();
  const current = previous.then(operation, operation);
  runQueues.set(
    key,
    current.then(
      () => undefined,
      () => undefined,
    ),
  );
  return current;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function isPromptablePermissionKind(value: string): boolean {
  return value === "shell" || value === "read" || value === "write" || value === "url";
}

function requireSession(live: LiveSession): CopilotSessionType {
  if (!live.session) {
    throw new Error("Copilot session is not ready.");
  }
  return live.session;
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "tool";
  }
  return value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 80) || "tool";
}
