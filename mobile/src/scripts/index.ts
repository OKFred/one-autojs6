import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { Autojs6Config } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 稳健读取 .js 脚本文件文本
 * 优先在 __dirname 下寻找，兜底 fallback 到 src/scripts 路径
 */
function readScriptFile(fileName: string): string {
  const targetPath = path.join(__dirname, fileName);
  if (fs.existsSync(targetPath)) {
    return fs.readFileSync(targetPath, "utf8");
  }

  // 降级支持开发与打包路径
  const fallbackPath = path.resolve(
    __dirname,
    "..",
    "..",
    "src",
    "scripts",
    fileName,
  );
  if (fs.existsSync(fallbackPath)) {
    return fs.readFileSync(fallbackPath, "utf8");
  }

  throw new Error(
    `Script file not found: ${fileName} (checked ${targetPath} and ${fallbackPath})`,
  );
}

/**
 * 根据配置拼装完整的 AutoJS6 Observer 运行脚本
 *
 * @param eventResPath 事件追加日志的目标路径
 * @param eventConfig 配置文件中的事件监听配置
 * @param observerControlPath Observer 单实例控制文件路径
 * @param observerInstanceId 本次 Observer 实例标识
 * @returns 拼装后的纯 JS 脚本文本
 */
export function buildObserverScript(
  eventResPath: string,
  eventConfig: Autojs6Config["events"],
  observerControlPath: string,
  observerInstanceId: string,
): string {
  const baseScript = readScriptFile("observer_base.js")
    .replace("__EVENT_RES_PATH__", JSON.stringify(eventResPath))
    .replace("__OBSERVER_CONTROL_PATH__", JSON.stringify(observerControlPath))
    .replace("__OBSERVER_INSTANCE_ID__", JSON.stringify(observerInstanceId));

  const blocks: string[] = [baseScript];

  if (eventConfig.battery.enabled) {
    blocks.push(readScriptFile("battery_observer.js"));
  }

  if (eventConfig.network.enabled) {
    blocks.push(readScriptFile("network_observer.js"));
  }

  if (eventConfig.sms.enabled) {
    blocks.push(readScriptFile("sms_observer.js"));
  }

  if (eventConfig.notification.enabled) {
    blocks.push(
      readScriptFile("notification_observer.js")
        .replace(
          "__PACKAGE_ALLOW_LIST__",
          JSON.stringify(eventConfig.notification.packageAllowList),
        )
        .replace(
          "__PACKAGE_DENY_LIST__",
          JSON.stringify(eventConfig.notification.packageDenyList),
        ),
    );
  }

  return blocks.join("\n\n");
}
