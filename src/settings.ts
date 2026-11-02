import { homedir } from "node:os";
import path from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import type { JsonValue } from "@regenic/connector-contract";

export interface CopilotSettings {
  copilot_home: string;
  state_dir: string;
  working_directory: string;
  sync_enabled: boolean;
  execution_enabled: boolean;
  available_tools: string[];
  permission_timeout_ms: number;
}

export interface CopilotPaths {
  copilotHome: string;
  stateDir: string;
  workingDirectory: string;
}

export function configString(
  config: Record<string, JsonValue>,
  key: string,
): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function configEnabled(value: unknown): boolean {
  if (value === undefined || value === false || value === "false") {
    return false;
  }
  if (value === true || value === "true") {
    return true;
  }
  throw new Error("Connector enable flags must be true or false.");
}

export function configText(config: Record<string, JsonValue>, key: string): string {
  return configString(config, key) ?? "";
}

export function readCopilotSettings(
  config: Record<string, JsonValue>,
): CopilotSettings {
  const permissionTimeout = config.permission_timeout_ms;
  const permissionTimeoutMs = parsePermissionTimeout(permissionTimeout);
  const executionEnabled = configEnabled(config.execution_enabled);
  return {
    copilot_home: configText(config, "copilot_home"),
    state_dir: configText(config, "state_dir"),
    working_directory: configText(config, "working_directory"),
    sync_enabled: configEnabled(config.sync_enabled),
    execution_enabled: executionEnabled,
    available_tools: executionEnabled
      ? parseToolAllowlist(config.available_tools)
      : [],
    permission_timeout_ms: permissionTimeoutMs,
  };
}

export function parseToolAllowlist(value: unknown): string[] {
  const raw = typeof value === "string" ? value : "";
  const tools = [...new Set(raw.split(/[,\n]/).map((tool) => tool.trim()).filter(Boolean))];
  for (const tool of tools) {
    if (!/^builtin:[a-z0-9][a-z0-9._-]{0,127}$/i.test(tool)) {
      throw new Error(
        "Only exact built-in tool names are allowed; MCP, custom, plugin, and other tools are disabled.",
      );
    }
  }
  if (tools.length === 0) {
    throw new Error(
      "No tools are enabled. Add explicit builtin tool names to the available_tools allowlist.",
    );
  }
  return tools;
}

export async function resolveCopilotPaths(
  config: Record<string, JsonValue>,
): Promise<CopilotPaths> {
  const copilotHome = configString(config, "copilot_home");
  const stateDir = configString(config, "state_dir");
  const workingDirectory = configString(config, "working_directory");
  if (!copilotHome || !stateDir || !workingDirectory) {
    throw new Error(
      "copilot_home, state_dir, and working_directory must be explicitly configured.",
    );
  }
  const home = await existingDirectory(copilotHome, "copilot_home");
  const workspace = await existingDirectory(workingDirectory, "working_directory");
  const absoluteStateDir = requireAbsolutePath(stateDir, "state_dir");
  const prospectiveStateDir = await resolveProspectivePath(absoluteStateDir);
  if (
    pathsOverlap(prospectiveStateDir, home) ||
    pathsOverlap(prospectiveStateDir, workspace)
  ) {
    throw new Error(
      "state_dir must be separate from copilot_home and working_directory.",
    );
  }
  const state = await createStateDirectory(absoluteStateDir);
  if (pathsOverlap(state, home) || pathsOverlap(state, workspace)) {
    throw new Error(
      "state_dir must be separate from copilot_home and working_directory.",
    );
  }
  return {
    copilotHome: home,
    stateDir: state,
    workingDirectory: workspace,
  };
}

export function runtimeEnvironment(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    HOME: homedir(),
  };
  for (const key of ["PATH", "USERPROFILE", "SystemRoot", "TEMP", "TMP"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

async function existingDirectory(value: string, label: string): Promise<string> {
  const absolute = requireAbsolutePath(value, label);
  try {
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error();
    }
    return await realpath(absolute);
  } catch {
    throw new Error(`${label} must be an existing, non-symlink directory.`);
  }
}

async function createStateDirectory(value: string): Promise<string> {
  const absolute = requireAbsolutePath(value, "state_dir");
  try {
    await mkdir(absolute, { recursive: true, mode: 0o700 });
    const stats = await lstat(absolute);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error();
    }
    return await realpath(absolute);
  } catch {
    throw new Error("state_dir must be a writable, non-symlink directory.");
  }
}

async function resolveProspectivePath(value: string): Promise<string> {
  let candidate = value;
  const missingSegments: string[] = [];
  while (true) {
    try {
      const existing = await realpath(candidate);
      return path.join(existing, ...missingSegments.reverse());
    } catch (error) {
      if (!isMissingPath(error)) {
        throw new Error("state_dir path cannot be safely resolved.");
      }
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        throw new Error("state_dir path cannot be safely resolved.");
      }
      missingSegments.unshift(path.basename(candidate));
      candidate = parent;
    }
  }
}

function requireAbsolutePath(value: string, label: string): string {
  if (!path.isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.normalize(value);
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function parsePermissionTimeout(value: unknown): number {
  if (value === undefined) {
    return 5 * 60_000;
  }
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < 1_000 ||
    parsed > 15 * 60_000
  ) {
    throw new Error("permission_timeout_ms must be between 1000 and 900000.");
  }
  return parsed;
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}
