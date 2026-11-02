import { createHash } from "node:crypto";
import {
  channelRecord,
  ChannelDriverError,
  type IngestRecord,
} from "@regenic/connector-contract";
import type { SessionEvent } from "@github/copilot-sdk";
import { SOURCE } from "./constants";

export interface EventPage {
  records: IngestRecord[];
  nextCursor?: string;
  hasMore: boolean;
}

export interface RunEventSummary {
  complete: boolean;
  failed: boolean;
  summary?: string;
  evidenceEventIds: string[];
}

// Mirrors the session-level discriminators in the published SDK 1.0.28 schema.
const SUPPORTED_EVENT_TYPES = new Set([
  "session.start",
  "session.resume",
  "session.remote_steerable_changed",
  "session.error",
  "session.idle",
  "session.autopilot_stopped",
  "session.title_changed",
  "session.schedule_created",
  "session.schedule_cancelled",
  "session.schedule_rearmed",
  "session.autopilot_objective_changed",
  "session.info",
  "session.indexed_search",
  "session.warning",
  "session.model_change",
  "session.model_deselected",
  "session.auto_tier_recommendation",
  "session.auto_tier_switch_failed",
  "session.mode_changed",
  "session.mode_notice_delivered",
  "session.session_limits_changed",
  "session.permissions_changed",
  "session.plan_changed",
  "session.todos_changed",
  "session.memory_changed",
  "session.workspace_file_changed",
  "session.handoff",
  "session.truncation",
  "session.snapshot_rewind",
  "session.shutdown",
  "session.usage_checkpoint",
  "session.quota_observation",
  "session.usage_record",
  "session.fusion_change_checkpoint",
  "session.request_body_compression_disabled",
  "session.context_changed",
  "session.usage_info",
  "session.context_cleared",
  "session.compaction_start",
  "session.compaction_complete",
  "session.task_complete",
  "session.completion_receipt",
  "session.fusion_route_started",
  "session.fusion_route_failed",
  "session.fusion_resolved",
  "session.fusion_handoff",
  "session.fusion_commit_started",
  "session.fusion_completed",
  "session.permission_recovery",
  "user.message",
  "pending_messages.modified",
  "assistant.turn_start",
  "assistant.turn_retry",
  "agent.interrupted",
  "assistant.intent",
  "assistant.fusion_phase_started",
  "assistant.fusion_phase_activity",
  "assistant.fusion_phase_completed",
  "assistant.fusion_phase_failed",
  "assistant.server_tool_progress",
  "assistant.reasoning",
  "assistant.reasoning_delta",
  "assistant.tool_call_delta",
  "assistant.streaming_delta",
  "assistant.message",
  "assistant.message_start",
  "assistant.message_delta",
  "assistant.turn_end",
  "assistant.idle",
  "assistant.usage",
  "prompt_cache_break",
  "model.call_failure",
  "model.call_final_result",
  "model.call_finished",
  "model.call_start",
  "abort",
  "tool.user_requested",
  "tool.execution_start",
  "tool.execution_partial_result",
  "tool.shell_output",
  "tool.execution_progress",
  "tool.execution_complete",
  "tool_search.activated",
  "skill.invoked",
  "skill.invoked_ref",
  "skill.context_delivered",
  "skill.context_delivered_ref",
  "sandbox.decision",
  "subagent.started",
  "subagent.configured",
  "subagent.completed",
  "subagent.failed",
  "subagent.selected",
  "subagent.deselected",
  "hook.start",
  "hook.end",
  "hook.progress",
  "session.binary_asset",
  "system.message",
  "instruction.update",
  "system.notification",
  "permission.requested",
  "permission.completed",
  "permission.carriedForward",
  "permission.messageAuthorization",
  "permission.messageAuthorizationRead",
  "permission.messageAuthorizationDegraded",
  "permission.assentDetected",
  "permission.contextualAuthorization",
  "user_input.requested",
  "user_input.completed",
  "elicitation.requested",
  "elicitation.completed",
  "sampling.requested",
  "sampling.completed",
  "mcp.oauth_required",
  "mcp.oauth_completed",
  "mcp.oauth_recovery_completed",
  "mcp.headers_refresh_required",
  "mcp.headers_refresh_completed",
  "session.custom_notification",
  "ui.ephemeral_query",
  "external_tool.requested",
  "external_tool.completed",
  "command.queued",
  "command.execute",
  "command.completed",
  "auto_mode_switch.requested",
  "auto_mode_switch.completed",
  "session_limits_exhausted.requested",
  "session_limits_exhausted.completed",
  "session.auto_mode_resolved",
  "session.managed_plugin_progress",
  "session.managed_settings_resolved",
  "session.managed_settings_enforced",
  "commands.changed",
  "capabilities.changed",
  "exit_plan_mode.requested",
  "exit_plan_mode.completed",
  "human_response.recorded",
  "session.tools_updated",
  "session.background_tasks_changed",
  "workflow.run_updated",
  "workflow.run_started",
  "workflow.run_settled",
  "session.skills_loaded",
  "session.custom_agents_updated",
  "session.mcp_servers_loaded",
  "session.mcp_server_status_changed",
  "session.mcp_server_tools_loaded",
  "session.mcp_server_removed",
  "session.mcp_server_needs_reconnect",
  "mcp.tools.list_changed",
  "mcp.resources.list_changed",
  "mcp.prompts.list_changed",
  "session.extensions_loaded",
  "session.canvas.opened",
  "session.canvas.registry_changed",
  "session.canvas.closed",
  "session.canvas.unavailable",
  "session.canvas.recorded",
  "session.canvas.removed",
  "session.extensions.attachments_pushed",
  "mcp_app.tool_call_complete",
]);

interface EventGroup {
  start: number;
  end: number;
  events: SessionEvent[];
}

export function pageSessionEvents(
  input: {
    events: SessionEvent[];
    sessionId: string;
    cursor: string | null;
    connectorId: string;
    orgId: string;
    now: string;
    pageSize: number;
  },
): EventPage {
  const events = persistedEvents(input.events);
  const cursorIndex = cursorEventIndex(events, input.cursor, input.sessionId);
  const start = cursorIndex + 1;
  const groups = assistantMessageGroups(events);

  for (const group of groups) {
    if (group.start <= cursorIndex && group.end > cursorIndex) {
      throw new ChannelDriverError(
        "sync_failed",
        "Copilot event cursor falls inside a split assistant message; sync must be reseeded.",
      );
    }
  }

  let end = Math.min(events.length - 1, start + input.pageSize - 1);
  const incompleteGroupStart = firstIncompleteAssistantGroup(events);
  if (incompleteGroupStart !== undefined && end >= incompleteGroupStart) {
    end = incompleteGroupStart - 1;
  }
  for (const group of groups) {
    if (group.start <= end && group.end > end) {
      end = group.end;
    }
  }

  if (start > end || start >= events.length) {
    return {
      records: [],
      nextCursor: input.cursor
        ? encodeCursor(input.sessionId, decodeCursor(input.cursor, input.sessionId).eventId)
        : undefined,
      hasMore: false,
    };
  }

  const records: IngestRecord[] = [];
  for (let index = start; index <= end; index += 1) {
    const group = groups.find((candidate) => candidate.start === index);
    if (group) {
      const record = assistantGroupRecord(group, input);
      if (record) {
        records.push(record);
      }
      index = group.end;
      continue;
    }
    if (groups.some((candidate) => index > candidate.start && index <= candidate.end)) {
      continue;
    }
    const record = eventRecord(events[index]!, input, events);
    if (record) {
      records.push(record);
    }
  }

  const nextCursor = encodeCursor(input.sessionId, events[end]!.id);
  return {
    records,
    nextCursor,
    hasMore: end < events.length - 1,
  };
}

export function summarizeRunEvents(events: SessionEvent[]): RunEventSummary {
  const persisted = persistedEvents(events).filter((event) => !event.agentId);
  const userEvents = persisted.filter((event) => event.type === "user.message");
  const latestUserIndex = userEvents.length - 1;
  const latestUserId =
    latestUserIndex >= 0
      ? userEvents[latestUserIndex]!.id
      : undefined;
  const latestUserPosition = latestUserId
    ? persisted.findIndex((event) => event.id === latestUserId)
    : -1;
  const relevant = latestUserPosition < 0
    ? []
    : persisted.slice(latestUserPosition);
  const completed = relevant.some((event) => event.type === "assistant.turn_end");
  const failed = relevant.some((event) => event.type === "session.error");
  const messages = relevant
    .filter((event) => event.type === "assistant.message")
    .map((event) => event.data.content.trim())
    .filter(Boolean);
  const summary = messages.at(-1)?.slice(0, 8_000);
  return {
    complete: completed || failed,
    failed,
    ...(summary ? { summary } : {}),
    evidenceEventIds: relevant
      .filter(
        (event) =>
          event.type === "user.message" ||
          event.type === "assistant.message" ||
          event.type === "tool.execution_start" ||
          event.type === "tool.execution_complete",
      )
      .map((event) => event.id),
  };
}

export function encodeCursor(sessionId: string, eventId: string): string {
  return Buffer.from(JSON.stringify({ v: 1, sessionId, eventId })).toString("base64url");
}

function decodeCursor(
  cursor: string,
  sessionId: string,
): { eventId: string } {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      !isRecord(decoded) ||
      decoded.v !== 1 ||
      decoded.sessionId !== sessionId ||
      typeof decoded.eventId !== "string" ||
      !decoded.eventId
    ) {
      throw new Error();
    }
    return { eventId: decoded.eventId };
  } catch {
    throw new ChannelDriverError(
      "sync_failed",
      "Copilot event cursor is invalid or belongs to a different session.",
    );
  }
}

function cursorEventIndex(
  events: SessionEvent[],
  cursor: string | null,
  sessionId: string,
): number {
  if (!cursor) {
    return -1;
  }
  const eventId = decodeCursor(cursor, sessionId).eventId;
  const index = events.findIndex((event) => event.id === eventId);
  if (index < 0) {
    throw new ChannelDriverError(
      "sync_failed",
      "Copilot event history no longer contains the saved cursor; the source history may have changed.",
    );
  }
  return index;
}

function persistedEvents(events: SessionEvent[]): SessionEvent[] {
  if (!Array.isArray(events)) {
    throw new ChannelDriverError(
      "sync_failed",
      "Copilot returned an unsupported persisted event history.",
    );
  }
  const ids = new Set<string>();
  const result: SessionEvent[] = [];
  for (const candidate of events) {
    if (!isSessionEventRecord(candidate)) {
      throw new ChannelDriverError(
        "sync_failed",
        "Copilot returned a persisted event with an unsupported shape.",
      );
    }
    const event = candidate;
    if (event.ephemeral === true) {
      continue;
    }
    if (
      typeof event.id !== "string" ||
      !event.id ||
      typeof event.timestamp !== "string" ||
      !Number.isFinite(Date.parse(event.timestamp)) ||
      typeof event.type !== "string" ||
      !SUPPORTED_EVENT_TYPES.has(event.type) ||
      !isRecord(event.data) ||
      (event.ephemeral !== undefined && typeof event.ephemeral !== "boolean")
    ) {
      throw new ChannelDriverError(
        "sync_failed",
        "Copilot returned a persisted event with an unsupported shape or SDK event type.",
      );
    }
    if (ids.has(event.id)) {
      throw new ChannelDriverError(
        "sync_failed",
        "Copilot returned duplicate persisted event IDs.",
      );
    }
    ids.add(event.id);
    result.push(event);
  }
  return result;
}

function assistantMessageGroups(events: SessionEvent[]): EventGroup[] {
  const byCall = new Map<string, Array<{ event: SessionEvent; index: number }>>();
  events.forEach((event, index) => {
    if (event.type !== "assistant.message" || event.agentId) {
      return;
    }
    const data = event.data;
    if (!data.apiCallId || !data.chunkCount || data.chunkCount <= 1) {
      return;
    }
    const key = data.apiCallId;
    const group = byCall.get(key) ?? [];
    group.push({ event, index });
    byCall.set(key, group);
  });
  return [...byCall.values()].map((members) => ({
    start: Math.min(...members.map((member) => member.index)),
    end: Math.max(...members.map((member) => member.index)),
    events: members.map((member) => member.event),
  }));
}

function firstIncompleteAssistantGroup(events: SessionEvent[]): number | undefined {
  let first: number | undefined;
  const groups = new Map<string, Array<{ index: number; chunkIndex: number; chunkCount: number }>>();
  events.forEach((event, index) => {
    if (event.type !== "assistant.message" || event.agentId) {
      return;
    }
    const { apiCallId, chunkCount, chunkIndex } = event.data;
    if (!apiCallId || !chunkCount || chunkCount <= 1) {
      return;
    }
    const group = groups.get(apiCallId) ?? [];
    group.push({
      index,
      chunkIndex: Number.isSafeInteger(chunkIndex) ? chunkIndex! : -1,
      chunkCount,
    });
    groups.set(apiCallId, group);
  });
  for (const group of groups.values()) {
    const expected = group[0]?.chunkCount ?? 0;
    const indexes = new Set(group.map((member) => member.chunkIndex));
    if (
      group.length !== expected ||
      Array.from({ length: expected }, (_, index) => indexes.has(index)).some((present) => !present)
    ) {
      const start = Math.min(...group.map((member) => member.index));
      first = first === undefined ? start : Math.min(first, start);
    }
  }
  return first;
}

function assistantGroupRecord(
  group: EventGroup,
  input: {
    sessionId: string;
    connectorId: string;
    orgId: string;
  },
): IngestRecord | undefined {
  const chunks = group.events
    .filter((event) => event.type === "assistant.message")
    .sort((left, right) => {
      if (left.type !== "assistant.message" || right.type !== "assistant.message") {
        return 0;
      }
      return (left.data.chunkIndex ?? 0) - (right.data.chunkIndex ?? 0);
    });
  if (chunks.length === 0) {
    return undefined;
  }
  const last = chunks.at(-1)!;
  const text = chunks
    .map((event) => (event.type === "assistant.message" ? event.data.content : ""))
    .join("");
  return messageRecord(last, input, text, chunks[0]!.parentId);
}

function eventRecord(
  event: SessionEvent,
  input: {
    sessionId: string;
    connectorId: string;
    orgId: string;
    now: string;
  },
  events: SessionEvent[],
): IngestRecord | undefined {
  if (event.type === "user.message") {
    if (event.agentId || !event.data.content.trim()) {
      return undefined;
    }
    return messageRecord(event, input, event.data.content);
  }
  if (event.type === "assistant.message") {
    if (event.agentId || !event.data.content.trim()) {
      return undefined;
    }
    return messageRecord(event, input, event.data.content);
  }
  if (event.type === "tool.execution_start" || event.type === "tool.execution_complete") {
    const data = event.data;
    const toolName = toolNameFor(event, events);
    const action = event.type === "tool.execution_start" ? "started" : "completed";
    const text = `Copilot tool ${toolName} ${action}`;
    return channelRecord({
      channel: SOURCE,
      kind: "system",
      direction: "outbound",
      external_id: `${input.sessionId}:${event.id}`,
      occurred_at: event.timestamp,
      actor_id: "github-copilot-cli:tool",
      actor_label: "Copilot tool",
      scope_id: input.sessionId,
      scope_name: "GitHub Copilot task",
      thread_id: `${SOURCE}:${input.sessionId}`,
      thread_facet: "agent",
      type: "task",
      parent_external_id: event.parentId
        ? `${input.sessionId}:${event.parentId}`
        : undefined,
      text,
    });
  }
  return undefined;
}

function toolNameFor(event: SessionEvent, events: SessionEvent[]): string {
  if (event.type === "tool.execution_start") {
    return safeToolName(event.data.toolName);
  }
  if (event.type !== "tool.execution_complete") {
    return "unnamed";
  }
  const start = events.find(
    (candidate) =>
      candidate.type === "tool.execution_start" &&
      candidate.data.toolCallId === event.data.toolCallId,
  );
  return start?.type === "tool.execution_start"
    ? safeToolName(start.data.toolName)
    : "unnamed";
}

function messageRecord(
  event: Extract<SessionEvent, { type: "user.message" | "assistant.message" }>,
  input: {
    sessionId: string;
    connectorId: string;
    orgId: string;
  },
  text: string,
  parentId = event.parentId,
): IngestRecord | undefined {
  const content = text.trim();
  if (!content) {
    return undefined;
  }
  const user = event.type === "user.message";
  return channelRecord({
    channel: SOURCE,
    kind: user ? "user" : "assistant",
    direction: user ? "inbound" : "outbound",
    external_id: `${input.sessionId}:${event.id}`,
    occurred_at: event.timestamp,
    actor_id: user ? "github-copilot-cli:user" : "github-copilot-cli:assistant",
    actor_label: user ? "User" : "GitHub Copilot",
    scope_id: input.sessionId,
    scope_name: "GitHub Copilot task",
    thread_id: `${SOURCE}:${input.sessionId}`,
    thread_facet: "agent",
    type: "message",
    parent_external_id: parentId
      ? `${input.sessionId}:${parentId}`
      : undefined,
    text: content,
  });
}

function safeToolName(value: unknown): string {
  if (typeof value !== "string") {
    return "unnamed";
  }
  const safe = value.replace(/[^a-zA-Z0-9._:-]/g, "").slice(0, 80);
  return safe || "unnamed";
}

export function deterministicDeliveryId(value: string): string {
  return `copilot-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionEventRecord(value: unknown): value is SessionEvent {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.type === "string" &&
    isRecord(value.data)
  );
}
