import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * 加载脚本片段文本
 */
function readScriptFile(fileName: string): string {
  const filePath = path.join(__dirname, fileName);
  return fs.readFileSync(filePath, "utf8");
}

/**
 * 根据配置拼装完整的 AutoJS6 Observer 运行脚本
 *
 * @param eventResPath 事件追加日志的目标路径
 * @param activeConfig 包含的激活配置列表 (如 ["battery", "network", "sms"])
 * @returns 拼装后的纯 JS 脚本文本
 */
export function buildObserverScript(
  eventResPath: string,
  activeConfig: string[]
): string {
  const baseScript = readScriptFile("observer_base.js").replace(
    "__EVENT_RES_PATH__",
    eventResPath
  );

  const blocks: string[] = [baseScript];

  if (activeConfig.includes("battery")) {
    blocks.push(readScriptFile("battery_observer.js"));
  }

  if (activeConfig.includes("network")) {
    blocks.push(readScriptFile("network_observer.js"));
  }

  if (activeConfig.includes("sms")) {
    blocks.push(readScriptFile("sms_observer.js"));
  }

  blocks.push("setInterval(function(){}, 1000);");

  return blocks.join("\n\n");
}
