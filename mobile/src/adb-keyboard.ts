import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 固定支持的 AdbKeyboard Android 包名。 */
export const ADB_KEYBOARD_PACKAGE = "com.github.uiautomator";

/** 固定支持的 AdbKeyboard 版本。 */
export const ADB_KEYBOARD_VERSION = "2.4.0";

/** 固定支持的 AdbKeyboard versionCode。 */
export const ADB_KEYBOARD_VERSION_CODE = "2004001";

/** 固定支持的 AdbKeyboard 输入法组件。 */
export const ADB_KEYBOARD_COMPONENT =
  "com.github.uiautomator/.AdbKeyboard";

/** AdbKeyboard 本机可信配置。 */
export interface AdbKeyboardConfig {
  enabled: boolean;
  apkSha256: string;
}

/** 可注入测试的 root 命令执行器。 */
export type RootCommandExecutor = (command: string) => Promise<string>;

/** 崩溃后恢复输入法所需的私有状态。 */
export interface AdbKeyboardRecoveryState {
  version: 1;
  taskId: string;
  previousDefaultIme: string | null;
  packageWasEnabled: boolean;
  imeWasEnabled: boolean;
  activatedAt: number;
}

/** 启动崩溃恢复的有限重试配置。 */
export interface AdbKeyboardRecoveryOptions {
  attempts?: number;
  initialDelayMs?: number;
  maximumDelayMs?: number;
}

/** 为本地已验证值添加 POSIX shell 单引号。 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** 使用 su 执行本模块固定构造的 Android 命令并返回标准输出。 */
function executeRootCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "su",
      ["-c", command],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `ADB_KEYBOARD_ROOT_COMMAND_FAILED:${String(stderr || error.message).trim()}`,
            ),
          );
        } else {
          resolve(String(stdout));
        }
      },
    );
  });
}

/** 判断未知值是否为合法恢复状态。 */
function isRecoveryState(value: unknown): value is AdbKeyboardRecoveryState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Partial<AdbKeyboardRecoveryState>;
  return (
    state.version === 1 &&
    typeof state.taskId === "string" &&
    (state.previousDefaultIme === null ||
      typeof state.previousDefaultIme === "string") &&
    typeof state.packageWasEnabled === "boolean" &&
    typeof state.imeWasEnabled === "boolean" &&
    typeof state.activatedAt === "number"
  );
}

/** 判断输入法组件字符串是否可安全传给固定 root 命令。 */
function isSafeImeComponent(value: string): boolean {
  return /^[A-Za-z0-9._]+\/(?:\.[A-Za-z0-9._]+|[A-Za-z0-9._]+)$/.test(
    value,
  );
}

/** 展开简写类名以比较同一个输入法组件。 */
function canonicalImeComponent(value: string): string {
  const separator = value.indexOf("/");
  if (separator < 1) return value;
  const packageName = value.slice(0, separator);
  const className = value.slice(separator + 1);
  return `${packageName}/${className.startsWith(".") ? packageName + className : className}`;
}

/** 将 JSON 原子写入仅当前用户可读的恢复文件。 */
function atomicWriteJson(filePath: string, value: unknown): void {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(directory, 0o700);
  } catch {
    // Android 文件系统不支持 POSIX 权限时继续使用原子写入。
  }
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const descriptor = fs.openSync(temporaryPath, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Android 文件系统不支持 POSIX 权限。
  }
}

/** 等待有限毫秒后继续恢复重试。 */
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 管理 TikTok 发布期间 AdbKeyboard 的校验、启用与崩溃恢复。 */
export class AdbKeyboardManager {
  readonly recoveryPath: string;
  private readonly config: AdbKeyboardConfig;
  private readonly execute: RootCommandExecutor;

  /**
   * 创建 AdbKeyboard 生命周期管理器。
   *
   * @param config 本机可信配置。
   * @param stateDirectory Mobile 私有状态目录。
   * @param executor 可选 root 命令执行器。
   */
  constructor(
    config: AdbKeyboardConfig,
    stateDirectory: string,
    executor: RootCommandExecutor = executeRootCommand,
  ) {
    this.config = {
      enabled: config.enabled,
      apkSha256: config.apkSha256.trim().toLowerCase(),
    };
    this.recoveryPath = path.join(
      stateDirectory,
      "adb-keyboard",
      "restore.json",
    );
    this.execute = executor;
  }

  /**
   * 返回配置是否要求 TikTok publish 使用 AdbKeyboard。
   *
   * @returns 是否启用。
   */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 返回是否存在尚未完成的崩溃恢复状态。
   *
   * @returns 是否存在恢复文件。
   */
  hasPendingRecovery(): boolean {
    return fs.existsSync(this.recoveryPath);
  }

  /**
   * 启动时恢复上次崩溃遗留的输入法状态。
   *
   * @param options 有限重试与退避配置。
   * @returns 是否执行了恢复。
   */
  async recoverOnStartup(
    options: AdbKeyboardRecoveryOptions = {},
  ): Promise<boolean> {
    if (!fs.existsSync(this.recoveryPath)) return false;
    const attempts = Math.max(1, Math.min(options.attempts ?? 5, 10));
    const maximumDelayMs = Math.max(0, options.maximumDelayMs ?? 8000);
    let delayMs = Math.max(0, options.initialDelayMs ?? 500);
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        await this.restore();
        return true;
      } catch (error) {
        lastError = error;
        if (attempt < attempts && delayMs > 0) {
          await delay(delayMs);
          delayMs = Math.min(Math.max(delayMs * 2, 1), maximumDelayMs);
        }
      }
    }
    throw lastError;
  }

  /**
   * 校验固定 AdbKeyboard，并为单次 TikTok publish 临时切换输入法。
   *
   * @param taskId 本机已校验的任务 ID，仅用于恢复审计。
   * @returns 是否实际启用了 AdbKeyboard。
   */
  async activateForPublish(taskId: string): Promise<boolean> {
    if (!this.config.enabled) return false;
    if (!/^[A-Za-z0-9_-]{8,100}$/.test(taskId)) {
      throw new Error("ADB_KEYBOARD_INVALID_TASK_ID");
    }
    if (!/^[a-f0-9]{64}$/.test(this.config.apkSha256)) {
      throw new Error("ADB_KEYBOARD_APK_SHA256_REQUIRED");
    }
    if (fs.existsSync(this.recoveryPath)) await this.restore();

    const packageOutput = await this.execute(`pm path ${ADB_KEYBOARD_PACKAGE}`);
    const apkPaths = packageOutput
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("package:"))
      .map((line) => line.slice("package:".length));
    const apkPath = apkPaths.find((candidate) => candidate.endsWith("/base.apk"));
    if (!apkPath || !/^\/[A-Za-z0-9._/+,:=~-]+$/.test(apkPath)) {
      throw new Error("ADB_KEYBOARD_PACKAGE_NOT_INSTALLED");
    }

    const packageDump = await this.execute(
      `dumpsys package ${ADB_KEYBOARD_PACKAGE}`,
    );
    const versions = [...packageDump.matchAll(/^\s*versionName=([^\s]+)\s*$/gm)].map(
      (match) => match[1],
    );
    if (!versions.includes(ADB_KEYBOARD_VERSION)) {
      throw new Error("ADB_KEYBOARD_VERSION_MISMATCH");
    }
    const versionCodes = [
      ...packageDump.matchAll(/^\s*versionCode=(\d+)(?:\s|$)/gm),
    ].map((match) => match[1]);
    if (!versionCodes.includes(ADB_KEYBOARD_VERSION_CODE)) {
      throw new Error("ADB_KEYBOARD_VERSION_CODE_MISMATCH");
    }
    const inputMethodDeclaration = new RegExp(
      `android\\.view\\.InputMethod:[\\s\\S]{0,500}${ADB_KEYBOARD_PACKAGE.replaceAll(".", "\\.")}\\/\\.AdbKeyboard\\b[\\s\\S]{0,500}permission android\\.permission\\.BIND_INPUT_METHOD\\b`,
    );
    if (!inputMethodDeclaration.test(packageDump)) {
      throw new Error("ADB_KEYBOARD_IME_COMPONENT_MISSING");
    }

    const hashOutput = await this.execute(
      `sha256sum ${shellQuote(apkPath)}`,
    );
    const installedHash = hashOutput.trim().match(/^([a-fA-F0-9]{64})\s/)?.[1];
    if (!installedHash || installedHash.toLowerCase() !== this.config.apkSha256) {
      throw new Error("ADB_KEYBOARD_APK_HASH_MISMATCH");
    }

    const previousDefaultOutput = (
      await this.execute("settings get secure default_input_method")
    ).trim();
    const previousDefaultIme =
      previousDefaultOutput && previousDefaultOutput !== "null"
        ? previousDefaultOutput
        : null;
    if (previousDefaultIme && !isSafeImeComponent(previousDefaultIme)) {
      throw new Error("ADB_KEYBOARD_UNSAFE_PREVIOUS_IME");
    }
    const disabledPackages = await this.execute(
      `pm list packages -d ${ADB_KEYBOARD_PACKAGE}`,
    );
    const packageWasEnabled = !disabledPackages
      .split(/\r?\n/)
      .some((line) => line.trim() === `package:${ADB_KEYBOARD_PACKAGE}`);
    const enabledImes = await this.execute("ime list -s");
    const imeWasEnabled = enabledImes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .some(
        (component) =>
          canonicalImeComponent(component) ===
          canonicalImeComponent(ADB_KEYBOARD_COMPONENT),
      );
    const state: AdbKeyboardRecoveryState = {
      version: 1,
      taskId,
      previousDefaultIme,
      packageWasEnabled,
      imeWasEnabled,
      activatedAt: Date.now(),
    };
    atomicWriteJson(this.recoveryPath, state);
    try {
      await this.execute(`pm enable --user 0 ${ADB_KEYBOARD_PACKAGE}`);
      let componentVisible = false;
      for (let attempt = 1; attempt <= 10; attempt += 1) {
        const availableImes = await this.execute("ime list -a");
        if (availableImes.includes(ADB_KEYBOARD_COMPONENT)) {
          componentVisible = true;
          break;
        }
        if (attempt < 10) await delay(500);
      }
      if (!componentVisible) {
        throw new Error("ADB_KEYBOARD_IME_COMPONENT_UNAVAILABLE");
      }
      await this.execute(`ime enable --user 0 ${ADB_KEYBOARD_COMPONENT}`);
      await this.execute(`ime set --user 0 ${ADB_KEYBOARD_COMPONENT}`);
      const activeIme = (
        await this.execute("settings get secure default_input_method")
      ).trim();
      if (
        canonicalImeComponent(activeIme) !==
        canonicalImeComponent(ADB_KEYBOARD_COMPONENT)
      ) {
        throw new Error("ADB_KEYBOARD_ACTIVATION_FAILED");
      }
      return true;
    } catch (error) {
      try {
        await this.restore();
      } catch {
        // 保留恢复文件，交由下次启动继续恢复。
      }
      throw error;
    }
  }

  /**
   * 按私有恢复文件还原默认输入法、IME 启用状态和包启用状态。
   *
   * @returns 是否执行了恢复。
   */
  async restore(): Promise<boolean> {
    if (!fs.existsSync(this.recoveryPath)) return false;
    let value: unknown;
    try {
      value = JSON.parse(fs.readFileSync(this.recoveryPath, "utf8"));
    } catch {
      throw new Error("ADB_KEYBOARD_RECOVERY_STATE_INVALID");
    }
    if (!isRecoveryState(value)) {
      throw new Error("ADB_KEYBOARD_RECOVERY_STATE_INVALID");
    }
    const state = value;
    if (state.previousDefaultIme) {
      if (!isSafeImeComponent(state.previousDefaultIme)) {
        throw new Error("ADB_KEYBOARD_UNSAFE_PREVIOUS_IME");
      }
      await this.execute(
        `ime enable --user 0 ${shellQuote(state.previousDefaultIme)}`,
      );
      await this.execute(`ime set --user 0 ${shellQuote(state.previousDefaultIme)}`);
    }
    if (!state.imeWasEnabled) {
      await this.execute(`ime disable --user 0 ${ADB_KEYBOARD_COMPONENT}`);
    }
    if (!state.previousDefaultIme) {
      await this.execute("ime reset --user 0");
    }
    if (!state.packageWasEnabled) {
      await this.execute(`pm disable-user --user 0 ${ADB_KEYBOARD_PACKAGE}`);
    }
    fs.rmSync(this.recoveryPath, { force: true });
    return true;
  }
}
