const assert = require("node:assert/strict");
const { mkdtemp, mkdir, readFile, rm, symlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createHost,
  definePlugin,
} = require("@regenic/plugin-host");
const {
  verifyChannelDriverConformance,
  verifyPollConnectorConformance,
} = require("@regenic/connector-test-utils");
const {
  githubCopilotSessionDriver: driver,
  githubCopilotTaskExecutor: executor,
} = require("../dist/index.js");
const { setCopilotClientFactoryForTests } = require("../dist/sdk.js");
const {
  pageSessionEvents,
} = require("../dist/session-events.js");
const { CopilotSessionStore } = require("../dist/store.js");
const { resolveCopilotPaths } = require("../dist/settings.js");
const { SOURCE } = require("../dist/constants.js");

const now = "2026-01-02T03:04:05.000Z";
const orgId = "synthetic-org";
const recipe = { id: "synthetic-recipe", executor_config: {} };
const workItem = {
  id: "synthetic-work-item",
  thread_id: "synthetic-thread",
  record_class: "message",
  thread_facet: "agent",
};

class FakeSession {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.events = [];
    this.listeners = new Set();
    this.sent = [];
    this.responses = [];
    this.aborts = 0;
    this.pending = [];
    this.permissionHandler = undefined;
    this.rpc = {
      permissions: {
        setMode: async ({ mode }) => ({ success: true, mode }),
        setApproveAll: async () => ({ success: true }),
        pendingRequests: async () => ({ items: this.pending }),
        handlePendingPermissionRequest: async (request) => {
          this.responses.push(request);
          this.pending = this.pending.filter((item) => item.requestId !== request.requestId);
          return { success: true };
        },
      },
    };
  }

  on(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async send(prompt) {
    this.sent.push(prompt);
    return `message-${this.sent.length}`;
  }

  async getEvents() {
    return this.events;
  }

  async abort() {
    this.aborts += 1;
  }
}

class FakeClient {
  constructor(server) {
    this.server = server;
    this.started = 0;
    this.stopped = 0;
    this.forceStopped = 0;
  }

  async start() {
    this.started += 1;
  }

  async createSession(config) {
    this.server.createSessionStarted?.();
    if (this.server.createSessionGate) {
      await this.server.createSessionGate;
    }
    const session = new FakeSession(config.sessionId);
    session.permissionHandler = config.onPermissionRequest;
    this.server.sessions.set(session.sessionId, session);
    return session;
  }

  async resumeSession(sessionId, config) {
    let session = this.server.sessions.get(sessionId);
    if (!session) {
      session = new FakeSession(sessionId);
      this.server.sessions.set(sessionId, session);
    }
    session.permissionHandler = config.onPermissionRequest;
    return session;
  }

  async stop() {
    this.stopped += 1;
    return [];
  }

  async forceStop() {
    this.forceStopped += 1;
  }
}

function installConfig(root, overrides = {}) {
  return {
    copilot_home: path.join(root, "copilot-home"),
    state_dir: path.join(root, "connector-state"),
    working_directory: path.join(root, "workspace"),
    sync_enabled: true,
    execution_enabled: true,
    available_tools: "builtin:edit",
    permission_timeout_ms: 60_000,
    ...overrides,
  };
}

async function createFixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "regenic-copilot-test-"));
  const copilotHome = path.join(root, "copilot-home");
  const workspace = path.join(root, "workspace");
  const stateDir = path.join(root, "connector-state");
  await Promise.all([
    mkdir(copilotHome),
    mkdir(workspace),
  ]);
  const config = installConfig(root, options.config);
  const installation = {
    ...driver.install({
      id: options.installationId ?? "synthetic-installation",
      org_id: options.orgId ?? orgId,
      config,
      now,
    }),
    updated_at: now,
  };
  const server = { sessions: new Map() };
  const clients = [];
  setCopilotClientFactoryForTests(() => {
    const client = new FakeClient(server);
    clients.push(client);
    return client;
  });
  t.after(async () => {
    setCopilotClientFactoryForTests(undefined);
    await driver.stopInstallation(
      installation,
      {},
      { signal: new AbortController().signal },
    ).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });
  return { root, copilotHome, workspace, stateDir, config, installation, server, clients };
}

function executorContext(installationId) {
  return {
    org_id: orgId,
    installation_id: installationId,
    env: {},
    spawnSysout: async () => {
      throw new Error("The Copilot executor must not use sysout.");
    },
    writeStdin: async () => {
      throw new Error("The Copilot executor must not use sysout.");
    },
    listPrompts: async () => [],
    readTranscript: async () => null,
  };
}

function startInput(runId) {
  return {
    run_id: runId,
    work_item: workItem,
    recipe,
    evidence_text: "Synthetic task prompt.",
  };
}

function workRun(handle, runId) {
  return {
    id: runId,
    org_id: orgId,
    work_item_id: workItem.id,
    recipe_id: recipe.id,
    executor_type: executor.executor_type,
    external_run_id: handle.external_run_id,
    agent_thread_id: handle.agent_thread_id,
    status: handle.status,
    created_at: now,
    updated_at: now,
  };
}

function permissionEvent(requestId, permissionRequest, promptRequest) {
  return {
    id: `event-${requestId}`,
    type: "permission.requested",
    timestamp: now,
    parentId: null,
    data: {
      requestId,
      permissionRequest,
      promptRequest,
      ownerSessionId: undefined,
    },
  };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

test("exports a synchronous plugin surface and mounts the real driver/executor", async () => {
  const manifest = require("../package.json");
  assert.equal(manifest.regenic.plugin, true);
  assert.deepEqual(manifest.regenic.contributes.drivers, ["githubCopilotSessionDriver"]);
  assert.deepEqual(manifest.regenic.contributes.executors, ["githubCopilotTaskExecutor"]);
  assert.equal(driver.capabilities({ status: "disabled", config: {} }).execute, false);

  const host = await createHost();
  const handle = await host.plugin(
    definePlugin({
      name: "synthetic-copilot-mount",
      apply(context) {
        context.provide("copilot-driver", driver);
        context.provide("copilot-executor", executor);
      },
    }),
  );
  assert.equal(host.get("copilot-driver"), driver);
  assert.equal(host.get("copilot-executor"), executor);
  await handle.dispose();
  await host.dispose();
});

test("reports only configured capabilities and passes the published driver conformance checks", async (t) => {
  const fixture = await createFixture(t);
  const disabled = { ...fixture.installation, status: "disabled" };
  verifyChannelDriverConformance({
    driver,
    enabled: fixture.installation,
    disabled,
  });
  const capabilities = driver.capabilities(fixture.installation);
  assert.equal(capabilities.create, false);
  assert.equal(capabilities.execute, true);
  assert.equal(driver.capabilities({
    ...fixture.installation,
    config: { ...fixture.config, execution_enabled: false },
  }).execute, false);
});

test("starts once, synchronizes persisted events, and keeps work records free of tool arguments", async (t) => {
  const fixture = await createFixture(t);
  await driver.startInstallation(fixture.installation);
  const context = executorContext(fixture.installation.id);
  const runId = "synthetic-run";
  const handle = await executor.start(startInput(runId), context);
  assert.equal(handle.status, "running");
  assert.equal(fixture.server.sessions.size, 1);
  const session = fixture.server.sessions.get(handle.external_run_id);
  assert.deepEqual(session.sent, ["Synthetic task prompt."]);

  const events = persistedFixtureEvents();
  session.events = events;
  const streams = await driver.resolveStreams(
    fixture.installation,
    { now: () => now },
    {},
    {},
  );
  assert.equal(streams.length, 1);
  const conformance = await verifyPollConnectorConformance({
    connector: streams[0].connector,
    cursor: null,
    connector_id: fixture.installation.id,
    source: SOURCE,
  });
  assert.equal(conformance.record_count, 4);
  const poll = await streams[0].connector.poll(null);
  const records = poll.batch.records;
  assert.equal(recordBody(records[0]), "Synthetic user message");
  assert.equal(recordBody(records[1]), "Joined assistant response");
  assert.match(recordBody(records[2]), /Copilot tool builtin_edit started/);
  assert.match(recordBody(records[3]), /Copilot tool builtin_edit completed/);
  assert.equal(JSON.stringify(records).includes("synthetic-secret-argument"), false);

  const repeated = await executor.start(startInput(runId), context);
  assert.equal(repeated.external_run_id, handle.external_run_id);
  assert.equal(session.sent.length, 1);
  assert.equal(fixture.server.sessions.size, 1);

  await driver.stopInstallation(
    fixture.installation,
    {},
    { signal: new AbortController().signal },
  );
  assert.ok(fixture.clients.every((client) => client.stopped === 1));
});

test("stores a one-shot approval without arguments and denies replay", async (t) => {
  const fixture = await createFixture(t);
  await driver.startInstallation(fixture.installation);
  const context = executorContext(fixture.installation.id);
  const runId = "permission-run";
  const handle = await executor.start(startInput(runId), context);
  const session = fixture.server.sessions.get(handle.external_run_id);
  const permissionRequest = {
    kind: "shell",
    toolCallId: "tool-call-1",
    fullCommandText: "echo synthetic-secret-argument",
  };
  const promptRequest = { kind: "commands", commands: ["echo synthetic-secret-argument"] };
  assert.deepEqual(
    session.permissionHandler(permissionRequest, { sessionId: session.sessionId }),
    { kind: "no-result" },
  );
  session.emit(permissionEvent("permission-1", permissionRequest, promptRequest));

  const run = workRun(handle, runId);
  let promptHandle;
  await waitFor(async () => {
    promptHandle = await executor.resume(
      { run, work_item: workItem, recipe },
      context,
    );
    return promptHandle.prompts?.length === 1;
  }, "The synthetic permission prompt was not published.");
  const prompt = promptHandle.prompts[0];
  assert.equal(JSON.stringify(prompt).includes("synthetic-secret-argument"), false);

  const manifestPath = path.join(fixture.stateDir, "github-copilot-sessions-v1.json");
  const manifest = await readFile(manifestPath, "utf8");
  assert.equal(manifest.includes("synthetic-secret-argument"), false);
  assert.equal(manifest.includes("permission-1"), true);

  const answer = {
    prompt_id: prompt.prompt_id,
    answers: [{ id: "decision", selected: ["Allow once"] }],
  };
  await executor.resume({ run, work_item: workItem, recipe, answer }, context);
  assert.deepEqual(session.responses.at(-1), {
    requestId: "permission-1",
    result: { kind: "approve-once", approvedInteractively: true },
  });
  await assert.rejects(
    executor.resume({ run, work_item: workItem, recipe, answer }, context),
    /unknown, expired, or already consumed/,
  );
  assert.equal(session.responses.length, 1);

  await driver.stopInstallation(
    fixture.installation,
    {},
    { signal: new AbortController().signal },
  );
});

test("recovers an SDK pending permission only when its saved digest and event match", async (t) => {
  const fixture = await createFixture(t);
  const paths = await resolveCopilotPaths(fixture.installation.config);
  const store = new CopilotSessionStore(paths, fixture.installation.id, orgId);
  const sessionId = "10000000-0000-4000-8000-000000000001";
  const runId = "recovered-run";
  const permissionRequest = {
    kind: "shell",
    toolCallId: "recovered-tool",
    fullCommandText: "echo synthetic-recovery-secret",
  };
  const promptRequest = {
    kind: "commands",
    commands: ["echo synthetic-recovery-secret"],
  };
  const promptId = "synthetic-prompt-id";
  const requestId = "synthetic-request-id";
  const event = {
    ...permissionEvent(requestId, permissionRequest, promptRequest),
    id: "permission-event",
  };
  await store.begin({
    sessionId,
    installationId: fixture.installation.id,
    orgId,
    runId,
    recipeId: recipe.id,
    workItemId: workItem.id,
    activationId: "old-activation",
    copilotHome: paths.copilotHome,
    workingDirectory: paths.workingDirectory,
    availableTools: ["builtin:edit"],
  });
  await store.setStatus(sessionId, "created");
  await store.setStatus(sessionId, "sending");
  await store.setStatus(sessionId, "sent");
  const requestDigest = require("node:crypto")
    .createHash("sha256")
    .update(
      JSON.stringify({
        permissionRequest: {
          fullCommandText: permissionRequest.fullCommandText,
          kind: permissionRequest.kind,
          toolCallId: permissionRequest.toolCallId,
        },
        promptRequest: {
          commands: promptRequest.commands,
          kind: promptRequest.kind,
        },
      }),
    )
    .digest("hex");
  await store.addPendingPermission(sessionId, {
    promptId,
    requestId,
    toolName: "commands",
    requestDigest,
    expiresAt: Date.now() + 60_000,
  });

  const session = new FakeSession(sessionId);
  session.events = [event];
  session.pending = [{ requestId, request: promptRequest }];
  fixture.server.sessions.set(sessionId, session);
  await driver.startInstallation(fixture.installation);
  const run = {
    id: runId,
    org_id: orgId,
    work_item_id: workItem.id,
    recipe_id: recipe.id,
    executor_type: executor.executor_type,
    external_run_id: sessionId,
    agent_thread_id: sessionId,
    status: "running",
    created_at: now,
    updated_at: now,
  };
  const answer = {
    prompt_id: promptId,
    answers: [{ id: "decision", selected: ["Allow once"] }],
  };
  const recoveredStatus = await executor.status(run, executorContext(fixture.installation.id));
  assert.equal(recoveredStatus.status, "waiting_human");
  assert.equal(recoveredStatus.prompts[0].prompt_id, promptId);
  const recoveredResume = await executor.resume(
    { run, work_item: workItem, recipe },
    executorContext(fixture.installation.id),
  );
  assert.equal(recoveredResume.prompts[0].prompt_id, promptId);
  assert.deepEqual(session.responses, []);
  assert.equal((await store.get(sessionId)).pendingPermissions.length, 1);
  await executor.resume({ run, work_item: workItem, recipe, answer }, executorContext(fixture.installation.id));
  assert.deepEqual(session.responses, [
    { requestId, result: { kind: "approve-once", approvedInteractively: true } },
  ]);
  const saved = await store.get(sessionId);
  assert.deepEqual(saved.pendingPermissions, []);

  await driver.stopInstallation(
    fixture.installation,
    {},
    { signal: new AbortController().signal },
  );
});

test("cancel and disable deny pending prompts and stop the SDK client", async (t) => {
  const fixture = await createFixture(t);
  await driver.startInstallation(fixture.installation);
  const context = executorContext(fixture.installation.id);
  const runId = "cancel-run";
  const handle = await executor.start(startInput(runId), context);
  const session = fixture.server.sessions.get(handle.external_run_id);
  const request = {
    kind: "shell",
    toolCallId: "cancel-tool",
    fullCommandText: "echo cancel-me",
  };
  const prompt = { kind: "commands", commands: ["echo cancel-me"] };
  session.permissionHandler(request, { sessionId: session.sessionId });
  session.emit(permissionEvent("cancel-request", request, prompt));
  const run = workRun(handle, runId);

  await waitFor(
    () => fixture.clients.some((client) => client.started > 0) && session.listeners.size > 0,
    "The synthetic SDK session was not started.",
  );
  await waitFor(async () => {
    const status = await executor.status(run, context);
    return status.prompts?.length === 1;
  }, "The synthetic permission prompt was not pending.");

  await executor.cancel(run, context);
  assert.equal(session.aborts, 1);
  assert.deepEqual(session.responses.at(-1), {
    requestId: "cancel-request",
    result: { kind: "reject", feedback: "The Copilot run was stopped." },
  });
  assert.equal(fixture.clients.at(-1).stopped, 1);
  await driver.stopInstallation(
    fixture.installation,
    {},
    { signal: new AbortController().signal },
  );
});

test("cancelling during SDK session startup prevents the prompt from being sent", async (t) => {
  const fixture = await createFixture(t);
  await driver.startInstallation(fixture.installation);
  let releaseCreateSession;
  let signalCreateSession;
  fixture.server.createSessionGate = new Promise((resolve) => {
    releaseCreateSession = resolve;
  });
  fixture.server.createSessionStarted = () => signalCreateSession?.();
  const createSessionStarted = new Promise((resolve) => {
    signalCreateSession = resolve;
  });
  const context = executorContext(fixture.installation.id);
  const runId = "cancel-during-startup";
  const startPromise = executor.start(startInput(runId), context);
  await createSessionStarted;

  const manifest = JSON.parse(
    await readFile(
      path.join(fixture.stateDir, "github-copilot-sessions-v1.json"),
      "utf8",
    ),
  );
  const sessionId = manifest.entries[0].sessionId;
  const run = {
    id: runId,
    org_id: orgId,
    work_item_id: workItem.id,
    recipe_id: recipe.id,
    executor_type: executor.executor_type,
    external_run_id: sessionId,
    agent_thread_id: sessionId,
    status: "running",
    created_at: now,
    updated_at: now,
  };
  await executor.cancel(run, context);
  releaseCreateSession();
  const result = await startPromise;
  assert.equal(result.status, "cancelled");
  const session = fixture.server.sessions.get(sessionId);
  assert.equal(session.sent.length, 0);
  assert.equal(session.aborts, 1);
});

test("host installation pin isolates same-org connector installations", async (t) => {
  const first = await createFixture(t, { installationId: "installation-one" });
  const secondRoot = path.join(first.root, "second");
  await mkdir(secondRoot);
  await Promise.all([
    mkdir(path.join(secondRoot, "copilot-home")),
    mkdir(path.join(secondRoot, "workspace")),
  ]);
  const secondInstallation = {
    ...driver.install({
      id: "installation-two",
      org_id: orgId,
      config: installConfig(secondRoot),
      now,
    }),
    updated_at: now,
  };
  t.after(() =>
    driver.stopInstallation(
      secondInstallation,
      {},
      { signal: new AbortController().signal },
    ),
  );
  await driver.startInstallation(first.installation);
  await driver.startInstallation(secondInstallation);
  const handle = await executor.start(
    startInput("pinned-run"),
    executorContext(first.installation.id),
  );
  const run = workRun(handle, "pinned-run");
  await assert.rejects(
    executor.status(run, executorContext(secondInstallation.id)),
    /not registered to this pinned Copilot installation/,
  );
  await driver.stopInstallation(
    first.installation,
    {},
    { signal: new AbortController().signal },
  );
  await driver.stopInstallation(
    secondInstallation,
    {},
    { signal: new AbortController().signal },
  );
});

test("event paging groups assistant chunks and ignores ephemeral deltas", () => {
  const events = persistedFixtureEvents();
  events.push({
    id: "ephemeral-delta",
    type: "assistant.message_delta",
    timestamp: now,
    parentId: "assistant-2",
    ephemeral: true,
    data: {},
  });
  const first = pageSessionEvents({
    events,
    sessionId: "session-1",
    cursor: null,
    connectorId: "connector-1",
    orgId,
    now,
    pageSize: 1,
  });
  assert.equal(first.records.length, 1);
  assert.equal(recordBody(first.records[0]), "Synthetic user message");
  assert.equal(first.hasMore, true);

  const second = pageSessionEvents({
    events,
    sessionId: "session-1",
    cursor: first.nextCursor,
    connectorId: "connector-1",
    orgId,
    now,
    pageSize: 1,
  });
  assert.equal(second.records.length, 1);
  assert.equal(recordBody(second.records[0]), "Joined assistant response");
  assert.equal(second.hasMore, true);

  const incomplete = pageSessionEvents({
    events: events.slice(0, 2),
    sessionId: "session-1",
    cursor: null,
    connectorId: "connector-1",
    orgId,
    now,
    pageSize: 100,
  });
  assert.equal(incomplete.records.length, 1);
  assert.equal(incomplete.hasMore, true);
  const waiting = pageSessionEvents({
    events: events.slice(0, 2),
    sessionId: "session-1",
    cursor: incomplete.nextCursor,
    connectorId: "connector-1",
    orgId,
    now,
    pageSize: 100,
  });
  assert.equal(waiting.records.length, 0);
  assert.equal(waiting.hasMore, false);
});

test("rejects persisted event types outside the published SDK schema", () => {
  assert.throws(
    () =>
      pageSessionEvents({
        events: [
          {
            id: "unknown-event",
            type: "session.future_event",
            timestamp: now,
            data: {},
          },
        ],
        sessionId: "session-1",
        cursor: null,
        connectorId: "connector-1",
        orgId,
        now,
        pageSize: 10,
      }),
    /unsupported shape or SDK event type/,
  );
});

test("rejects state paths that overlap configured source data and malformed manifests", async (t) => {
  const fixture = await createFixture(t);
  await assert.rejects(
    resolveCopilotPaths({
      ...fixture.installation.config,
      state_dir: path.join(fixture.workspace, "connector-state"),
    }),
    /must be separate/,
  );
  const workspaceAlias = path.join(fixture.root, "workspace-alias");
  await symlink(fixture.workspace, workspaceAlias);
  const aliasedState = path.join(workspaceAlias, "connector-state");
  await assert.rejects(
    resolveCopilotPaths({
      ...fixture.installation.config,
      state_dir: aliasedState,
    }),
    /must be separate/,
  );
  await assert.rejects(
    readFile(path.join(fixture.workspace, "connector-state")),
    { code: "ENOENT" },
  );
  const linkPath = path.join(fixture.root, "state-link");
  await mkdir(fixture.stateDir, { recursive: true });
  await symlink(fixture.stateDir, linkPath);
  await assert.rejects(
    resolveCopilotPaths({
      ...fixture.installation.config,
      state_dir: linkPath,
    }),
    /must be separate|non-symlink/,
  );

  const manifestPath = path.join(fixture.stateDir, "github-copilot-sessions-v1.json");
  await writeFile(manifestPath, JSON.stringify({ version: 99, revision: 0, entries: [] }));
  const paths = await resolveCopilotPaths(fixture.installation.config);
  const store = new CopilotSessionStore(paths, fixture.installation.id, orgId);
  await assert.rejects(store.listAll(), /damaged or uses an unsupported schema/);
});

function persistedFixtureEvents() {
  return [
    {
      id: "user-1",
      type: "user.message",
      timestamp: now,
      parentId: null,
      data: { content: "Synthetic user message" },
    },
    {
      id: "assistant-1",
      type: "assistant.message",
      timestamp: now,
      parentId: "user-1",
      data: {
        content: "Joined ",
        apiCallId: "assistant-call",
        chunkIndex: 0,
        chunkCount: 2,
      },
    },
    {
      id: "assistant-2",
      type: "assistant.message",
      timestamp: now,
      parentId: "assistant-1",
      data: {
        content: "assistant response",
        apiCallId: "assistant-call",
        chunkIndex: 1,
        chunkCount: 2,
      },
    },
    {
      id: "tool-start",
      type: "tool.execution_start",
      timestamp: now,
      parentId: "assistant-2",
      data: {
        toolName: "builtin_edit",
        toolCallId: "tool-call-1",
        arguments: { secret: "synthetic-secret-argument" },
      },
    },
    {
      id: "tool-complete",
      type: "tool.execution_complete",
      timestamp: now,
      parentId: "tool-start",
      data: {
        toolCallId: "tool-call-1",
        result: "synthetic-secret-argument",
      },
    },
  ];
}

function recordBody(record) {
  return record.content?.find((part) => part.role === "body")?.text;
}
