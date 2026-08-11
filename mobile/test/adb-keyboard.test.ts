import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ADB_KEYBOARD_COMPONENT,
  ADB_KEYBOARD_PACKAGE,
  AdbKeyboardManager,
  type RootCommandExecutor,
} from "../src/adb-keyboard.js";

const APK_HASH =
  "6f85594700ad96de89d012b3767049c2c6988510b68b31b439dd2a6dd93a30c9";
const APK_PATH =
  "/data/app/~~abc==/com.github.uiautomator-def==/base.apk";
const GBOARD_COMPONENT =
  "com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME";

/** 构造可记录固定 Android 命令的测试执行器。 */
function fakeExecutor(options: {
  packageDisabled?: boolean;
  imeEnabled?: boolean;
  componentMissing?: boolean;
  failCommand?: (command: string, count: number) => boolean;
} = {}): { execute: RootCommandExecutor; commands: string[] } {
  const commands: string[] = [];
  const counts = new Map<string, number>();
  let defaultIme = GBOARD_COMPONENT;
  const execute: RootCommandExecutor = async (command) => {
    commands.push(command);
    const count = (counts.get(command) ?? 0) + 1;
    counts.set(command, count);
    if (options.failCommand?.(command, count)) {
      throw new Error(`TEST_COMMAND_FAILED:${command}`);
    }
    if (command === `pm path ${ADB_KEYBOARD_PACKAGE}`) {
      return `package:${APK_PATH}\n`;
    }
    if (command === `dumpsys package ${ADB_KEYBOARD_PACKAGE}`) {
      return options.componentMissing
        ? "  versionCode=2004001 minSdk=23 targetSdk=35\n  versionName=2.4.0\n"
        : `  versionCode=2004001 minSdk=23 targetSdk=35\n  versionName=2.4.0\nandroid.view.InputMethod:\n  123 ${ADB_KEYBOARD_COMPONENT} filter permission android.permission.BIND_INPUT_METHOD\n`;
    }
    if (command.startsWith("sha256sum ")) return `${APK_HASH}  ${APK_PATH}\n`;
    if (command === "settings get secure default_input_method") {
      return `${defaultIme}\n`;
    }
    if (command === `pm list packages -d ${ADB_KEYBOARD_PACKAGE}`) {
      return options.packageDisabled ? `package:${ADB_KEYBOARD_PACKAGE}\n` : "";
    }
    if (command === "ime list -s") {
      return options.imeEnabled
        ? `${GBOARD_COMPONENT}\n${ADB_KEYBOARD_COMPONENT}\n`
        : `${GBOARD_COMPONENT}\n`;
    }
    if (command === "ime list -a") {
      return `${ADB_KEYBOARD_COMPONENT}:\n`;
    }
    if (command.startsWith("ime set --user 0 ")) {
      const requested = command.slice("ime set --user 0 ".length);
      defaultIme = requested.replace(/^'|'$/g, "");
      return "";
    }
    return "";
  };
  return { execute, commands };
}

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "autojs6-adb-keyboard-"),
);

const normalFake = fakeExecutor({ packageDisabled: true, imeEnabled: false });
const normalManager = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  path.join(temporaryRoot, "normal"),
  normalFake.execute,
);
assert.equal(await normalManager.activateForPublish("task_000001"), true);
assert.equal(normalManager.hasPendingRecovery(), true);
if (process.platform !== "win32") {
  assert.equal(fs.statSync(normalManager.recoveryPath).mode & 0o777, 0o600);
}
assert.deepEqual(normalFake.commands.slice(-5), [
  `pm enable --user 0 ${ADB_KEYBOARD_PACKAGE}`,
  "ime list -a",
  `ime enable --user 0 ${ADB_KEYBOARD_COMPONENT}`,
  `ime set --user 0 ${ADB_KEYBOARD_COMPONENT}`,
  "settings get secure default_input_method",
]);
assert.equal(await normalManager.restore(), true);
assert.equal(normalManager.hasPendingRecovery(), false);
assert.deepEqual(normalFake.commands.slice(-4), [
  `ime enable --user 0 '${GBOARD_COMPONENT}'`,
  `ime set --user 0 '${GBOARD_COMPONENT}'`,
  `ime disable --user 0 ${ADB_KEYBOARD_COMPONENT}`,
  `pm disable-user --user 0 ${ADB_KEYBOARD_PACKAGE}`,
]);

const disabledManager = new AdbKeyboardManager(
  { enabled: false, apkSha256: "" },
  path.join(temporaryRoot, "disabled"),
  async () => {
    throw new Error("disabled manager must not execute root commands");
  },
);
assert.equal(await disabledManager.activateForPublish("task_000002"), false);

const crashFake = fakeExecutor({ packageDisabled: false, imeEnabled: true });
const crashStateDirectory = path.join(temporaryRoot, "crash");
const beforeCrash = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  crashStateDirectory,
  crashFake.execute,
);
await beforeCrash.activateForPublish("task_000003");
const afterCrash = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  crashStateDirectory,
  crashFake.execute,
);
assert.equal(
  await afterCrash.recoverOnStartup({ attempts: 1, initialDelayMs: 0 }),
  true,
);
assert.equal(afterCrash.hasPendingRecovery(), false);

const missingFake = fakeExecutor({
  packageDisabled: true,
  componentMissing: true,
});
const missingManager = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  path.join(temporaryRoot, "missing"),
  missingFake.execute,
);
await assert.rejects(
  () => missingManager.activateForPublish("task_000004"),
  /ADB_KEYBOARD_IME_COMPONENT_MISSING/,
);
assert.equal(
  missingManager.hasPendingRecovery(),
  false,
  "missing IME after package enable must roll back immediately",
);

const hashFake = fakeExecutor();
const hashManager = new AdbKeyboardManager(
  { enabled: true, apkSha256: "a".repeat(64) },
  path.join(temporaryRoot, "hash"),
  hashFake.execute,
);
await assert.rejects(
  () => hashManager.activateForPublish("task_000005"),
  /ADB_KEYBOARD_APK_HASH_MISMATCH/,
);
assert.equal(hashManager.hasPendingRecovery(), false);
assert.equal(
  hashFake.commands.some((command) => command.startsWith("pm enable --user")),
  false,
  "hash mismatch must fail before mutation",
);

const retryStateDirectory = path.join(temporaryRoot, "retry");
const retrySetupFake = fakeExecutor();
const retrySetupManager = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  retryStateDirectory,
  retrySetupFake.execute,
);
await retrySetupManager.activateForPublish("task_000006");
const retryFake = fakeExecutor({
  failCommand: (command, count) =>
    command === `ime set --user 0 '${GBOARD_COMPONENT}'` && count === 1,
});
const retryManager = new AdbKeyboardManager(
  { enabled: true, apkSha256: APK_HASH },
  retryStateDirectory,
  retryFake.execute,
);
assert.equal(
  await retryManager.recoverOnStartup({
    attempts: 2,
    initialDelayMs: 0,
    maximumDelayMs: 0,
  }),
  true,
);
assert.equal(retryManager.hasPendingRecovery(), false);
assert.equal(
  retryFake.commands.filter(
    (command) => command === `ime set --user 0 '${GBOARD_COMPONENT}'`,
  ).length,
  2,
);

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("AdbKeyboard lifecycle tests passed");
