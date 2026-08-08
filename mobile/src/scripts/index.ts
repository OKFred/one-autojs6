import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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
  const fallbackPath = path.resolve(__dirname, "..", "..", "src", "scripts", fileName);
  if (fs.existsSync(fallbackPath)) {
    return fs.readFileSync(fallbackPath, "utf8");
  }

  throw new Error(`Script file not found: ${fileName} (checked ${targetPath} and ${fallbackPath})`);
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
