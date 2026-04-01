import type {
  AttentionSnapshot,
  DeskPetState,
  MonitorEvent,
  MonitorSnapshot,
  ThreadSessionView
} from "../../shared/types.js";
import { getMinDisplayMs, getStatePriority } from "./priority.js";

interface ThreadSessionInternal extends ThreadSessionView {
  holdUntilMs: number | null;
}

type SnapshotListener = (snapshot: MonitorSnapshot) => void;

export class MonitorStateAggregator {
  private connected = false;
  private initialized = false;
  private serverPlatform?: string;
  private totalEvents = 0;
  private updatedAt?: string;
  private readonly sessions = new Map<string, ThreadSessionInternal>();
  private recentEvents: MonitorEvent[] = [];
  private readonly listeners = new Set<SnapshotListener>();
  private expiryTimer?: NodeJS.Timeout;
  private manualAttention?: AttentionSnapshot;

  onSnapshot(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.connected = false;
    this.initialized = false;
    this.serverPlatform = undefined;
    this.totalEvents = 0;
    this.updatedAt = undefined;
    this.manualAttention = undefined;
    this.sessions.clear();
    this.recentEvents = [];

    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }

    this.emitSnapshot();
  }

  applyEvent(event: MonitorEvent): void {
    this.totalEvents += 1;
    this.updatedAt = event.timestamp;
    this.recentEvents = [event, ...this.recentEvents].slice(0, 200);

    if (event.kind === "lifecycle.connected") {
      this.connected = true;
    } else if (event.kind === "lifecycle.disconnected") {
      this.connected = false;
      this.initialized = false;
      this.serverPlatform = undefined;
    } else if (event.kind === "server.initialized") {
      this.initialized = true;
      this.serverPlatform = event.preview;
    }

    if (event.threadId) {
      this.applyThreadEvent(event.threadId, event);
    }

    this.scheduleExpiry();
    this.emitSnapshot();
  }

  setManualAttention(attention: Omit<AttentionSnapshot, "id" | "detectedAt" | "source">): void {
    const detectedAt = new Date().toISOString();
    this.manualAttention = {
      ...attention,
      id: `manual:${Date.now()}`,
      detectedAt,
      source: "hook"
    };
    this.updatedAt = detectedAt;
    this.emitSnapshot();
  }

  clearManualAttention(): void {
    if (!this.manualAttention) {
      return;
    }

    this.manualAttention = undefined;
    this.emitSnapshot();
  }

  getAttentionSnapshot(): AttentionSnapshot | undefined {
    this.refreshExpiredStates();
    return cloneAttention(this.selectActiveAttention());
  }

  getSnapshot(): MonitorSnapshot {
    this.refreshExpiredStates();

    const threads = [...this.sessions.values()]
      .sort((left, right) => {
        const leftUpdated = Date.parse(left.updatedAt);
        const rightUpdated = Date.parse(right.updatedAt);
        return rightUpdated - leftUpdated;
      })
      .map<ThreadSessionView>((session) => ({
        sourceId: session.sourceId,
        sourceLabel: session.sourceLabel,
        threadId: session.threadId,
        cwd: session.cwd,
        baseState: session.baseState,
        displayState: session.displayState,
        status: session.status,
        activeFlags: session.activeFlags,
        currentTurnId: session.currentTurnId,
        lastEventKind: session.lastEventKind,
        lastItemType: session.lastItemType,
        lastMessageRole: session.lastMessageRole,
        lastMessageText: session.lastMessageText,
        lastDelta: session.lastDelta,
        lastPreview: session.lastPreview,
        lastError: session.lastError,
        attention: cloneAttention(session.attention),
        eventCount: session.eventCount,
        updatedAt: session.updatedAt
      }));

    const attention = this.selectActiveAttention();

    return {
      connected: this.connected,
      initialized: this.initialized,
      serverPlatform: this.serverPlatform,
      currentState: attention ? "approval" : selectGlobalState(threads),
      totalEvents: this.totalEvents,
      updatedAt: this.updatedAt,
      threads,
      recentEvents: this.recentEvents
    };
  }

  private applyThreadEvent(threadId: string, event: MonitorEvent): void {
    const sessionKey = getSessionKey(event.sourceId, threadId);
    const session =
      this.sessions.get(sessionKey) ?? createThreadSession(threadId, event.timestamp);

    session.updatedAt = event.timestamp;
    session.sourceId = event.sourceId;
    session.sourceLabel = event.sourceLabel;
    session.eventCount += 1;
    session.lastEventKind = event.kind;
    session.lastItemType = event.itemType;
    session.lastDelta = event.delta;
    session.lastPreview = event.preview;
    session.lastError = event.error;

    if (event.cwd) {
      session.cwd = event.cwd;
    }
    if (event.turnId) {
      session.currentTurnId = event.turnId;
    }
    if (
      event.status &&
      (event.kind === "thread.started" || event.kind === "thread.status.changed")
    ) {
      session.status = event.status;
    }
    if (event.activeFlags) {
      session.activeFlags = event.activeFlags;
    }
    if (event.messageRole) {
      session.lastMessageRole = event.messageRole;
    }
    if (event.messageText) {
      session.lastMessageText = event.messageText;
    }

    if (event.attention) {
      session.attention = cloneAttention(event.attention);
    } else if (shouldClearAttention(session, event)) {
      session.attention = undefined;
    } else if (
      event.kind === "thread.status.changed" &&
      event.activeFlags?.includes("waitingOnApproval")
    ) {
      session.attention = {
        id: `approval:${event.timestamp}:${threadId}`,
        kind: "waiting_on_approval",
        source: "codex",
        title: "Codex is waiting for approval",
        detail: buildApprovalDetail(event),
        detectedAt: event.timestamp,
        sourceId: event.sourceId,
        sourceLabel: event.sourceLabel,
        threadId,
        turnId: event.turnId ?? session.currentTurnId,
        cwd: session.cwd
      };
    }

    const nextBaseState = deriveBaseState(session, event);
    if (nextBaseState) {
      transitionThreadState(session, nextBaseState, Date.parse(event.timestamp));
    }

    this.sessions.set(sessionKey, session);
  }

  private refreshExpiredStates(): void {
    const now = Date.now();
    let changed = false;

    for (const session of this.sessions.values()) {
      if (
        session.holdUntilMs !== null &&
        now >= session.holdUntilMs &&
        session.displayState !== session.baseState
      ) {
        session.displayState = session.baseState;
        session.holdUntilMs = getHoldUntilMs(session.baseState, now);
        changed = true;
      }
    }

    if (changed) {
      this.scheduleExpiry();
    }
  }

  private scheduleExpiry(): void {
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
    }

    const now = Date.now();
    let nextExpiry: number | null = null;

    for (const session of this.sessions.values()) {
      if (
        session.holdUntilMs !== null &&
        session.displayState !== session.baseState &&
        session.holdUntilMs > now &&
        (nextExpiry === null || session.holdUntilMs < nextExpiry)
      ) {
        nextExpiry = session.holdUntilMs;
      }
    }

    if (nextExpiry === null) {
      return;
    }

    this.expiryTimer = setTimeout(() => {
      this.refreshExpiredStates();
      this.emitSnapshot();
    }, Math.max(0, nextExpiry - now));
  }

  private emitSnapshot(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }

  private selectActiveAttention(): AttentionSnapshot | undefined {
    if (this.manualAttention) {
      return this.manualAttention;
    }

    const sessionAttention = [...this.sessions.values()]
      .map((session) => session.attention)
      .filter((value): value is AttentionSnapshot => Boolean(value))
      .sort((left, right) => Date.parse(right.detectedAt) - Date.parse(left.detectedAt))
      .at(0);

    return sessionAttention;
  }
}

function createThreadSession(threadId: string, timestamp: string): ThreadSessionInternal {
  return {
    sourceId: undefined,
    sourceLabel: undefined,
    threadId,
    cwd: undefined,
    baseState: "idle",
    displayState: "idle",
    status: "idle",
    activeFlags: [],
    lastEventKind: "thread.created",
    lastItemType: undefined,
    lastMessageRole: undefined,
    lastMessageText: undefined,
    lastDelta: undefined,
    lastPreview: undefined,
    lastError: undefined,
    attention: undefined,
    eventCount: 0,
    updatedAt: timestamp,
    holdUntilMs: null
  };
}

function deriveBaseState(
  session: ThreadSessionInternal,
  event: MonitorEvent
): DeskPetState | undefined {
  if (event.attention) {
    return "approval";
  }

  if (event.kind === "thread.status.changed") {
    if (event.activeFlags?.includes("waitingOnApproval")) {
      return "approval";
    }
    if (event.status === "systemError") {
      return "error";
    }
    if (event.status === "idle") {
      return session.attention ? "approval" : "idle";
    }
    return undefined;
  }

  if (event.kind === "thread.started") {
    return "idle";
  }

  if (event.kind === "turn.completed") {
    if (event.status === "failed" || event.error) {
      return "error";
    }
    if (event.status === "completed") {
      return "success";
    }
  }

  if (event.kind === "server.error") {
    return "error";
  }

  if (event.stateHint) {
    return event.stateHint;
  }

  if (session.displayState === "approval" && !session.attention) {
    return "idle";
  }

  return undefined;
}

function transitionThreadState(
  session: ThreadSessionInternal,
  nextBaseState: DeskPetState,
  eventTimeMs: number
): void {
  const transientFallbackBaseState =
    (nextBaseState === "success" || nextBaseState === "error") && session.status === "idle"
      ? "idle"
      : nextBaseState;

  session.baseState = transientFallbackBaseState;

  if (
    session.displayState === "approval" &&
    nextBaseState !== "approval" &&
    !session.activeFlags.includes("waitingOnApproval") &&
    !session.attention
  ) {
    session.displayState = nextBaseState;
    session.holdUntilMs = getHoldUntilMs(nextBaseState, eventTimeMs);
    return;
  }

  if (session.holdUntilMs !== null && eventTimeMs < session.holdUntilMs) {
    if (getStatePriority(nextBaseState) < getStatePriority(session.displayState)) {
      return;
    }
  }

  session.displayState = nextBaseState;
  session.holdUntilMs = getHoldUntilMs(nextBaseState, eventTimeMs);
}

function getHoldUntilMs(state: DeskPetState, fromMs: number): number | null {
  const duration = getMinDisplayMs(state);
  return duration > 0 ? fromMs + duration : null;
}

function selectGlobalState(threads: ThreadSessionView[]): DeskPetState {
  if (threads.length === 0) {
    return "idle";
  }

  const [top] = [...threads].sort((left, right) => {
    const priorityDiff = getStatePriority(right.displayState) - getStatePriority(left.displayState);
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });

  return top.displayState;
}

function shouldClearAttention(session: ThreadSessionInternal, event: MonitorEvent): boolean {
  if (!session.attention) {
    return false;
  }

  if (event.kind === "user.message") {
    return true;
  }

  if (event.kind === "turn.started") {
    return true;
  }

  if (
    session.attention.kind === "waiting_on_approval" &&
    event.kind === "thread.status.changed" &&
    !event.activeFlags?.includes("waitingOnApproval")
  ) {
    return true;
  }

  return false;
}

function buildApprovalDetail(event: MonitorEvent): string | undefined {
  if (event.sourceLabel && event.turnId) {
    return `Approval requested from ${event.sourceLabel} on turn ${shortId(event.turnId)}`;
  }

  if (event.turnId) {
    return `Approval requested on turn ${shortId(event.turnId)}`;
  }

  return event.sourceLabel ? `Approval requested from ${event.sourceLabel}` : undefined;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function cloneAttention(value: AttentionSnapshot | undefined): AttentionSnapshot | undefined {
  return value ? { ...value } : undefined;
}

function getSessionKey(sourceId: string | undefined, threadId: string): string {
  return sourceId ? `${sourceId}::${threadId}` : threadId;
}
