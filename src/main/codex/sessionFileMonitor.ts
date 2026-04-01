import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import type { AttentionSnapshot, ConnectionDebugInfo, MonitorEvent } from "../../shared/types.js";

interface SessionFileMonitorOptions {
  sessionRoot?: string;
  sourceId?: string;
  sourceLabel?: string;
  scanIntervalMs?: number;
  activeWindowMs?: number;
}

interface SessionFileMonitorResolvedOptions {
  sessionRoot: string;
  sourceId?: string;
  sourceLabel?: string;
  scanIntervalMs: number;
  activeWindowMs: number;
}

interface SessionRecord {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

interface SessionFileState {
  path: string;
  offset: number;
  sessionId?: string;
  cwd?: string;
  currentTurnId?: string;
  sourceLabel: string;
  lastEventAt?: string;
  lastSeenMs: number;
  turnModes: Map<string, string>;
}

type EventListener = (event: MonitorEvent) => void | Promise<void>;

const DEFAULT_SCAN_INTERVAL_MS = 1_500;
const DEFAULT_ACTIVE_WINDOW_MS = 30 * 60 * 1_000;
const INITIAL_TAIL_BYTES = 256 * 1024;

export class SessionFileMonitor {
  private readonly options: SessionFileMonitorResolvedOptions;
  private readonly listeners = new Set<EventListener>();
  private readonly files = new Map<string, SessionFileState>();
  private scanTimer?: NodeJS.Timeout;
  private scanInFlight = false;
  private connected = false;
  private initialized = false;
  private lastEventAt?: string;
  private errorMessage?: string;

  constructor(options: SessionFileMonitorOptions = {}) {
    this.options = {
      sessionRoot: options.sessionRoot ?? join(homedir(), ".codex", "sessions"),
      sourceId: options.sourceId,
      sourceLabel: options.sourceLabel,
      scanIntervalMs: options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS,
      activeWindowMs: options.activeWindowMs ?? DEFAULT_ACTIVE_WINDOW_MS
    };
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.scanTimer) {
      return;
    }

    this.connected = true;
    this.initialized = true;
    this.errorMessage = undefined;

    await this.emitEvent({
      timestamp: new Date().toISOString(),
      kind: "lifecycle.connected",
      raw: {
        mode: "auto",
        sessionRoot: this.options.sessionRoot
      }
    });

    await this.emitEvent({
      timestamp: new Date().toISOString(),
      kind: "server.initialized",
      preview: "codex-session-files/auto",
      raw: {
        mode: "auto",
        sessionRoot: this.options.sessionRoot
      }
    });

    await this.scanOnce();
    this.scanTimer = setInterval(() => {
      void this.scanOnce();
    }, this.options.scanIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }

    const wasConnected = this.connected || this.initialized;
    this.connected = false;
    this.initialized = false;
    this.files.clear();

    if (wasConnected) {
      await this.emitEvent({
        timestamp: new Date().toISOString(),
        kind: "lifecycle.disconnected",
        raw: {
          mode: "auto",
          sessionRoot: this.options.sessionRoot
        }
      });
    }
  }

  getConnectionDebugInfo(): ConnectionDebugInfo {
    const activeFiles = [...this.files.values()]
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs)
      .map((file) => file.path);

    return {
      mode: "auto",
      listenUrl: this.options.sessionRoot,
      listenUrls: activeFiles,
      connected: this.connected,
      initialized: this.initialized,
      connectedSources: activeFiles.length,
      initializedSources: activeFiles.length,
      totalSources: activeFiles.length,
      lastEventAt: this.lastEventAt,
      errorMessage: this.errorMessage,
      errorMessages: this.errorMessage ? [this.errorMessage] : []
    };
  }

  private async scanOnce(): Promise<void> {
    if (this.scanInFlight) {
      return;
    }

    this.scanInFlight = true;

    try {
      const now = Date.now();
      const sessionFiles = await listJsonlFiles(this.options.sessionRoot);

      for (const path of sessionFiles) {
        const stats = await stat(path);
        if (now - stats.mtimeMs > this.options.activeWindowMs) {
          continue;
        }

        const fileState =
          this.files.get(path) ??
          ({
            path,
            offset: Math.max(0, stats.size - INITIAL_TAIL_BYTES),
            sourceLabel: basename(path),
            lastSeenMs: stats.mtimeMs,
            turnModes: new Map<string, string>()
          } satisfies SessionFileState);

        fileState.lastSeenMs = stats.mtimeMs;
        this.files.set(path, fileState);
        await this.readAppendedRecords(fileState);
      }

      for (const [path, fileState] of this.files) {
        if (now - fileState.lastSeenMs > this.options.activeWindowMs) {
          this.files.delete(path);
        }
      }
    } catch (error) {
      this.errorMessage = error instanceof Error ? error.message : String(error);
    } finally {
      this.scanInFlight = false;
    }
  }

  private async readAppendedRecords(fileState: SessionFileState): Promise<void> {
    const contents = await readFile(fileState.path, "utf8");
    if (contents.length <= fileState.offset) {
      return;
    }

    const chunk = contents.slice(fileState.offset);
    const endsWithNewline = chunk.endsWith("\n");
    const lines = chunk.split("\n");
    const completeLines = endsWithNewline ? lines.filter(Boolean) : lines.slice(0, -1).filter(Boolean);

    if (completeLines.length === 0) {
      return;
    }

    fileState.offset += completeLines.reduce((total, line) => total + line.length + 1, 0);

    for (const line of completeLines) {
      const record = parseSessionRecord(line);
      if (!record) {
        continue;
      }

      const events = mapSessionRecordToEvents(record, fileState);
      for (const event of events) {
        await this.emitEvent(event);
      }
    }
  }

  private async emitEvent(event: MonitorEvent): Promise<void> {
    const enrichedEvent: MonitorEvent = {
      ...event,
      sourceId: event.sourceId ?? this.options.sourceId ?? "auto:sessions",
      sourceLabel: event.sourceLabel ?? this.options.sourceLabel ?? "codex auto"
    };

    this.lastEventAt = enrichedEvent.timestamp;

    for (const listener of this.listeners) {
      await listener(enrichedEvent);
    }
  }
}

function parseSessionRecord(line: string): SessionRecord | undefined {
  try {
    return JSON.parse(line) as SessionRecord;
  } catch {
    return undefined;
  }
}

function mapSessionRecordToEvents(
  record: SessionRecord,
  fileState: SessionFileState
): MonitorEvent[] {
  const timestamp = record.timestamp ?? new Date().toISOString();
  const payload = record.payload ?? {};

  if (record.type === "session_meta") {
    const sessionId = getString(payload, "id");
    const cwd = getString(payload, "cwd");

    fileState.sessionId = sessionId ?? fileState.sessionId ?? basename(fileState.path);
    fileState.cwd = cwd ?? fileState.cwd;
    fileState.sourceLabel = cwd ? `${basename(cwd)} (${basename(fileState.path)})` : basename(fileState.path);

    return [
      {
        timestamp,
        kind: "thread.started",
        threadId: fileState.sessionId,
        cwd: fileState.cwd,
        status: "idle",
        preview: cwd ?? basename(fileState.path),
        sourceId: `auto:${fileState.sessionId ?? basename(fileState.path)}`,
        sourceLabel: fileState.sourceLabel,
        raw: record
      }
    ];
  }

  if (record.type === "turn_context") {
    const turnId = getString(payload, "turn_id");
    const collaborationMode = getString(payload, "collaboration_mode.mode");
    const cwd = getString(payload, "cwd");

    if (turnId) {
      fileState.currentTurnId = turnId;
      if (collaborationMode) {
        fileState.turnModes.set(turnId, collaborationMode);
      }
    }
    if (cwd) {
      fileState.cwd = cwd;
    }

    return [];
  }

  if (record.type === "event_msg") {
    const payloadType = getString(payload, "type");
    const sessionId = fileState.sessionId ?? basename(fileState.path);
    const turnId = getTurnId(payload, fileState);

    switch (payloadType) {
      case "task_started":
        if (turnId) {
          fileState.currentTurnId = turnId;
        }
        return [
          {
            timestamp,
            kind: "thread.status.changed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "active",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          },
          {
            timestamp,
            kind: "turn.started",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "active",
            stateHint: "thinking",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      case "agent_message":
        return [
          buildAssistantMessageEvent({
            timestamp,
            sessionId,
            turnId,
            text: getString(payload, "message"),
            phase: getString(payload, "phase"),
            fileState,
            raw: record
          })
        ].filter((value): value is MonitorEvent => Boolean(value));
      case "user_message":
        return [
          {
            timestamp,
            kind: "user.message",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            messageRole: "user",
            messageText: getString(payload, "message"),
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      case "task_complete":
        return [
          {
            timestamp,
            kind: "thread.status.changed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "idle",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          },
          {
            timestamp,
            kind: "turn.completed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "completed",
            stateHint: "success",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      case "turn_aborted":
        return [
          {
            timestamp,
            kind: "thread.status.changed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "idle",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          },
          {
            timestamp,
            kind: "turn.completed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            status: "failed",
            error: "Turn aborted",
            stateHint: "error",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      default:
        return [];
    }
  }

  if (record.type === "response_item") {
    const itemType = getString(payload, "type");
    const sessionId = fileState.sessionId ?? basename(fileState.path);
    const turnId = getTurnId(payload, fileState);

    switch (itemType) {
      case "message": {
        const role = getString(payload, "role");
        const text = extractResponseMessageText(payload);

        if (role === "assistant") {
          return [
            buildAssistantMessageEvent({
              timestamp,
              sessionId,
              turnId,
              text,
              phase: getString(payload, "phase"),
              fileState,
              raw: record
            })
          ].filter((value): value is MonitorEvent => Boolean(value));
        }

        if (role === "user") {
          return [
            {
              timestamp,
              kind: "user.message",
              threadId: sessionId,
              turnId,
              cwd: fileState.cwd,
              messageRole: role,
              messageText: text,
              sourceId: `auto:${sessionId}`,
              sourceLabel: fileState.sourceLabel,
              raw: record
            }
          ];
        }

        return [];
      }
      case "reasoning":
        return [
          {
            timestamp,
            kind: "item.reasoning.delta",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            delta: summarizeReasoning(payload),
            stateHint: "thinking",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      case "function_call":
      case "custom_tool_call": {
        const name = getString(payload, "name");
        const attention =
          name === "request_user_input"
            ? buildRequestUserInputAttention(timestamp, sessionId, turnId, fileState, payload)
            : undefined;

        return [
          {
            timestamp,
            kind: attention ? "tool.request_user_input" : "item.started",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            itemType: itemType === "function_call" ? "dynamicToolCall" : "mcpToolCall",
            stateHint: attention ? "approval" : "working",
            preview: name,
            attention,
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      }
      case "function_call_output":
      case "custom_tool_call_output":
        return [
          {
            timestamp,
            kind: "item.completed",
            threadId: sessionId,
            turnId,
            cwd: fileState.cwd,
            itemType: itemType === "function_call_output" ? "dynamicToolCall" : "mcpToolCall",
            sourceId: `auto:${sessionId}`,
            sourceLabel: fileState.sourceLabel,
            raw: record
          }
        ];
      default:
        return [];
    }
  }

  return [];
}

function buildAssistantMessageEvent(input: {
  timestamp: string;
  sessionId: string;
  turnId?: string;
  text?: string;
  phase?: string;
  fileState: SessionFileState;
  raw: unknown;
}): MonitorEvent | undefined {
  const text = normalizeMessageText(input.text);
  if (!text) {
    return undefined;
  }

  const attention = buildAssistantAttention(
    input.timestamp,
    input.sessionId,
    input.turnId,
    input.phase,
    input.fileState,
    text
  );

  return {
    timestamp: input.timestamp,
    kind: "assistant.message",
    threadId: input.sessionId,
    turnId: input.turnId,
    cwd: input.fileState.cwd,
    messageRole: "assistant",
    messageText: text,
    phase: input.phase,
    delta: text,
    stateHint: attention ? "approval" : "typing",
    attention,
    sourceId: `auto:${input.sessionId}`,
    sourceLabel: input.fileState.sourceLabel,
    raw: input.raw
  };
}

function buildAssistantAttention(
  timestamp: string,
  sessionId: string,
  turnId: string | undefined,
  phase: string | undefined,
  fileState: SessionFileState,
  text: string
): AttentionSnapshot | undefined {
  if (phase === "commentary") {
    return undefined;
  }

  const mode = getTurnMode(fileState, turnId);
  const detail = summarizeMessage(text);

  if (text.includes("<proposed_plan>")) {
    return {
      id: `plan-ready:${timestamp}:${sessionId}`,
      kind: "plan_ready",
      source: "codex",
      title: "Codex has a proposed plan ready",
      detail,
      detectedAt: timestamp,
      sourceId: `auto:${sessionId}`,
      sourceLabel: fileState.sourceLabel,
      threadId: sessionId,
      turnId,
      cwd: fileState.cwd
    };
  }

  if (mode === "plan") {
    return {
      id: `plan-question:${timestamp}:${sessionId}`,
      kind: "plan_question",
      source: "codex",
      title: "Codex is waiting for plan input",
      detail,
      detectedAt: timestamp,
      sourceId: `auto:${sessionId}`,
      sourceLabel: fileState.sourceLabel,
      threadId: sessionId,
      turnId,
      cwd: fileState.cwd
    };
  }

  if (!looksLikeUserPrompt(text)) {
    return undefined;
  }

  return {
    id: `assistant-question:${timestamp}:${sessionId}`,
    kind: "assistant_question",
    source: "codex",
    title: "Codex needs your attention",
    detail,
    detectedAt: timestamp,
    sourceId: `auto:${sessionId}`,
    sourceLabel: fileState.sourceLabel,
    threadId: sessionId,
    turnId,
    cwd: fileState.cwd
  };
}

function buildRequestUserInputAttention(
  timestamp: string,
  sessionId: string,
  turnId: string | undefined,
  fileState: SessionFileState,
  payload: Record<string, unknown>
): AttentionSnapshot {
  const parsedArguments = parseJsonObject(getString(payload, "arguments"));
  const firstQuestion = Array.isArray(parsedArguments?.questions)
    ? parsedArguments.questions.find((value) => value && typeof value === "object")
    : undefined;
  const question =
    firstQuestion && typeof firstQuestion === "object"
      ? getString(firstQuestion as Record<string, unknown>, "question")
      : undefined;

  return {
    id: `request-user-input:${timestamp}:${sessionId}`,
    kind: "request_user_input",
    source: "codex",
    title: "Codex requested your input",
    detail: question ?? "A plan or decision prompt is waiting for your answer.",
    detectedAt: timestamp,
    sourceId: `auto:${sessionId}`,
    sourceLabel: fileState.sourceLabel,
    threadId: sessionId,
    turnId,
    cwd: fileState.cwd
  };
}

async function listJsonlFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(absolutePath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }

  return files;
}

function getTurnId(
  payload: Record<string, unknown>,
  fileState: SessionFileState
): string | undefined {
  return getString(payload, "turn_id") ?? getString(payload, "turnId") ?? fileState.currentTurnId;
}

function getTurnMode(fileState: SessionFileState, turnId?: string): string | undefined {
  if (!turnId) {
    return undefined;
  }

  return fileState.turnModes.get(turnId);
}

function extractResponseMessageText(payload: Record<string, unknown>): string | undefined {
  const content = payload.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const parts = content
    .map((item) => {
      if (!item || typeof item !== "object") {
        return undefined;
      }

      const record = item as Record<string, unknown>;
      if (typeof record.text === "string") {
        return record.text;
      }

      if (typeof record.input_text === "string") {
        return record.input_text;
      }

      return undefined;
    })
    .filter((value): value is string => Boolean(value));

  return parts.join("\n").trim() || undefined;
}

function getString(value: Record<string, unknown>, path: string): string | undefined {
  const result = getValue(value, path);
  return typeof result === "string" ? result : undefined;
}

function getValue(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

function summarizeReasoning(payload: Record<string, unknown>): string | undefined {
  const summary = payload.summary;
  if (!Array.isArray(summary)) {
    return undefined;
  }

  const texts = summary
    .map((entry) =>
      entry && typeof entry === "object" && "text" in entry && typeof entry.text === "string"
        ? entry.text
        : undefined
    )
    .filter((value): value is string => Boolean(value));

  return texts.join(" ").trim() || undefined;
}

function normalizeMessageText(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function summarizeMessage(value: string): string {
  const withoutPlanMarkers = value.replace(/<\/?proposed_plan>/g, " ");
  const singleLine = withoutPlanMarkers.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 160) {
    return singleLine;
  }
  return `${singleLine.slice(0, 157)}...`;
}

function looksLikeUserPrompt(value: string): boolean {
  if (/\?(\s|$)/.test(value)) {
    return true;
  }

  return /\b(do you want|would you like|can you|could you|which option|which one|please choose|pick one|select one|let me know)\b/i.test(
    value
  );
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
