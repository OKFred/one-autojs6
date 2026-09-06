import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const studioPath = fileURLToPath(new URL('../public/studio/index.html', import.meta.url));
const streamAppPath = fileURLToPath(new URL('../ws-scrcpy/src/app/index.ts', import.meta.url));

/**
 * Verify the Studio exposes safe route selection and a recovery input shield.
 * @returns Nothing.
 */
function verifyStudioP2pControls(): void {
    const html = readFileSync(studioPath, 'utf8');
    assert.match(html, /<option value="relay" selected>服务器中继<\/option>/);
    assert.match(html, /<option value="p2p-preferred">自动（P2P 优先）<\/option>/);
    assert.match(html, /id="open-route-drawer"[\s\S]*?aria-controls="route-drawer"/);
    assert.match(html, /id="route-drawer" class="route-drawer" role="dialog" aria-modal="true"/);
    assert.match(html, /自动选择（推荐）/);
    assert.match(html, /本次检测到的线路/);
    assert.match(html, /查看经过节点/);
    assert.match(html, /节点 IP、可用的域名和 Ping 延时/);
    assert.match(html, /逐跳查看 IP、域名和延时/);
    assert.match(html, /route-probes/);
    assert.match(html, /Object\.keys\(task\)\.length !== 11/);
    assert.match(html, /Object\.keys\(hop\)\.length !== 5/);
    assert.match(html, /primary\.textContent = address/);
    assert.match(html, /secondary\.textContent = detail/);
    assert.match(html, /routeProbeRevision \+= 1/);
    assert.match(html, /body: JSON\.stringify\(\{ clientId, transportPreference \}\)/);
    assert.match(html, /id="transport-overlay" class="transport-overlay hidden"/);
    assert.match(html, /event\.data\.state === "transport-recovering"/);
    assert.match(html, /remoteFrame\.classList\.toggle\("recovering", active\)/);
    assert.match(html, /let transportRecoveryGeneration = -1;/);
    assert.match(html, /let transportStateRevision = 0;/);
    assert.match(html, /const pollTransportRevision = transportStateRevision;/);
    assert.match(html, /if \(pollTransportRevision !== transportStateRevision\)/);
    assert.match(html, /if \(transportRecoveryGeneration === generation\)/);
    assert.match(html, /latchTransportRecovery\(relayGeneration, event\.data\.reasonCode/);
    assert.match(html, /event\.data\.state === "transport-relay"[\s\S]*?resetTransportRecovery\(\)/);
    assert.match(
        html,
        /grid-template-columns:\s*minmax\(400px, min\(var\(--remote-column-width\), calc\(100% - 474px\)\)\)\s*minmax\(460px, 1fr\)/,
    );
    assert.match(html, /container-type: inline-size/);
    assert.match(html, /@container \(max-width: 560px\)[\s\S]*?\.remote-card > \.card-head/);
    assert.match(html, /const remoteColumnMinimumWidth = 400;/);
    assert.match(html, /const remoteColumnResizeDeadband = 16;/);
    assert.match(html, /const relayLayoutMessageType = "one-autojs6\.remote\.layout\.v1";/);
    assert.match(html, /const relayDiagnosticsMessageType = "one-autojs6\.remote\.diagnostics\.v1";/);
    assert.match(html, /event\.origin !== scrcpyOrigin[\s\S]*?event\.source !== remoteFrame\.contentWindow/);
    assert.match(html, /keys\.length !== 6/);
    assert.match(html, /!Number\.isFinite\(message\.videoWidth\)/);
    assert.match(html, /!Number\.isFinite\(message\.videoHeight\)/);
    assert.match(html, /workspaceWidth - sideColumnMinimumWidth - workspaceColumnGap/);
    assert.match(html, /frameHeight \* remoteLayoutMetrics\.videoWidth \/ remoteLayoutMetrics\.videoHeight/);
    assert.match(
        html,
        /Math\.abs\(boundedWidth - committedRemoteColumnWidth\) <= remoteColumnResizeDeadband/,
    );
    assert.match(html, /new ResizeObserver\(scheduleRemoteColumnWidth\)/);
    assert.doesNotMatch(html, /remoteLayoutResizeObserver\?\.observe\(remoteFrame\)/);
    assert.match(html, /message\.sessionId !== activeRelaySessionId/);
    assert.match(html, /message\.routes\.length > 16/);
    assert.match(html, /Object\.keys\(route\)\.length === 14/);
    assert.match(html, /routeList\.replaceChildren\(\)/);
    assert.match(html, /textContent = `电脑端/);
    assert.match(html, /requestRelayConnection\(refresh\)/);
    assert.equal(html.match(/resetRemoteLayout\(\);/g)?.length, 3);
    assert.equal(html.match(/fitToScreen: "true"/g)?.length, 2);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script, 'Studio inline script must exist');
    assert.doesNotThrow(() => new Function(script));
}

test('Studio defaults to WSS and handles P2P recovery state', verifyStudioP2pControls);

/**
 * Verify recording controls live in the parent panel and use the strict local bridge.
 * @returns Nothing.
 */
function verifyParentRecordingStudio(): void {
    const html = readFileSync(studioPath, 'utf8');
    assert.match(html, /<title>远程控制与录制工作室<\/title>/);
    assert.match(html, /id="recording-studio" class="studio-workbench hidden"/);
    assert.match(html, /id="studio-status-banner" class="studio-status-banner"/);
    assert.match(html, /id="studio-title"[\s\S]*?id="studio-record-toggle"/);
    assert.match(html, /id="studio-capture-video"[\s\S]*?id="studio-export-webm"/);
    assert.match(html, /id="studio-project-select"[\s\S]*?id="studio-delete-project"/);
    assert.match(html, /id="studio-timeline"[\s\S]*?id="studio-action-list"/);
    assert.match(html, /id="studio-delete-action"[\s\S]*?id="studio-cancel-replay"/);
    assert.match(html, /按原时序回放（\$\{formatStudioTime\(snapshot\.counts\.durationMs\)\}）/);
    assert.match(html, /正在按原时序回放…/);
    assert.match(html, /id="studio-export-autojs6"/);
    assert.match(html, /id="studio-audit-list"/);
    assert.match(html, /data-studio-focus="autojs6"/);
    assert.match(html, /data-studio-focus="audit"/);
    assert.match(html, /id="recording-role-badge" class="role-status-badge hidden"/);
    assert.match(html, /const studioCommandMessageType = "one-autojs6\.remote\.studio\.command\.v1"/);
    assert.match(html, /const studioEventMessageType = "one-autojs6\.remote\.studio\.event\.v1"/);
    for (const command of [
        'subscribe',
        'set-title',
        'set-capture-video',
        'send-text',
        'start-recording',
        'stop-recording',
        'import-json',
        'export-json',
        'save-project',
        'load-project',
        'delete-project',
        'select-action',
        'set-action-semantic-target',
        'clear-action-semantic-target',
        'delete-selected-action',
        'undo-delete',
        'redo-delete',
        'start-replay',
        'cancel-replay',
        'export-autojs6',
        'export-webm',
    ]) {
        assert.match(html, new RegExp(`"${command}"`));
    }
    assert.match(
        html,
        /postMessage\(\{\s*type: studioCommandMessageType,\s*sessionId: studioBridgeSessionId,\s*requestId: studioRequestId,\s*command,\s*payload,\s*\}, scrcpyOrigin\)/,
    );
    assert.match(
        html,
        /hasExactStudioKeys\(message, \["type", "sessionId", "revision", "requestId", "event", "payload"\]\)/,
    );
    assert.match(html, /message\.sessionId !== activeRelaySessionId/);
    assert.match(html, /message\.sessionId !== studioBridgeSessionId/);
    assert.match(html, /message\.revision <= studioEventRevision/);
    assert.match(html, /event\.data\.type === studioEventMessageType/);
    assert.match(html, /event\.origin !== scrcpyOrigin[\s\S]*?event\.source !== remoteFrame\.contentWindow/);
    assert.match(html, /hasExactStudioKeys\(value, \["kind", "fileName", "mimeType", "content"\]\)/);
    assert.match(html, /value\.content instanceof Blob && value\.content\.size <= 128 \* 1024 \* 1024/);
    assert.match(html, /const json = await file\.text\(\)/);
    assert.match(html, /window\.confirm\(`确定删除浏览器项目/);
    assert.match(html, /studioSnapshot && studioSnapshot\.phase !== "idle"/);
    assert.match(html, /请先停止录制，再收起工作台/);
    assert.match(html, /recordingStudioOpenIntent = false/);
    assert.match(
        html,
        /event\.data\.state === "recording-studio-ready"[\s\S]*?relayLifecyclePhase === "active"[\s\S]*?subscribeRecordingStudio\(\)/,
    );
    assert.match(html, /function describeUiError\(/);
    assert.match(html, /身份验证失败，请检查 PC API Token/);
    assert.match(html, /当前 PC 服务未启用远控中继/);
    assert.doesNotMatch(html, /setStudioStatus\(error instanceof Error \? error\.message/);
    assert.match(html, /min\(var\(--remote-column-width\), calc\(100% - 474px\)\)/);
    assert.match(html, /@media \(max-width: 960px\)[\s\S]*?\.workspace \{\s*grid-template-columns: 1fr/);
    assert.match(html, /\.studio-action-list \{\s*max-height: 260px/);
    assert.doesNotMatch(html, /open-recording-studio/);
    assert.doesNotMatch(html, /const relayUiMessageType/);
}

test('Studio exposes a Chinese parent-side recording workbench', verifyParentRecordingStudio);

/**
 * Verify the child announces readiness only after its recording bridge listener exists.
 * @returns Nothing.
 */
function verifyRecordingStudioReadyHandshake(): void {
    const source = readFileSync(streamAppPath, 'utf8');
    const bridgeStart = source.indexOf('clientRef.current.startRecordingStudioBridge(');
    const readyState = source.indexOf("state: 'recording-studio-ready'");
    assert.ok(bridgeStart >= 0, 'recording bridge start must exist');
    assert.ok(readyState > bridgeStart, 'ready state must be sent after the bridge listener is installed');
    assert.match(
        source.slice(bridgeStart, readyState + 160),
        /type: PARENT_STATE_MESSAGE_TYPE,[\s\S]*?sessionId: transportSession\.sessionId/,
    );
}

test('embedded recorder has an explicit post-listener ready handshake', verifyRecordingStudioReadyHandshake);

/**
 * Verify product users can enrich one recorded point without exposing a raw UI tree.
 * @returns Nothing.
 */
function verifySemanticRecordingControls(): void {
    const html = readFileSync(studioPath, 'utf8');
    assert.match(html, /id="studio-identify-action"[^>]*>识别所选控件<\/button>/);
    assert.match(html, /id="studio-clear-action-semantic"[^>]*>清除控件识别<\/button>/);
    assert.match(html, /id="studio-semantic-fallback"[\s\S]*?value="selector-only" selected>仅选择器（默认最安全）<\/option>/);
    assert.match(html, /id="studio-semantic-side-effect"[\s\S]*?value="external-write">外部写入（发送 \/ 发布）<\/option>/);
    assert.match(html, /外部写入会强制使用“仅选择器”/);
    assert.match(html, /识别读取手机当前画面，请先回到该动作所在页面/);
    assert.match(html, /AutoJS6 选择器优先草稿/);
    assert.match(html, /优先使用已识别控件；坐标仅按安全策略兜底/);
    assert.match(html, /选择器质量：未识别/);
    assert.match(html, /选择器质量：待复核/);
    assert.match(html, /选择器质量：高/);
    assert.match(html, /"COORDINATE_ONLY", "WEAK_SELECTOR", "LONG_WAIT"/);
    assert.match(
        html,
        /"complete",\s*"capturePoint",\s*"semanticSummary",/,
    );
    assert.match(html, /function isStudioCapturePoint\(value\)/);
    assert.match(html, /value\.x < value\.screenWidth/);
    assert.match(html, /value\.y < value\.screenHeight/);
    assert.match(html, /function isStudioSemanticSummary\(value\)/);
    assert.match(html, /&& value\.label === null;/);
    assert.match(html, /\["none", "selector-ready", "coordinate-fallback-only"\]\.includes\(value\.status\)/);
    assert.match(html, /new Set\(\["resourceId", "description", "text", "class-bounds"\]\)/);
    assert.match(html, /\["selector-only", "selector-then-coordinate", "confirm-coordinate"\]\.includes\(value\.fallbackPolicy\)/);
    assert.match(html, /function isStudioSemanticTarget\(value\)/);
    assert.match(html, /value\.source !== "android-uiautomator"/);
    assert.match(html, /value\.length <= 4096/);
    assert.match(html, /"setActionSemanticTarget",\s*"clearActionSemanticTarget",/);
    assert.match(html, /function isStudioTargetAtData\(value\)/);
    assert.match(html, /async function handleStudioActionIdentification\(\)/);
    assert.match(html, /const task = await runOperation\("device\.ui\.target-at", capturePoint\)/);
    assert.match(html, /const bridgeSessionId = studioBridgeSessionId;/);
    assert.match(html, /const eventRevision = studioEventRevision;/);
    assert.match(html, /const remoteGeneration = relayGeneration;/);
    assert.match(html, /const recognitionGeneration = \+\+studioSemanticRecognitionGeneration;/);
    assert.match(html, /studioBridgeSessionId !== bridgeSessionId[\s\S]*?studioEventRevision !== eventRevision[\s\S]*?relayGeneration !== remoteGeneration/);
    assert.match(html, /latestAction\.capturePoint\.screenHeight !== capturePoint\.screenHeight/);
    assert.match(html, /if \(studioSemanticRecognitionGeneration === recognitionGeneration\) \{[\s\S]*?studioSemanticRecognitionBusy = false;/);
    assert.match(html, /录制内容在控件识别期间已变化，旧识别结果已丢弃。/);
    assert.match(html, /if \(task\.status !== "SUCCESS"\)/);
    assert.match(html, /if \(task\.operation !== "device\.ui\.target-at" \|\| !isStudioTargetAtData\(task\.data\)\)/);
    assert.match(html, /if \(!task\.data\.target\)/);
    assert.match(
        html,
        /sendStudioCommand\("set-action-semantic-target", \{\s*actionId,\s*target: task\.data\.target,\s*fallbackPolicy,\s*sideEffect,\s*\}\)/,
    );
    assert.match(html, /sendStudioCommand\("clear-action-semantic-target", \{ actionId: action\.id \}\)/);
    assert.match(html, /当前坐标没有识别到可用控件，原有识别未更改。/);
    assert.match(html, /控件识别失败，原有识别未更改。请确认手机在线后重试。/);
    assert.match(html, /sideEffect === "external-write"[\s\S]*?\? "selector-only"/);
    assert.match(html, /action\?\.semanticSummary\?\.fallbackPolicy \|\| "selector-only"/);
    assert.match(html, /确认将所选动作标记为“外部写入”吗？/);
    assert.match(html, /task\?\.operation === "device\.ui\.target-at"/);
    assert.match(html, /target\.description \? "description" : ""/);
    assert.match(html, /target\.text \? "text" : ""/);
    assert.doesNotMatch(html, /target\.text\.value|target\.description\.value/);
    assert.doesNotMatch(html, /rawHierarchy|hierarchyXml|pageSource/);
}

test('Studio enriches selected actions through a strict selector-first protocol', verifySemanticRecordingControls);

/**
 * Verify retained external writes cannot enter the raw coordinate replay path.
 * @returns Nothing.
 */
function verifyExternalWriteReplayGuard(): void {
    const html = readFileSync(studioPath, 'utf8');
    assert.match(html, /function hasStudioExternalWriteAction\(snapshot = studioSnapshot\)/);
    assert.match(html, /!action\.deleted && action\.semanticSummary\.sideEffect === "external-write"/);
    assert.match(html, /const rawReplayBlocked = hasStudioExternalWriteAction\(snapshot\)/);
    assert.match(html, /studioButtons\.startReplay\.disabled = rawReplayBlocked \|\| !snapshot\.capabilities\.startReplay/);
    assert.match(html, /含外部写入，已禁用原始坐标回放/);
    assert.match(html, /command === "start-replay" && hasStudioExternalWriteAction\(\)/);
    assert.match(html, /录制包含外部写入动作，已禁止原始坐标回放；请导出并复核选择器优先代码。/);
}

test('Studio blocks raw replay for retained external-write actions', verifyExternalWriteReplayGuard);

/**
 * Verify focused text is sent only through the recording bridge and promptly removed from the DOM.
 * @returns Nothing.
 */
function verifyRecordedFocusedTextControl(): void {
    const html = readFileSync(studioPath, 'utf8');
    assert.match(html, /id="studio-send-text" maxlength="2000" autocomplete="off"/);
    assert.match(html, /id="studio-send-text-button"[^>]*>输入并记录为文本动作<\/button>/);
    assert.match(html, /只向当前焦点输入，不会点击发送按钮/);
    assert.match(html, /项目 JSON 与生成代码可能包含输入值/);
    assert.match(html, /snapshot\?\.phase === "recording" && snapshot\.capabilities\.sendText/);
    assert.match(html, /studioSnapshot\?\.phase !== "recording" \|\| !studioSnapshot\.capabilities\.sendText/);
    assert.match(html, /command === "send-text"[\s\S]*?payload\.text\.length <= 2000/);
    assert.match(html, /sendStudioCommand\("send-text", \{ text \}\)/);
    assert.match(html, /sendStudioCommand\("send-text", \{ text \}\)[\s\S]*?studioSendText\.value = "";/);
    assert.match(html, /文本动作已提交，输入框已清空；正在等待录制工作台确认。/);
    assert.doesNotMatch(html, /setStudioStatus\([^\n]*studioSendText\.value/);
    assert.match(
        html,
        /@media \(max-width: 620px\)[\s\S]*?\.studio-text-row,\s*\.studio-semantic-settings \{\s*align-items: stretch;\s*grid-template-columns: minmax\(0, 1fr\);/,
    );
}

test('Studio records focused text without retaining it in parent UI state', verifyRecordedFocusedTextControl);
