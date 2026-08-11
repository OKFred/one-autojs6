import assert from "assert";
import {
  buildAutoJsEngineStopScript,
  parseAutoJsEngineStopResult,
} from "../src/autojs-engine.js";

/** 运行 AutoJS6 定向停止脚本的纯函数测试。 */
function main(): void {
  const target = "/sdcard/Download/autojs_task_123.js";
  const result = "/sdcard/Download/autojs_stop_123.json";
  const script = buildAutoJsEngineStopScript(target, result);
  assert.doesNotThrow(() => new Function(script));
  assert.equal(script.includes(JSON.stringify(target)), true);
  assert.equal(script.includes("engines.all()"), true);
  assert.equal(script.includes("stopAll"), false);
  assert.equal(script.includes("am force-stop"), false);
  assert.deepEqual(
    parseAutoJsEngineStopResult('{"stopped":true,"matchedEngines":1}'),
    { stopped: true, matchedEngines: 1 },
  );
  assert.throws(() => parseAutoJsEngineStopResult('{"stopped":"yes"}'));
  console.log("AutoJS engine control tests passed");
}

main();
