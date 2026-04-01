import type { BrowserWindow as BrowserWindowType, Tray as TrayType } from "electron";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { CodexRuntime } from "./runtime.js";
import { SettingsStore, type PersistedSettings, type SizeKey } from "./settingsStore.js";
import { DashboardServer } from "../main/dashboard/dashboardServer.js";
import type {
  AttentionSnapshot,
  AppearanceConfig,
  BubbleConfig,
  BubbleDetailMode,
  BubbleRenderMeta,
  DesktopPetSnapshot,
  DeskPetState
} from "../shared/types.js";
const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} = createRequire(import.meta.url)("electron") as typeof import("electron");
type PetState =
  | "disconnected"
  | "idle"
  | "yawning"
  | "dozing"
  | "sleeping"
  | "waking"
  | "mini-idle"
  | "mini-peek"
  | "mini-alert"
  | "mini-happy"
  | "mini-sleep"
  | "thinking"
  | "working"
  | "juggling"
  | "notification"
  | "error"
  | "attention"
  | "carrying";

interface PetPresentation {
  state: PetState;
  svg: string;
}

interface HitBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MiniDockState {
  displayId: number;
  side: "left" | "right";
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "../../..");
const rendererEntry = join(projectRoot, "src/electron/renderer/index.html");
const preloadEntry = join(__dirname, "preload.js");

const isMac = process.platform === "darwin";

const SIZES: Record<SizeKey, { width: number; height: number }> = {
  S: { width: 150, height: 150 },
  M: { width: 210, height: 210 },
  L: { width: 270, height: 270 }
};

const BUBBLE_EXTRA_HEIGHT: Record<BubbleDetailMode, number> = {
  basic: 0,
  detailed: 44
};
const BUBBLE_SPACING_BASELINE_SHIFT_PX = 28;
const DEFAULT_BUBBLE_SPACING_PX = 0;
const MIN_BUBBLE_SPACING_PX = -20;
const MAX_BUBBLE_SPACING_PX = 180;

const SVG_IDLE_FOLLOW = "clawd-idle-follow.svg";
const SVG_IDLE_LOOK = "clawd-idle-look.svg";

const HIT_BOXES: Record<"default" | "sleeping" | "wide", HitBox> = {
  default: { x: -1, y: 5, w: 17, h: 12 },
  sleeping: { x: -2, y: 9, w: 19, h: 7 },
  wide: { x: -3, y: 3, w: 21, h: 14 }
};

const WIDE_SVGS = new Set([
  "clawd-error.svg",
  "clawd-working-building.svg",
  "clawd-notification.svg",
  "clawd-working-conducting.svg"
]);

const MOUSE_IDLE_TIMEOUT = 20_000;
const MOUSE_SLEEP_TIMEOUT = 60_000;
const IDLE_LOOK_DURATION = 10_000;
const YAWN_DURATION = 3_000;
const WAKE_DURATION = 1_500;
const SNAP_TOLERANCE = 30;
const MINI_OFFSET_RATIO = 0.486;
const PEEK_OFFSET = 25;

const OBJ_SCALE_W = 1.9;
const OBJ_SCALE_H = 1.3;
const OBJ_OFF_X = -0.45;
const OBJ_OFF_Y = -0.25;

let mainWindow: BrowserWindowType | null = null;
let tray: TrayType | null = null;
let isQuitting = false;
let currentSize: SizeKey = "M";
let latestSnapshot!: DesktopPetSnapshot;
let currentPresentation: PetPresentation = {
  state: "disconnected",
  svg: "clawd-disconnected.svg"
};
let currentHitBox: HitBox = HIT_BOXES.default;
let dragLocked = false;
let cursorPollingPaused = false;
let mouseOverPet = false;
let mouseOverBubble = false;
let mouseOverInteractive = false;
let miniMode = false;
let miniPeeked = false;
let miniDock: MiniDockState | null = null;
let preMiniBounds: Electron.Rectangle | null = null;
let sizeReferenceScaleFactor = 1;
let syncingWindowScale = false;
let mainTickTimer: NodeJS.Timeout | null = null;
let wakePollTimer: NodeJS.Timeout | null = null;
let idleLookTimer: NodeJS.Timeout | null = null;
let yawnTimer: NodeJS.Timeout | null = null;
let wakeTimer: NodeJS.Timeout | null = null;
let lastCursorX: number | null = null;
let lastCursorY: number | null = null;
let mouseStillSince = Date.now();
let isMouseIdle = false;
let idleLookPlayed = false;
let lastEyeDx = 0;
let lastEyeDy = 0;
let forceEyeResend = false;
let debugStateOverride: DeskPetState | null = null;
let bubbleVisible = true;
let bubbleDetailMode: BubbleDetailMode = "basic";
let bubbleSpacingPx = DEFAULT_BUBBLE_SPACING_PX;
let autoOpenAttention = false;
let attentionCommand: string | undefined;
let accentColor: string | undefined;
let runtime!: CodexRuntime;
let settingsStore!: SettingsStore;
let dashboardServer: DashboardServer | null = null;
let dashboardPort: number | null = null;
let lastHandledAttentionId: string | null = null;
const configuredExternalUrl = process.env.CODEX_APP_SERVER_URL?.trim();
const configuredExternalUrls = [
  ...(process.env.CODEX_APP_SERVER_URLS ?? "").split(/[\n,]/).map((value) => value.trim()),
  configuredExternalUrl ?? ""
].filter(Boolean);
const configuredDashboardPort = Number(process.env.CODEX_ATTENTION_PORT ?? "4580");
const ACCENT_PRESETS = [
  { label: "默认蓝紫", value: undefined },
  { label: "珊瑚橙", value: "#ff7a59" },
  { label: "森林绿", value: "#35b56a" },
  { label: "玫红", value: "#e85d92" },
  { label: "琥珀", value: "#d69a2d" }
] as const;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow) {
    return;
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.whenReady().then(async () => {
  settingsStore = new SettingsStore(join(app.getPath("userData"), "settings.json"));
  const persistedSettings = await settingsStore.load();
  applyPersistedSettings(persistedSettings);
  runtime = new CodexRuntime(projectRoot, getInitialRuntimeConfig(persistedSettings));
  latestSnapshot = runtime.getSnapshot();

  createWindow();
  createTray();
  registerIpc();
  startMainTick();

  runtime.onSnapshot((snapshot) => {
    latestSnapshot = snapshot;
    refreshFromRuntime();
    handleAttentionChange(snapshot);
    updateTrayMenu(snapshot);
  });

  await ensureDashboardServer();
  await runtime.start();
  refreshFromRuntime();
  handleAttentionChange(latestSnapshot);
});

async function shutdown(): Promise<void> {
  stopMainTick();
  await dashboardServer?.stop();
  dashboardServer = null;
  dashboardPort = null;
  await runtime.stop();
  app.quit();
}

function createWindow(): void {
  const display = screen.getPrimaryDisplay();
  sizeReferenceScaleFactor = display.scaleFactor;
  const { width, height } = getWindowSize(currentSize, display);
  const x = Math.round(display.workArea.x + display.workArea.width - width - 28);
  const y = Math.round(display.workArea.y + display.workArea.height - height - 36);

  const window = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void window.loadFile(rendererEntry);
  window.webContents.on("did-finish-load", () => {
    sendCurrentPresentation();
  });
  window.on("move", () => {
    if (syncingWindowScale) {
      return;
    }

    syncWindowSizeForCurrentDisplay(dragLocked ? "top-left" : "bottom-center");
  });

  window.on("close", (event) => {
    if (isQuitting) {
      return;
    }
    event.preventDefault();
    window.hide();
  });

  mainWindow = window;
}

function createTray(): void {
  const trayIcon = nativeImage.createFromPath(
    join(
      projectRoot,
      "src/electron/assets",
      isMac ? "tray-iconTemplate.png" : "tray-icon.png"
    )
  );

  tray = new Tray(trayIcon.resize({ width: 18, height: 18 }));
  tray.setToolTip("Codex Attention Desk");
  tray.on("double-click", () => {
    toggleWindowVisibility();
  });

  updateTrayMenu(latestSnapshot);
}

function updateTrayMenu(snapshot: DesktopPetSnapshot): void {
  if (!tray) {
    return;
  }

  const sizeMenu: Electron.MenuItemConstructorOptions[] = (["S", "M", "L"] as SizeKey[]).map(
    (size) => ({
      label: `大小 ${size}`,
      type: "radio",
      checked: currentSize === size,
      click: () => {
        setWindowSize(size);
      }
    })
  );

  const debugStates: DeskPetState[] = [
    "idle",
    "thinking",
    "typing",
    "working",
    "editing",
    "approval",
    "success",
    "error",
    "sleeping"
  ];

  const debugMenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: "自动",
      type: "radio",
      checked: debugStateOverride === null,
      click: () => {
        debugStateOverride = null;
        refreshFromRuntime();
        updateTrayMenu(latestSnapshot);
      }
    },
    ...debugStates.map((state) => ({
      label: formatDeskState(state),
      type: "radio" as const,
      checked: debugStateOverride === state,
      click: () => {
        debugStateOverride = state;
        refreshFromRuntime();
        updateTrayMenu(latestSnapshot);
      }
    }))
  ];

  const externalUrls = snapshot.connection.listenUrls?.length
    ? snapshot.connection.listenUrls
    : configuredExternalUrls;
  const externalUrl = externalUrls[0];
  const appearanceMenu: Electron.MenuItemConstructorOptions[] = [
    ...ACCENT_PRESETS.map((preset) => ({
      label: preset.label,
      type: "radio" as const,
      checked: accentColor === preset.value || (!accentColor && typeof preset.value === "undefined"),
      click: () => {
        void setAccentColor(preset.value);
      }
    })),
    {
      label: "自定义色值...",
      click: () => {
        void promptForAccentColor();
      }
    }
  ];
  const connectionMenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: "自动发现当前 Codex",
      type: "radio",
      checked: snapshot.connection.mode === "auto",
      click: () => {
        void setConnectionMode("auto");
      }
    },
    {
      label: "自动托管",
      type: "radio",
      checked: snapshot.connection.mode === "managed",
      click: () => {
        void setConnectionMode("managed");
      }
    },
    {
      label:
        externalUrls.length > 0
          ? `外部连接（${externalUrls.length} 个地址）`
          : "外部连接（需设置 CODEX_APP_SERVER_URL 或 CODEX_APP_SERVER_URLS）",
      type: "radio",
      checked: snapshot.connection.mode === "external",
      enabled: externalUrls.length > 0,
      click: () => {
        if (!externalUrl) {
          return;
        }
        void setConnectionMode("external", externalUrl);
      }
    }
  ];
  const activeAttention = snapshot.attention;
  const attentionMenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: autoOpenAttention ? "自动弹出 Codex: 开" : "自动弹出 Codex: 关",
      type: "checkbox",
      checked: autoOpenAttention,
      click: () => {
        void setAutoOpenAttention(!autoOpenAttention);
      }
    },
    {
      label: "立即打开 Codex",
      click: () => {
        void openAttentionTarget(activeAttention);
      }
    },
    {
      label: `当前命令: ${truncateMenuLabel(getConfiguredAttentionCommand(activeAttention))}`,
      enabled: false
    },
    {
      label: "设置打开命令...",
      click: () => {
        void promptForAttentionCommand();
      }
    },
    {
      label: "测试提醒弹窗",
      click: () => {
        runtime.raiseManualAttention({
          kind: "manual",
          title: "Manual attention test",
          detail: "This is a local reminder hook test.",
          cwd: projectRoot
        });
      }
    },
    {
      label: "清除手动提醒",
      enabled: Boolean(snapshot.attention?.source === "hook"),
      click: () => {
        runtime.clearManualAttention();
      }
    }
  ];

  const menu = Menu.buildFromTemplate([
    {
      label: mainWindow?.isVisible() ? "隐藏桌宠" : "显示桌宠",
      click: () => {
        toggleWindowVisibility();
      }
    },
    {
      label: "在浏览器中打开状态看板",
      click: () => {
        void openDashboardInBrowser();
      }
    },
    {
      label: "显示状态对话框",
      type: "checkbox",
      checked: bubbleVisible,
      click: () => {
        setBubbleVisible(!bubbleVisible);
      }
    },
    {
      label: "对话框信息",
      submenu: [
        {
          label: "简略",
          type: "radio",
          checked: bubbleDetailMode === "basic",
          click: () => {
            setBubbleDetailMode("basic");
          }
        },
        {
          label: "详细",
          type: "radio",
          checked: bubbleDetailMode === "detailed",
          click: () => {
            setBubbleDetailMode("detailed");
          }
        }
      ]
    },
    {
      label: "对话框距离",
      submenu: [
        {
          label: `当前 ${bubbleSpacingPx}px`,
          enabled: false
        },
        {
          label: "减少 10px",
          click: () => {
            setBubbleSpacing(bubbleSpacingPx - 10);
          }
        },
        {
          label: "增加 10px",
          click: () => {
            setBubbleSpacing(bubbleSpacingPx + 10);
          }
        },
        {
          label: "重置",
          enabled: bubbleSpacingPx !== DEFAULT_BUBBLE_SPACING_PX,
          click: () => {
            setBubbleSpacing(DEFAULT_BUBBLE_SPACING_PX);
          }
        },
        {
          label: "自定义输入...",
          click: () => {
            void promptForBubbleSpacing();
          }
        }
      ]
    },
    {
      label: "大小",
      submenu: sizeMenu
    },
    {
      label: "主题颜色",
      submenu: appearanceMenu
    },
    {
      label: "调试状态",
      submenu: debugMenu
    },
    {
      label: "连接模式",
      submenu: connectionMenu
    },
    {
      label: "提醒与弹出",
      submenu: attentionMenu
    },
    {
      label: "运行测试 Prompt",
      enabled: snapshot.connection.mode === "managed",
      click: () => {
        void runtime.runPrompt("只回复 OK。");
      }
    },
    { type: "separator" },
    {
      label: `状态: ${formatDeskState(snapshot.monitor.currentState)}`
    },
    {
      label:
        snapshot.connection.totalSources && snapshot.connection.totalSources > 1
          ? `连接: ${snapshot.connection.mode} / ${snapshot.connection.connectedSources ?? 0}/${snapshot.connection.totalSources} connected`
          : `连接: ${snapshot.connection.mode} / ${snapshot.connection.connected ? "connected" : "disconnected"}`
    },
    {
      label:
        snapshot.connection.mode === "auto"
          ? `发现源: ${snapshot.connection.connectedSources ?? 0}`
          : snapshot.connection.totalSources && snapshot.connection.totalSources > 1
          ? `地址: ${externalUrls.join(", ")}`
          : `地址: ${snapshot.connection.listenUrl ?? externalUrl ?? "managed auto"}`
    },
    {
      label:
        snapshot.runtimeStatus === "error"
          ? `连接错误: ${snapshot.errorMessage ?? snapshot.connection.errorMessage ?? "unknown"}`
          : `平台: ${snapshot.monitor.serverPlatform ?? "unknown"}`
    },
    {
      label: `Hook: ${dashboardPort ? `http://127.0.0.1:${dashboardPort}` : "starting"}`
    },
    {
      label: activeAttention
        ? `提醒: ${activeAttention.title}`
        : "提醒: none"
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        void shutdown();
      }
    }
  ]);

  tray.setContextMenu(menu);
}

function normalizeWindowPosition(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }

  return Math.round(value);
}

function getDisplayScaleFactor(display?: Electron.Display | null): number {
  if (display && Number.isFinite(display.scaleFactor) && display.scaleFactor > 0) {
    return display.scaleFactor;
  }

  return sizeReferenceScaleFactor;
}

function getWindowSize(size: SizeKey, display?: Electron.Display | null): { width: number; height: number } {
  const base = SIZES[size];
  const scaleFactor = getDisplayScaleFactor(display);
  const scale = sizeReferenceScaleFactor / scaleFactor;

  return {
    width: Math.max(1, Math.round(base.width * scale)),
    height: Math.max(1, Math.round((base.height + getBubbleExtraHeight()) * scale))
  };
}

function syncWindowSizeForCurrentDisplay(anchor: "bottom-center" | "top-left"): void {
  if (!mainWindow) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const display =
    miniMode && miniDock
      ? resolveMiniDockDisplay(miniDock, bounds)
      : screen.getDisplayMatching(bounds);
  const next = getWindowSize(currentSize, display);

  if (bounds.width === next.width && bounds.height === next.height) {
    return;
  }

  syncingWindowScale = true;
  try {
    if (anchor === "top-left") {
      mainWindow.setBounds({
        x: bounds.x,
        y: bounds.y,
        width: next.width,
        height: next.height
      });
      return;
    }

    mainWindow.setBounds({
      x: Math.round(bounds.x + bounds.width / 2 - next.width / 2),
      y: Math.round(bounds.y + bounds.height - next.height),
      width: next.width,
      height: next.height
    });
  } finally {
    syncingWindowScale = false;
  }
}

function registerIpc(): void {
  ipcMain.handle("codex:getSnapshot", () => latestSnapshot);
  ipcMain.handle("codex:getBubbleConfig", () => getBubbleConfig());
  ipcMain.handle("codex:getAppearanceConfig", () => getAppearanceConfig());
  ipcMain.handle("codex:setAccentColor", async (_event, nextColor?: string) => {
    await setAccentColor(nextColor);
  });
  ipcMain.handle("codex:setBubbleSpacing", async (_event, spacingPx: number) => {
    await setBubbleSpacing(spacingPx);
  });
  ipcMain.handle("codex:runPrompt", async (_event, prompt: string) => {
    return await runtime.runPrompt(prompt);
  });

  ipcMain.on("show-context-menu", () => {
    if (!mainWindow) {
      return;
    }
    tray?.popUpContextMenu();
  });

  ipcMain.on("move-window-by", (_event, dx: number, dy: number) => {
    if (!mainWindow) {
      return;
    }
    const [x, y] = mainWindow.getPosition();
    const nextX = normalizeWindowPosition(x + dx);
    const nextY = normalizeWindowPosition(y + dy);

    if (nextX === null || nextY === null) {
      return;
    }

    // Only update window position while dragging. Re-applying bounds can cause
    // transparent frameless windows to accumulate platform-specific size drift.
    mainWindow.setPosition(nextX, nextY);
    syncWindowSizeForCurrentDisplay("top-left");
  });

  ipcMain.on("drag-lock", (_event, locked: boolean) => {
    dragLocked = locked;
    if (!mainWindow) {
      return;
    }

    if (locked) {
      if (miniMode) {
        releaseMiniModeForDrag();
      }
      mainWindow.setIgnoreMouseEvents(false);
    }
  });

  ipcMain.on("drag-end", () => {
    if (!mainWindow || miniMode) {
      return;
    }

    const bounds = mainWindow.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const leftEdge = display.workArea.x;
    const rightEdge = display.workArea.x + display.workArea.width;
    const dockSide =
      bounds.x <= leftEdge + SNAP_TOLERANCE
        ? "left"
        : bounds.x + bounds.width >= rightEdge - SNAP_TOLERANCE
        ? "right"
        : null;

    if (dockSide) {
      enterMiniMode({
        displayId: display.id,
        side: dockSide
      });
    }
  });

  ipcMain.on("pause-cursor-polling", () => {
    cursorPollingPaused = true;
  });

  ipcMain.on("resume-from-reaction", () => {
    cursorPollingPaused = false;
    forceEyeResend = true;
    sendCurrentPresentation();
  });
}

function refreshFromRuntime(): void {
  const effectiveSnapshot = getEffectiveSnapshot(latestSnapshot);

  if (effectiveSnapshot.runtimeStatus !== "ready") {
    clearIdleSequence();
    applyPresentation({ state: "disconnected", svg: "clawd-disconnected.svg" });
    return;
  }

  if (miniMode) {
    clearIdleSequence();
    applyPresentation(mapSnapshotToMiniPresentation(effectiveSnapshot));
    return;
  }

  const presentation = mapSnapshotToPresentation(effectiveSnapshot);
  if (presentation.state !== "idle") {
    clearIdleSequence();
    applyPresentation(presentation);
    return;
  }

  if (!isIdleFamilyState(currentPresentation.state)) {
    resetIdleTracking();
    applyPresentation({ state: "idle", svg: SVG_IDLE_FOLLOW });
  }
}

function mapSnapshotToPresentation(snapshot: DesktopPetSnapshot): PetPresentation {
  const state = snapshot.monitor.currentState;
  const busyThreadCount = snapshot.monitor.threads.filter((thread) =>
    ["thinking", "typing", "working", "editing", "subagent_one", "subagent_many"].includes(
      thread.displayState
    )
  ).length;

  switch (state) {
    case "thinking":
      return {
        state: "thinking",
        svg: busyThreadCount >= 3 ? "clawd-working-ultrathink.svg" : "clawd-working-thinking.svg"
      };
    case "typing":
      return { state: "working", svg: "clawd-working-typing.svg" };
    case "working":
      return {
        state: "working",
        svg: busyThreadCount >= 2 ? "clawd-working-building.svg" : "clawd-working-typing.svg"
      };
    case "editing":
      return { state: "carrying", svg: "clawd-working-carrying.svg" };
    case "subagent_one":
      return { state: "juggling", svg: "clawd-working-juggling.svg" };
    case "subagent_many":
      return { state: "juggling", svg: "clawd-working-conducting.svg" };
    case "approval":
      return { state: "notification", svg: "clawd-notification.svg" };
    case "error":
      return { state: "error", svg: "clawd-error.svg" };
    case "success":
      return { state: "attention", svg: "clawd-happy.svg" };
    case "sleeping":
      return { state: "sleeping", svg: "clawd-sleeping.svg" };
    case "idle":
    default:
      return { state: "idle", svg: SVG_IDLE_FOLLOW };
  }
}

function getEffectiveSnapshot(snapshot: DesktopPetSnapshot): DesktopPetSnapshot {
  if (debugStateOverride === null) {
    return snapshot;
  }

  return {
    ...snapshot,
    monitor: {
      ...snapshot.monitor,
      currentState: debugStateOverride
    }
  };
}

function mapSnapshotToMiniPresentation(snapshot: DesktopPetSnapshot): PetPresentation {
  const state = snapshot.monitor.currentState;

  if (snapshot.runtimeStatus !== "ready") {
    return { state: "disconnected", svg: "clawd-disconnected.svg" };
  }

  if (state === "approval" || state === "error") {
    return { state: "mini-alert", svg: "clawd-mini-alert.svg" };
  }

  if (state === "success") {
    return { state: "mini-happy", svg: "clawd-mini-happy.svg" };
  }

  if (state === "sleeping") {
    return { state: "mini-sleep", svg: "clawd-mini-sleep.svg" };
  }

  if (mouseOverPet || miniPeeked) {
    return { state: "mini-peek", svg: "clawd-mini-peek.svg" };
  }

  return { state: "mini-idle", svg: "clawd-mini-idle.svg" };
}

function handleAttentionChange(snapshot: DesktopPetSnapshot): void {
  const attention = snapshot.attention;

  if (!attention) {
    lastHandledAttentionId = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.flashFrame(false);
    }
    return;
  }

  if (attention.id === lastHandledAttentionId) {
    return;
  }

  lastHandledAttentionId = attention.id;
  revealAttentionWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.flashFrame(true);
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.flashFrame(false);
      }
    }, 4_000);
  }

  if (autoOpenAttention) {
    void openAttentionTarget(attention);
  }
}

function revealAttentionWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (miniMode) {
    exitMiniMode();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

function applyPresentation(next: PetPresentation): void {
  if (next.state === currentPresentation.state && next.svg === currentPresentation.svg) {
    return;
  }

  currentPresentation = next;
  currentHitBox = getHitBoxForSvg(next.svg);

  if (next.state !== "idle") {
    sendToRenderer("eye-move", 0, 0);
  }

  if (next.state === "dozing" || next.state === "sleeping") {
    startWakePoll();
  } else {
    stopWakePoll();
  }

  sendCurrentPresentation();
}

function sendCurrentPresentation(): void {
  sendToRenderer(
    "state-change",
    currentPresentation.state,
    currentPresentation.svg,
    buildBubbleRenderMeta(getEffectiveSnapshot(latestSnapshot))
  );
  sendToRenderer("size-change", currentSize);
  sendToRenderer("bubble-config-change", getBubbleConfig());
  sendToRenderer("appearance-config-change", getAppearanceConfig());
}

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  mainWindow.webContents.send(channel, ...args);
}

function setBubbleVisible(visible: boolean): void {
  bubbleVisible = visible;
  updateWindowLayout();
  updateTrayMenu(latestSnapshot);
  sendToRenderer("bubble-config-change", getBubbleConfig());
  void persistSettings();
}

function setBubbleDetailMode(detailMode: BubbleDetailMode): void {
  bubbleDetailMode = detailMode;
  updateWindowLayout();
  updateTrayMenu(latestSnapshot);
  sendToRenderer("state-change", currentPresentation.state, currentPresentation.svg, buildBubbleRenderMeta(getEffectiveSnapshot(latestSnapshot)));
  sendToRenderer("bubble-config-change", getBubbleConfig());
  void persistSettings();
}

async function setBubbleSpacing(nextSpacingPx: number): Promise<void> {
  bubbleSpacingPx = normalizeBubbleSpacing(nextSpacingPx);
  updateWindowLayout();
  updateTrayMenu(latestSnapshot);
  sendToRenderer("bubble-config-change", getBubbleConfig());
  await persistSettings();
}

function getBubbleConfig(): BubbleConfig {
  return {
    visible: bubbleVisible,
    detailMode: bubbleDetailMode,
    spacingPx: bubbleSpacingPx
  };
}

function getAppearanceConfig(): AppearanceConfig {
  return {
    accentColor
  };
}

function buildBubbleRenderMeta(snapshot: DesktopPetSnapshot): BubbleRenderMeta {
  if (snapshot.attention) {
    return {
      badgeOverride: snapshot.attention.kind === "plan_ready" ? "Plan" : "Alert",
      titleOverride: snapshot.attention.title,
      detailOverride:
        bubbleDetailMode === "detailed"
          ? [snapshot.attention.detail, snapshot.attention.sourceLabel && `source ${formatBubbleSource(snapshot.attention.sourceLabel)}`]
              .filter((value): value is string => Boolean(value))
              .join(" | ")
          : snapshot.attention.detail
    };
  }

  if (bubbleDetailMode !== "detailed") {
    return {};
  }

  const [thread] = snapshot.monitor.threads;
  if (!thread) {
    return {};
  }

  const detailParts = [
    thread.sourceLabel ? `Source ${formatBubbleSource(thread.sourceLabel)}` : undefined,
    `Thread ${formatShortId(thread.threadId)}`,
    `Event ${formatEventLabel(thread.lastEventKind)}`
  ].filter((value): value is string => Boolean(value));

  return {
    detailOverride: detailParts.join(" | ")
  };
}

function startMainTick(): void {
  if (mainTickTimer) {
    return;
  }

  if (mainWindow) {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }

  mainTickTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    const cursor = screen.getCursorScreenPoint();
    const bounds = mainWindow.getBounds();

    if (!dragLocked) {
      const petHit = getHitRectScreen(bounds);
      const bubbleHit = getBubbleHitRectScreen(bounds);
      const overPet = isPointInsideRect(cursor, petHit);
      const overBubble = bubbleHit ? isPointInsideRect(cursor, bubbleHit) : false;
      const overInteractive = overPet || overBubble;

      if (overPet !== mouseOverPet) {
        mouseOverPet = overPet;
      }

      if (overBubble !== mouseOverBubble) {
        mouseOverBubble = overBubble;
      }

      if (overInteractive !== mouseOverInteractive) {
        mouseOverInteractive = overInteractive;
        mainWindow.setIgnoreMouseEvents(!overInteractive, { forward: true });
      }
    }

    if (cursorPollingPaused) {
      return;
    }

    if (miniMode) {
      const miniBase = mapSnapshotToMiniPresentation(latestSnapshot);

      if (miniBase.state === "mini-idle" || miniBase.state === "mini-peek") {
        if (mouseOverPet && !miniPeeked) {
          miniPeeked = true;
          setMiniBounds(true);
          applyPresentation({ state: "mini-peek", svg: "clawd-mini-peek.svg" });
        } else if (!mouseOverPet && miniPeeked) {
          miniPeeked = false;
          setMiniBounds(false);
          applyPresentation({ state: "mini-idle", svg: "clawd-mini-idle.svg" });
        }
      } else {
        applyPresentation(miniBase);
      }

      if (
        currentPresentation.svg !== "clawd-mini-idle.svg" &&
        currentPresentation.svg !== "clawd-mini-peek.svg"
      ) {
        return;
      }
    }

    const base = miniMode
      ? mapSnapshotToMiniPresentation(latestSnapshot)
      : mapSnapshotToPresentation(latestSnapshot);
    if (base.state !== "idle") {
      if (!miniMode) {
        return;
      }
    }

    if (miniMode) {
      if (currentPresentation.svg !== "clawd-mini-idle.svg" && currentPresentation.svg !== "clawd-mini-peek.svg") {
        return;
      }
    }

    const moved = lastCursorX !== null && (cursor.x !== lastCursorX || cursor.y !== lastCursorY);
    lastCursorX = cursor.x;
    lastCursorY = cursor.y;

    if (isSleepSequenceState(currentPresentation.state)) {
      return;
    }

    if (moved) {
      mouseStillSince = Date.now();
      idleLookPlayed = false;
      clearIdleLookTimer();
      if (currentPresentation.state === "idle" && currentPresentation.svg !== SVG_IDLE_FOLLOW) {
        applyPresentation({ state: "idle", svg: SVG_IDLE_FOLLOW });
        forceEyeResend = true;
      }
    }

    const elapsed = Date.now() - mouseStillSince;

    if (!miniMode && elapsed >= MOUSE_SLEEP_TIMEOUT && currentPresentation.state === "idle") {
      clearIdleLookTimer();
      if (!yawnTimer) {
        applyPresentation({ state: "yawning", svg: "clawd-idle-yawn.svg" });
        yawnTimer = setTimeout(() => {
          yawnTimer = null;
          if (mapSnapshotToPresentation(latestSnapshot).state === "idle") {
            applyPresentation({ state: "dozing", svg: "clawd-idle-doze.svg" });
          }
        }, YAWN_DURATION);
      }
      return;
    }

    if (
      !idleLookPlayed &&
      !miniMode &&
      elapsed >= MOUSE_IDLE_TIMEOUT &&
      currentPresentation.state === "idle" &&
      currentPresentation.svg === SVG_IDLE_FOLLOW
    ) {
      idleLookPlayed = true;
      applyPresentation({ state: "idle", svg: SVG_IDLE_LOOK });
      idleLookTimer = setTimeout(() => {
        idleLookTimer = null;
        if (mapSnapshotToPresentation(latestSnapshot).state === "idle") {
          applyPresentation({ state: "idle", svg: SVG_IDLE_FOLLOW });
          forceEyeResend = true;
        }
      }, IDLE_LOOK_DURATION);
      return;
    }

    if (
      currentPresentation.svg !== SVG_IDLE_FOLLOW &&
      currentPresentation.svg !== "clawd-mini-idle.svg" &&
      currentPresentation.svg !== "clawd-mini-peek.svg"
    ) {
      return;
    }

    if (!moved && !forceEyeResend) {
      return;
    }

    const obj = getObjRect(bounds);
    const eyeScreenX = obj.x + obj.w * (22 / 45);
    const eyeScreenY = obj.y + obj.h * (34 / 45);
    const relX = cursor.x - eyeScreenX;
    const relY = cursor.y - eyeScreenY;

    const maxOffset = 3;
    const dist = Math.sqrt(relX * relX + relY * relY);
    let eyeDx = 0;
    let eyeDy = 0;

    if (dist > 1) {
      const scale = Math.min(1, dist / 300);
      eyeDx = (relX / dist) * maxOffset * scale;
      eyeDy = (relY / dist) * maxOffset * scale;
    }

    eyeDx = Math.round(eyeDx * 2) / 2;
    eyeDy = Math.round(eyeDy * 2) / 2;
    eyeDy = Math.max(-1.5, Math.min(1.5, eyeDy));

    if (forceEyeResend || eyeDx !== lastEyeDx || eyeDy !== lastEyeDy) {
      forceEyeResend = false;
      lastEyeDx = eyeDx;
      lastEyeDy = eyeDy;
      sendToRenderer("eye-move", eyeDx, eyeDy);
    }
  }, 50);
}

function stopMainTick(): void {
  if (mainTickTimer) {
    clearInterval(mainTickTimer);
    mainTickTimer = null;
  }
  stopWakePoll();
  clearIdleSequence();
}

function startWakePoll(): void {
  if (wakePollTimer) {
    return;
  }

  const cursor = screen.getCursorScreenPoint();
  let lastWakeCursorX = cursor.x;
  let lastWakeCursorY = cursor.y;

  wakePollTimer = setInterval(() => {
    const point = screen.getCursorScreenPoint();
    const moved = point.x !== lastWakeCursorX || point.y !== lastWakeCursorY;
    lastWakeCursorX = point.x;
    lastWakeCursorY = point.y;

    if (!moved) {
      return;
    }

    stopWakePoll();
    wakeFromDoze();
  }, 200);
}

function stopWakePoll(): void {
  if (wakePollTimer) {
    clearInterval(wakePollTimer);
    wakePollTimer = null;
  }
}

function wakeFromDoze(): void {
  if (currentPresentation.state !== "dozing" && currentPresentation.state !== "sleeping") {
    return;
  }

  const fromState = currentPresentation.state;

  if (fromState === "dozing") {
    sendToRenderer("wake-from-doze");
  } else {
    applyPresentation({ state: "waking", svg: "clawd-wake.svg" });
  }

  if (wakeTimer) {
    clearTimeout(wakeTimer);
  }

  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    mouseStillSince = Date.now();
    idleLookPlayed = false;
    forceEyeResend = true;
    refreshFromRuntime();
  }, fromState === "sleeping" ? WAKE_DURATION : 350);
}

function clearIdleSequence(): void {
  clearIdleLookTimer();
  if (yawnTimer) {
    clearTimeout(yawnTimer);
    yawnTimer = null;
  }
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  stopWakePoll();
  resetIdleTracking();
}

function clearIdleLookTimer(): void {
  if (idleLookTimer) {
    clearTimeout(idleLookTimer);
    idleLookTimer = null;
  }
}

function resetIdleTracking(): void {
  mouseStillSince = Date.now();
  isMouseIdle = false;
  idleLookPlayed = false;
  lastCursorX = null;
  lastCursorY = null;
  lastEyeDx = 0;
  lastEyeDy = 0;
}

function isSleepSequenceState(state: PetState): boolean {
  return state === "yawning" || state === "dozing" || state === "sleeping" || state === "waking";
}

function isIdleFamilyState(state: PetState): boolean {
  return state === "idle" || isSleepSequenceState(state);
}

function toggleWindowVisibility(): void {
  if (!mainWindow) {
    return;
  }

  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

async function openDashboardInBrowser(): Promise<void> {
  const url = await ensureDashboardServer();
  if (!url) {
    return;
  }

  try {
    await shell.openExternal(url);
  } catch (error) {
    const options = {
      type: "error",
      message: "无法在默认浏览器中打开状态看板",
      detail: error instanceof Error ? error.message : String(error)
    } as const;
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }
}

async function ensureDashboardServer(): Promise<string | null> {
  if (dashboardPort !== null) {
    return `http://127.0.0.1:${dashboardPort}`;
  }

  if (!dashboardServer) {
    dashboardServer = new DashboardServer({
      staticRoot: projectRoot,
      runtime,
      port: Number.isInteger(configuredDashboardPort) && configuredDashboardPort > 0 ? configuredDashboardPort : 4580,
      onAttentionHook: async ({ title, detail, open }) => {
        runtime.raiseManualAttention({
          kind: "manual",
          title,
          detail,
          cwd: latestSnapshot?.attention?.cwd ?? latestSnapshot?.monitor.threads.find((thread) => thread.cwd)?.cwd ?? projectRoot
        });
        if (open) {
          await openAttentionTarget(latestSnapshot?.attention);
        }
      },
      onClearAttention: async () => {
        runtime.clearManualAttention();
      },
      onOpenTarget: async () => {
        await openAttentionTarget(latestSnapshot?.attention);
      }
    });
  }

  try {
    const started = await dashboardServer.start();
    dashboardPort = started.port;
    return `http://127.0.0.1:${dashboardPort}`;
  } catch (error) {
    if (
      dashboardServer &&
      error instanceof Error &&
      /EADDRINUSE/i.test(error.message) &&
      configuredDashboardPort !== 0
    ) {
      dashboardServer = new DashboardServer({
        staticRoot: projectRoot,
        runtime,
        port: 0,
        onAttentionHook: async ({ title, detail, open }) => {
          runtime.raiseManualAttention({
            kind: "manual",
            title,
            detail,
            cwd: latestSnapshot?.attention?.cwd ?? latestSnapshot?.monitor.threads.find((thread) => thread.cwd)?.cwd ?? projectRoot
          });
          if (open) {
            await openAttentionTarget(latestSnapshot?.attention);
          }
        },
        onClearAttention: async () => {
          runtime.clearManualAttention();
        },
        onOpenTarget: async () => {
          await openAttentionTarget(latestSnapshot?.attention);
        }
      });

      try {
        const started = await dashboardServer.start();
        dashboardPort = started.port;
        return `http://127.0.0.1:${dashboardPort}`;
      } catch (fallbackError) {
        error = fallbackError;
      }
    }

    dashboardServer = null;
    dashboardPort = null;
    const options = {
      type: "error",
      message: "状态看板启动失败",
      detail: error instanceof Error ? error.message : String(error)
    } as const;
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
    return null;
  }
}

function enterMiniMode(nextDock?: MiniDockState): void {
  if (!mainWindow || miniMode) {
    return;
  }

  miniMode = true;
  miniPeeked = false;
  preMiniBounds = mainWindow.getBounds();
  miniDock = nextDock ?? getMiniDockForBounds(preMiniBounds);
  setMiniBounds(false);
  refreshFromRuntime();
}

function exitMiniMode(): void {
  if (!mainWindow || !miniMode) {
    return;
  }

  miniMode = false;
  miniPeeked = false;
  miniDock = null;

  if (preMiniBounds) {
    mainWindow.setBounds(preMiniBounds);
  }

  refreshFromRuntime();
}

function releaseMiniModeForDrag(): void {
  if (!mainWindow || !miniMode) {
    return;
  }

  miniMode = false;
  miniPeeked = false;
  miniDock = null;
  preMiniBounds = null;
  refreshFromRuntime();
}

function setMiniBounds(peek: boolean): void {
  if (!mainWindow) {
    return;
  }

  const bounds = mainWindow.getBounds();
  const dock = miniDock ?? getMiniDockForBounds(preMiniBounds ?? bounds);
  const display = resolveMiniDockDisplay(dock, bounds);
  const hiddenX =
    dock.side === "left"
      ? display.workArea.x - Math.round(bounds.width * (1 - MINI_OFFSET_RATIO))
      : display.workArea.x +
        display.workArea.width -
        Math.round(bounds.width * MINI_OFFSET_RATIO);
  const peekX = dock.side === "left" ? hiddenX + PEEK_OFFSET : hiddenX - PEEK_OFFSET;

  miniDock = {
    displayId: display.id,
    side: dock.side
  };

  mainWindow.setBounds({
    ...bounds,
    x: peek ? peekX : hiddenX,
    y: bounds.y
  });
}

function getMiniDockForBounds(bounds: Electron.Rectangle): MiniDockState {
  const display = screen.getDisplayMatching(bounds);
  const leftDistance = Math.abs(bounds.x - display.workArea.x);
  const rightDistance = Math.abs(
    display.workArea.x + display.workArea.width - (bounds.x + bounds.width)
  );

  return {
    displayId: display.id,
    side: leftDistance <= rightDistance ? "left" : "right"
  };
}

function resolveMiniDockDisplay(
  dock: MiniDockState,
  fallbackBounds: Electron.Rectangle
): Electron.Display {
  const match = screen.getAllDisplays().find((display) => display.id === dock.displayId);
  return match ?? screen.getDisplayMatching(fallbackBounds);
}

function setWindowSize(size: SizeKey): void {
  if (!mainWindow) {
    currentSize = size;
    void persistSettings();
    return;
  }

  const currentBounds = mainWindow.getBounds();
  const display =
    miniMode && miniDock
      ? resolveMiniDockDisplay(miniDock, currentBounds)
      : screen.getDisplayMatching(currentBounds);
  const next = getWindowSize(size, display);
  currentSize = size;

  const x = Math.round(currentBounds.x + currentBounds.width / 2 - next.width / 2);
  const y = Math.round(currentBounds.y + currentBounds.height / 2 - next.height / 2);

  mainWindow.setBounds({
    x,
    y,
    width: next.width,
    height: next.height
  });

  if (miniMode) {
    setMiniBounds(miniPeeked);
  }

  void persistSettings();
}

function updateWindowLayout(): void {
  if (!mainWindow) {
    return;
  }

  const currentBounds = mainWindow.getBounds();
  const display =
    miniMode && miniDock
      ? resolveMiniDockDisplay(miniDock, currentBounds)
      : screen.getDisplayMatching(currentBounds);
  const next = getWindowSize(currentSize, display);
  const x = Math.round(currentBounds.x + currentBounds.width / 2 - next.width / 2);
  const y = Math.round(currentBounds.y + currentBounds.height - next.height);

  mainWindow.setBounds({
    x,
    y,
    width: next.width,
    height: next.height
  });

  if (miniMode) {
    setMiniBounds(miniPeeked);
  }
}

function getBubbleExtraHeight(): number {
  if (!bubbleVisible) {
    return 0;
  }

  return Math.max(0, BUBBLE_EXTRA_HEIGHT[bubbleDetailMode] + bubbleSpacingPx);
}

function applyPersistedSettings(settings: PersistedSettings): void {
  currentSize = settings.size;
  bubbleVisible = settings.bubbleVisible;
  bubbleDetailMode = settings.bubbleDetailMode;
  bubbleSpacingPx = normalizeBubbleSpacing(
    settings.bubbleSpacingPx + BUBBLE_SPACING_BASELINE_SHIFT_PX
  );
  autoOpenAttention = settings.autoOpenAttention;
  attentionCommand = settings.attentionCommand;
  accentColor = settings.accentColor;
}

function getInitialRuntimeConfig(settings: PersistedSettings) {
  if (settings.connectionMode === "managed") {
    return { mode: "managed" as const, cwd: projectRoot };
  }

  if (settings.connectionMode === "external" && configuredExternalUrls.length > 0) {
    return { mode: "external" as const, listenUrl: configuredExternalUrls[0] };
  }

  if (process.env.CODEX_DISABLE_AUTO_DISCOVERY === "1") {
    return { mode: "managed" as const, cwd: projectRoot };
  }

  return { mode: "auto" as const };
}

async function setConnectionMode(mode: "auto" | "managed" | "external", listenUrl?: string): Promise<void> {
  if (mode === "auto") {
    await runtime.setAutoMode();
  } else if (mode === "managed") {
    await runtime.setManagedMode();
  } else {
    if (!listenUrl) {
      return;
    }
    await runtime.setExternalMode(listenUrl);
  }

  void persistSettings();
}

async function persistSettings(): Promise<void> {
  if (!settingsStore) {
    return;
  }

  await settingsStore.save({
    size: currentSize,
    bubbleVisible,
    bubbleDetailMode,
    bubbleSpacingPx,
    connectionMode: latestSnapshot?.connection.mode ?? "auto",
    autoOpenAttention,
    attentionCommand,
    accentColor
  });
}

async function setAccentColor(nextColor?: string): Promise<void> {
  const normalized = normalizeAccentColor(nextColor);
  accentColor = normalized;
  updateTrayMenu(latestSnapshot);
  sendToRenderer("appearance-config-change", getAppearanceConfig());
  await persistSettings();
}

async function setAutoOpenAttention(value: boolean): Promise<void> {
  autoOpenAttention = value;
  updateTrayMenu(latestSnapshot);
  await persistSettings();
}

function getConfiguredAttentionCommand(attention?: AttentionSnapshot | null): string {
  const configured = attentionCommand ?? process.env.CODEX_ATTENTION_OPEN_COMMAND?.trim();
  if (configured) {
    return configured;
  }

  const targetCwd =
    attention?.cwd ??
    latestSnapshot?.attention?.cwd ??
    latestSnapshot?.monitor.threads.find((thread) => thread.cwd)?.cwd ??
    projectRoot;

  return buildDefaultAttentionCommand(targetCwd);
}

function buildDefaultAttentionCommand(targetCwd: string): string {
  const quotedCwd = `"${targetCwd}"`;

  if (process.platform === "darwin") {
    return `open -a "Visual Studio Code" ${quotedCwd}`;
  }

  return `code -r ${quotedCwd}`;
}

async function openAttentionTarget(attention?: AttentionSnapshot | null): Promise<void> {
  const command = getConfiguredAttentionCommand(attention);

  try {
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.unref();
  } catch (error) {
    const options = {
      type: "error",
      message: "Unable to open Codex target",
      detail: error instanceof Error ? error.message : String(error)
    } as const;
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }
}

function truncateMenuLabel(value: string, maxLength = 48): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function formatBubbleSource(sourceLabel: string): string {
  const bracketIndex = sourceLabel.indexOf(" (");
  const compact = bracketIndex > 0 ? sourceLabel.slice(0, bracketIndex) : sourceLabel;
  return compact.length <= 18 ? compact : `${compact.slice(0, 15)}...`;
}

function formatShortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`;
}

function formatEventLabel(eventKind: string): string {
  switch (eventKind) {
    case "assistant.message":
      return "回复";
    case "user.message":
      return "用户消息";
    case "item.agentMessage.delta":
      return "回复";
    case "item.reasoning.delta":
      return "思考";
    case "item.started":
      return "工具开始";
    case "item.completed":
      return "工具完成";
    case "turn.started":
      return "开始";
    case "turn.completed":
      return "结束";
    case "thread.status.changed":
      return "状态变化";
    case "tool.request_user_input":
      return "请求输入";
    default:
      return eventKind.replace(/^notification\./, "").replaceAll(".", " ");
  }
}

function normalizeAccentColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return /^#([\da-f]{3}|[\da-f]{6})$/.test(normalized) ? normalized : undefined;
}

function normalizeBubbleSpacing(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_BUBBLE_SPACING_PX;
  }

  return Math.max(MIN_BUBBLE_SPACING_PX, Math.min(MAX_BUBBLE_SPACING_PX, Math.round(value)));
}

async function promptForBubbleSpacing(): Promise<void> {
  const value = await showTextInputDialog({
    title: "设置对话框距离",
    message: `输入像素值，范围 ${MIN_BUBBLE_SPACING_PX} 到 ${MAX_BUBBLE_SPACING_PX}。负数会更靠近机器人。`,
    defaultValue: `${bubbleSpacingPx}`
  });

  if (value === null) {
    return;
  }

  const nextSpacingPx = Number(value.trim());
  if (!Number.isFinite(nextSpacingPx)) {
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "请输入有效数字。"
      });
    }
    return;
  }

  await setBubbleSpacing(nextSpacingPx);
}

async function promptForAttentionCommand(): Promise<void> {
  const value = await showTextInputDialog({
    title: "Set Codex open command",
    message:
      "Run this command when attention needs to pop Codex. Leave blank to use the default workspace opener.",
    defaultValue: attentionCommand ?? ""
  });

  if (value === null) {
    return;
  }

  attentionCommand = value.trim() || undefined;
  updateTrayMenu(latestSnapshot);
  await persistSettings();
}

async function promptForAccentColor(): Promise<void> {
  const value = await showTextInputDialog({
    title: "设置主题颜色",
    message: "输入十六进制颜色值，例如 #7284ff。留空可恢复默认颜色。",
    defaultValue: accentColor ?? ""
  });

  if (value === null) {
    return;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    await setAccentColor(undefined);
    return;
  }

  const normalized = normalizeAccentColor(trimmed);
  if (!normalized) {
    if (mainWindow) {
      await dialog.showMessageBox(mainWindow, {
        type: "warning",
        message: "颜色格式无效，请输入 #rgb 或 #rrggbb。"
      });
    }
    return;
  }

  await setAccentColor(normalized);
}

async function showTextInputDialog(options: {
  title: string;
  message: string;
  defaultValue: string;
}): Promise<string | null> {
  if (!mainWindow) {
    return null;
  }

  const promptWindow = new BrowserWindow({
    width: 380,
    height: 190,
    parent: mainWindow,
    modal: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    title: options.title,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false
    }
  });

  const submitChannel = `bubble-spacing-submit-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cancelChannel = `${submitChannel}-cancel`;

  return await new Promise<string | null>((resolve) => {
    let settled = false;

    const finish = (result: string | null) => {
      if (settled) {
        return;
      }
      settled = true;
      ipcMain.removeAllListeners(submitChannel);
      ipcMain.removeAllListeners(cancelChannel);
      if (!promptWindow.isDestroyed()) {
        promptWindow.close();
      }
      resolve(result);
    };

    ipcMain.once(submitChannel, (_event, value: string) => {
      finish(value);
    });
    ipcMain.once(cancelChannel, () => {
      finish(null);
    });

    promptWindow.on("closed", () => {
      finish(null);
    });

    const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      body {
        margin: 0;
        padding: 20px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f8f6ee;
        color: #2a241d;
      }
      .wrap {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .message {
        font-size: 13px;
        line-height: 1.5;
        color: #62584d;
      }
      input {
        height: 40px;
        padding: 0 12px;
        border: 1px solid #d6cebf;
        border-radius: 12px;
        background: #fffdf8;
        font-size: 16px;
      }
      .actions {
        display: flex;
        justify-content: flex-end;
        gap: 10px;
      }
      button {
        min-width: 88px;
        height: 36px;
        border: 0;
        border-radius: 10px;
        cursor: pointer;
        font-size: 14px;
      }
      .cancel {
        background: #e8e1d3;
        color: #4d4439;
      }
      .ok {
        background: #6c7cff;
        color: white;
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="message">${escapeHtml(options.message)}</div>
      <input id="value" value=${JSON.stringify(options.defaultValue)} />
      <div class="actions">
        <button class="cancel" id="cancel">取消</button>
        <button class="ok" id="ok">确定</button>
      </div>
    </div>
    <script>
      const { ipcRenderer } = require("electron");
      const input = document.getElementById("value");
      const submit = () => ipcRenderer.send(${JSON.stringify(submitChannel)}, input.value);
      const cancel = () => ipcRenderer.send(${JSON.stringify(cancelChannel)});
      document.getElementById("ok").addEventListener("click", submit);
      document.getElementById("cancel").addEventListener("click", cancel);
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") submit();
        if (event.key === "Escape") cancel();
      });
      window.addEventListener("DOMContentLoaded", () => {
        input.focus();
        input.select();
      });
    </script>
  </body>
</html>`;

    void promptWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    promptWindow.once("ready-to-show", () => {
      promptWindow.show();
      promptWindow.focus();
    });
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getObjRect(bounds: Electron.Rectangle): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return {
    x: bounds.x + bounds.width * OBJ_OFF_X,
    y: bounds.y + bounds.height * OBJ_OFF_Y,
    w: bounds.width * OBJ_SCALE_W,
    h: bounds.height * OBJ_SCALE_H
  };
}

function getHitRectScreen(bounds: Electron.Rectangle): {
  left: number;
  top: number;
  right: number;
  bottom: number;
} {
  const obj = getObjRect(bounds);
  const scale = Math.min(obj.w, obj.h) / 45;
  const offsetX = obj.x + (obj.w - 45 * scale) / 2;
  const offsetY = obj.y + (obj.h - 45 * scale) / 2;

  return {
    left: offsetX + (currentHitBox.x + 15) * scale,
    top: offsetY + (currentHitBox.y + 25) * scale,
    right: offsetX + (currentHitBox.x + 15 + currentHitBox.w) * scale,
    bottom: offsetY + (currentHitBox.y + 25 + currentHitBox.h) * scale
  };
}

function getBubbleHitRectScreen(
  bounds: Electron.Rectangle
): { left: number; top: number; right: number; bottom: number } | null {
  if (!bubbleVisible) {
    return null;
  }

  const width = Math.min(208, Math.max(0, bounds.width - 24));
  if (width <= 0) {
    return null;
  }

  const left = Math.round(bounds.x + bounds.width / 2 - width / 2);
  const top = bounds.y + 8;
  const height = bubbleDetailMode === "detailed" ? 88 : 72;

  return {
    left,
    top,
    right: left + width,
    bottom: top + height
  };
}

function isPointInsideRect(
  point: { x: number; y: number },
  rect: { left: number; top: number; right: number; bottom: number }
): boolean {
  return (
    point.x >= rect.left &&
    point.x <= rect.right &&
    point.y >= rect.top &&
    point.y <= rect.bottom
  );
}

function getHitBoxForSvg(svg: string): HitBox {
  if (
    svg === "clawd-sleeping.svg" ||
    svg === "clawd-collapse-sleep.svg" ||
    svg === "clawd-idle-doze.svg"
  ) {
    return HIT_BOXES.sleeping;
  }

  if (WIDE_SVGS.has(svg)) {
    return HIT_BOXES.wide;
  }

  return HIT_BOXES.default;
}

function formatDeskState(state: DeskPetState): string {
  const labels: Record<DeskPetState, string> = {
    idle: "空闲",
    thinking: "思考中",
    typing: "输出中",
    working: "执行中",
    editing: "修改中",
    subagent_one: "单代理",
    subagent_many: "多代理",
    approval: "待审批",
    error: "错误",
    success: "完成",
    sleeping: "休眠"
  };

  return labels[state] ?? state;
}
