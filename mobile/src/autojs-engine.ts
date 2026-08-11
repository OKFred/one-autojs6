/** AutoJS6 定向停止脚本写回的最小结果。 */
export interface AutoJsEngineStopResult {
  stopped: boolean;
  matchedEngines: number;
}

/**
 * 构造只停止指定脚本源文件的 AutoJS6 控制脚本。
 * 目标路径和结果路径由手机客户端生成，任务参数不会进入控制逻辑。
 */
export function buildAutoJsEngineStopScript(
  targetScriptPath: string,
  resultPath: string,
): string {
  return `
var targetScriptPath = ${JSON.stringify(targetScriptPath)};
var engineStopResultPath = ${JSON.stringify(resultPath)};
var matchedEngines = 0;

/** 将 AutoJS6 引擎来源统一为 Android 绝对路径。 */
function normalizeEngineSource(value) {
  return String(value || "")
    .replace(/^file:\\/\\//, "")
    .replace(/^\\[remote]\\s*/, "")
    .trim();
}

try {
  var allEngines = engines.all();
  for (var engineIndex = 0; engineIndex < allEngines.length; engineIndex += 1) {
    var candidateEngine = allEngines[engineIndex];
    var source = "";
    try {
      source = normalizeEngineSource(candidateEngine.getSource());
    } catch (_) {
      source = "";
    }
    if (source === targetScriptPath) {
      matchedEngines += 1;
      candidateEngine.forceStop();
    }
  }
  files.write(engineStopResultPath, JSON.stringify({
    stopped: matchedEngines > 0,
    matchedEngines: matchedEngines
  }));
} catch (error) {
  files.write(engineStopResultPath, JSON.stringify({
    stopped: false,
    matchedEngines: matchedEngines,
    error: "ENGINE_STOP_FAILED"
  }));
}
exit();
`;
}

/** 解析 AutoJS6 定向停止结果，忽略脚本附加的非协议字段。 */
export function parseAutoJsEngineStopResult(
  content: string,
): AutoJsEngineStopResult {
  const parsed: unknown = JSON.parse(content);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { stopped?: unknown }).stopped !== "boolean" ||
    !Number.isInteger((parsed as { matchedEngines?: unknown }).matchedEngines)
  ) {
    throw new Error("INVALID_ENGINE_STOP_RESULT");
  }
  return {
    stopped: (parsed as { stopped: boolean }).stopped,
    matchedEngines: (parsed as { matchedEngines: number }).matchedEngines,
  };
}
