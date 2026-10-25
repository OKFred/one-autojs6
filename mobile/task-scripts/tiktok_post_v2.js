var request = __AUTOJS_TASK_PARAMS__;
if (!request || typeof request !== "object") request = {};
var TIKTOK_PACKAGE = "com.zhiliaoapp.musically";
var AUTOJS_PACKAGE = "org.autojs.autojs6";
var ADB_KEYBOARD_PACKAGE = "com.github.uiautomator";
var ADB_KEYBOARD_SET_TEXT_ACTION = "ADB_KEYBOARD_SET_TEXT";
var action = "publish";
var contractVersion = Number(request.contractVersion || 1);
var publicationId = String(request.publicationId || "").trim();
var phase = "INITIALIZING";
var selectedMediaPath = "";
var selectedMediaType = "";
var selectedTitle = "";
var selectedDetails = "";
var selectedCaption = "";
var selectedMediaMetadata = null;
var selectedExpectedSha256 = "";
var requestedPostSettings = null;
var postSettingsEvidence = null;
var profileHandle = "";
var baselinePostIds = [];
var baselineTileCount = null;
var submitted = false;
var postConfirmed = false;
var warnings = [];
var uiErrorSignal = null;
var uiErrorMonitorStopped = false;
var uiErrorMonitorThread = null;

/**
 * 创建带稳定错误码的脚本错误。
 *
 * @param {string} code - 稳定错误码
 * @param {string} message - 不含敏感数据的错误说明
 * @returns {Error} 带 code 属性的错误
 */
function taskError(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

/**
 * 只记录任务生命周期内首次出现的可见错误。
 *
 * @param {string} code - 稳定错误码
 * @param {string} message - 不含弹窗原文的安全说明
 * @returns {void}
 */
function signalUiError(code, message) {
  if (!uiErrorSignal) uiErrorSignal = { code: code, message: message };
}

/**
 * 将短暂弹窗或 Toast 文本归类为稳定错误码。
 *
 * @param {*} value - 可见文本
 * @returns {void}
 */
function classifyUiErrorText(value) {
  var text = normalizeText(value);
  if (!text) return;
  if (
    /(验证码|安全验证|滑动验证|验证你的身份|操作过于频繁|可疑活动|captcha|security verification|verify your identity|too many attempts|suspicious activity)/i.test(
      text
    )
  ) {
    signalUiError(
      "RISK_CHALLENGE",
      "TikTok requires manual security verification; automation stopped"
    );
  } else if (
    /(music usage confirmation|by posting.{0,60}agree|confirm.{0,35}music rights|音乐使用确认|发布即表示.{0,35}同意|确认.{0,20}音乐.{0,10}权利)/i.test(text)
  ) {
    signalUiError("RIGHTS_CONFIRMATION_REQUIRED", "TikTok requires a manual rights confirmation before publishing");
  } else if (
    /(使\s*TikTok Shop\s*更加贴合|更加个性化的\s*TikTok Shop|更普通的\s*TikTok Shop|personal(?:ise|ize|ized).*TikTok Shop|TikTok Shop.*personal(?:isation|ization))/i.test(
      text
    )
  ) {
    signalUiError(
      "CONSENT_REQUIRED",
      "TikTok requires a manual privacy choice before automation can continue"
    );
  } else if (
    /(该地区不允许发布|此地区不支持发布|不能在你所在地区发布|所在地区.*无法发布|not available in your region|posting.*not available.*region|region.*not allowed.*post)/i.test(
      text
    )
  ) {
    signalUiError(
      "REGION_POSTING_RESTRICTED",
      "TikTok reported that posting is unavailable in the current region"
    );
  } else if (
    /(发布失败|上传失败|无法发布|couldn.?t upload|post failed|upload failed|unable to post)/i.test(
      text
    )
  ) {
    signalUiError("TIKTOK_UPLOAD_FAILED", "TikTok reported that the upload failed");
  } else if (
    /(无网络连接|网络异常|网络不给力|连接失败|no internet|network error|connection failed)/i.test(
      text
    )
  ) {
    signalUiError("TIKTOK_NETWORK_ERROR", "TikTok reported a network error");
  } else if (/^(登录|注册|Log in|Sign up)$/i.test(text)) {
    signalUiError("LOGIN_REQUIRED", "TikTok account is not signed in");
  }
}

/**
 * 若后台监听已捕获错误，则在主线程的安全检查点终止流程。
 *
 * @returns {void}
 */
function throwDetectedUiError() {
  if (uiErrorSignal) {
    throw taskError(uiErrorSignal.code, uiErrorSignal.message);
  }
}

/**
 * 启动仅属于当前 TikTok 任务的窗口与 Toast 错误监听。
 *
 * @returns {void}
 */
function startUiErrorMonitor() {
  uiErrorMonitorStopped = false;
  try {
    events.observeToast();
    events.onToast(function (toast) {
      try {
        if (String(toast.getPackageName()) === TIKTOK_PACKAGE) {
          classifyUiErrorText(toast.getText());
        }
      } catch (ignoredToast) {}
    });
  } catch (ignoredToastObserver) {}
  try {
    uiErrorMonitorThread = threads.start(function () {
      while (!uiErrorMonitorStopped && remainingTaskMs() > 0) {
        try {
          var pattern =
            "(?i).*(验证码|安全验证|滑动验证|验证你的身份|操作过于频繁|可疑活动|" +
            "使\\s*TikTok Shop\\s*更加贴合|更加个性化的\\s*TikTok Shop|更普通的\\s*TikTok Shop|" +
            "该地区不允许发布|此地区不支持发布|不能在你所在地区发布|所在地区.*无法发布|" +
            "发布失败|上传失败|无法发布|无网络连接|网络异常|网络不给力|连接失败|" +
            "captcha|security verification|verify your identity|too many attempts|suspicious activity|" +
            "personal(?:ise|ize|ized).*TikTok Shop|TikTok Shop.*personal(?:isation|ization)|" +
            "not available in your region|posting.*not available.*region|region.*not allowed.*post|" +
            "couldn.?t upload|post failed|upload failed|unable to post|no internet|network error|connection failed).*";
          var node = tikTokTextSelector(pattern).findOne(120);
          if (!node) node = tikTokDescSelector(pattern).findOne(120);
          if (node) classifyUiErrorText(node.text() || node.desc());
          var login = tikTokTextSelector("(?i)^(登录|注册|Log in|Sign up)$").findOne(80);
          if (login) classifyUiErrorText(login.text());
        } catch (ignoredMonitorError) {}
        sleep(200);
      }
    });
  } catch (ignoredThreadError) {
    uiErrorMonitorThread = null;
  }
}

/**
 * 停止当前任务的错误监听，避免线程延长脚本生命周期。
 *
 * @returns {void}
 */
function stopUiErrorMonitor() {
  uiErrorMonitorStopped = true;
  try {
    if (uiErrorMonitorThread) uiErrorMonitorThread.interrupt();
  } catch (ignoredInterrupt) {}
  try {
    events.removeAllListeners("toast");
  } catch (ignoredListenerCleanup) {}
  uiErrorMonitorThread = null;
}

/**
 * 规范化操作类型并兼容旧版发布请求。
 *
 * @param {Object} params - 任务参数
 * @returns {string} publish、preflight、recover 或 status
 */
function normalizeAction(params) {
  if (params && params.linkOnly === true) return "recover";
  var value = String((params && params.action) || "publish").toLowerCase();
  if (
    value !== "publish" &&
    value !== "preflight" &&
    value !== "recover" &&
    value !== "status"
  ) {
    throw taskError("INVALID_ACTION", "Unsupported TikTok action");
  }
  return value;
}

/**
 * 输出不含账号、路径和文案的阶段日志。
 *
 * @param {string} message - 阶段说明
 * @returns {void}
 */
function reportProgress(message) {
  console.log("[TikTok] " + message);
}

/**
 * 返回当前任务还能执行的毫秒数。
 *
 * @returns {number} 剩余毫秒数
 */
function remainingTaskMs() {
  if (typeof taskDeadlineAt === "undefined" || !Number(taskDeadlineAt)) {
    return 420000;
  }
  return Math.max(0, Number(taskDeadlineAt) - Date.now());
}

/**
 * 在任务总截止时间内暂停。
 *
 * @param {number} milliseconds - 希望暂停的毫秒数
 * @returns {void}
 */
function boundedSleep(milliseconds) {
  var duration = Math.min(Math.max(0, milliseconds), remainingTaskMs());
  if (duration <= 0) throw taskError("TASK_DEADLINE", "Task deadline reached");
  sleep(duration);
  throwDetectedUiError();
}

/**
 * 在指定范围内暂停，同时服从任务总截止时间。
 *
 * @param {number} minMs - 最短毫秒数
 * @param {number} maxMs - 最长毫秒数
 * @returns {void}
 */
function pause(minMs, maxMs) {
  boundedSleep(random(minMs, maxMs));
}

/**
 * 对任意数值设置上下限。
 *
 * @param {*} value - 原始值
 * @param {number} minimum - 最小值
 * @param {number} maximum - 最大值
 * @param {number} fallback - 非数字默认值
 * @returns {number} 有界整数
 */
function boundedNumber(value, minimum, maximum, fallback) {
  var number = Number(value);
  if (!isFinite(number)) number = fallback;
  return Math.floor(Math.max(minimum, Math.min(maximum, number)));
}

/**
 * 规范化用于比较的可见文本。
 *
 * @param {*} value - 原始文本
 * @returns {string} 合并空白后的文本
 */
function normalizeText(value) {
  return String(value || "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 规范化 TikTok 账号名。
 *
 * @param {*} value - 账号名
 * @returns {string} 不含 @ 的小写账号名
 */
function normalizeHandle(value) {
  return normalizeText(value).replace(/^@/, "").toLowerCase();
}

/**
 * 转义正则表达式字面量。
 *
 * @param {string} value - 原始文本
 * @returns {string} 已转义文本
 */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 等待 AutoJS6 无障碍服务可用，禁止无限等待。
 *
 * @param {number} timeoutMs - 最大等待时间
 * @returns {void}
 */
function waitForAccessibility(timeoutMs) {
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    try {
      if (auto.service) return;
    } catch (ignored) {}
    sleep(250);
  }
  throw taskError(
    "ACCESSIBILITY_UNAVAILABLE",
    "AutoJS6 accessibility service is unavailable"
  );
}

/**
 * 判断 TikTok 是否已安装。
 *
 * @returns {boolean} 是否已安装
 */
function isTikTokInstalled() {
  try {
    return Boolean(context.getPackageManager().getPackageInfo(TIKTOK_PACKAGE, 0));
  } catch (error) {
    return false;
  }
}

/**
 * 创建限定到 TikTok 包的文本选择器。
 *
 * @param {string} pattern - Java 正则字符串
 * @returns {UiSelector} 无障碍选择器
 */
function tikTokTextSelector(pattern) {
  return packageName(TIKTOK_PACKAGE).textMatches(pattern);
}

/**
 * 创建限定到 TikTok 包的描述选择器。
 *
 * @param {string} pattern - Java 正则字符串
 * @returns {UiSelector} 无障碍选择器
 */
function tikTokDescSelector(pattern) {
  return packageName(TIKTOK_PACKAGE).descMatches(pattern);
}

/**
 * 点击语义控件自身、可点击父节点或语义控件中心。
 *
 * @param {UiObject} node - 已由包限定选择器取得的节点
 * @returns {boolean} 是否点击成功
 */
function performSemanticClick(node) {
  if (!node) return false;
  var current = node;
  var depth = 0;
  while (current && depth < 8) {
    try {
      if (current.isClickable() && current.click()) return true;
    } catch (ignored) {}
    current = current.parent();
    depth++;
  }
  try {
    var bounds = node.bounds();
    if (bounds && bounds.width() > 0 && bounds.height() > 0) {
      return click(bounds.centerX(), bounds.centerY());
    }
  } catch (ignoredBounds) {}
  return false;
}

/**
 * 对已通过语义定位的单个控件执行一次中心点击。
 *
 * @param {UiObject} node - 已限定 TikTok 包且确认语义的节点
 * @returns {boolean} 是否发出一次有效点击
 */
function clickSemanticCenterOnce(node) {
  if (!node) return false;
  try {
    if (typeof node.isEnabled === "function" && !node.isEnabled()) return false;
    var bounds = node.bounds();
    if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) return false;
    return click(bounds.centerX(), bounds.centerY());
  } catch (error) {
    return false;
  }
}

/**
 * 按 TikTok 包内文本或描述查找语义控件。
 *
 * @param {string[]} keywords - 中英文候选文案
 * @param {number} timeoutMs - 总查找时长
 * @param {boolean} exact - 是否完整匹配
 * @returns {UiObject|null} 匹配节点
 */
function findSemanticNode(keywords, timeoutMs, exact) {
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    throwDetectedUiError();
    for (var i = 0; i < keywords.length; i++) {
      var escaped = escapeRegex(keywords[i]);
      var pattern = exact ? "(?i)^" + escaped + "$" : "(?i).*" + escaped + ".*";
      var node = tikTokTextSelector(pattern).findOne(80);
      if (!node) node = tikTokDescSelector(pattern).findOne(80);
      if (node) return node;
    }
    sleep(180);
  }
  return null;
}

/**
 * 查找并点击 TikTok 包内的语义控件。
 *
 * @param {string[]} keywords - 中英文候选文案
 * @param {number} timeoutMs - 总查找时长
 * @param {boolean} exact - 是否完整匹配
 * @returns {boolean} 是否点击成功
 */
function findAndClick(keywords, timeoutMs, exact) {
  var node = findSemanticNode(keywords, timeoutMs, exact);
  if (!node || !performSemanticClick(node)) return false;
  pause(500, 900);
  return true;
}

/**
 * 检测登录、验证码、风控或内容审核挑战，并立即停止自动化。
 *
 * @returns {void}
 */
function assertNoBlockingChallenge() {
  throwDetectedUiError();
  var accountPrivacyPattern = "(?i).*(switch to a public account|change to a public account|make your account public|切换为公开账号|切换为公开帐号|将账号设为公开|将账户设为公开).*";
  if (tikTokTextSelector(accountPrivacyPattern).exists() || tikTokDescSelector(accountPrivacyPattern).exists()) {
    throw taskError("ACCOUNT_PRIVACY_ACTION_REQUIRED", "Changing account-wide privacy requires the account owner");
  }
  var rightsPattern = "(?i).*(music usage confirmation|by posting.{0,60}agree|confirm.{0,35}music rights|音乐使用确认|发布即表示.{0,35}同意|确认.{0,20}音乐.{0,10}权利).*";
  var rightsActionPattern = "(?i)^(Continue|Agree|I agree|Agree and continue|继续|同意|我同意|同意并继续)$";
  if ((tikTokTextSelector(rightsPattern).exists() || tikTokDescSelector(rightsPattern).exists()) &&
      (tikTokTextSelector(rightsActionPattern).exists() || tikTokDescSelector(rightsActionPattern).exists())) {
    throw taskError("RIGHTS_CONFIRMATION_REQUIRED", "TikTok requires a manual rights confirmation before publishing");
  }
  var consentPattern =
    "(?i).*(使\\s*TikTok Shop\\s*更加贴合|更加个性化的\\s*TikTok Shop|更普通的\\s*TikTok Shop|" +
    "personal(?:ise|ize|ized).*TikTok Shop|TikTok Shop.*personal(?:isation|ization)).*";
  if (
    tikTokTextSelector(consentPattern).exists() ||
    tikTokDescSelector(consentPattern).exists()
  ) {
    throw taskError(
      "CONSENT_REQUIRED",
      "TikTok requires a manual privacy choice before automation can continue"
    );
  }
  var regionPattern =
    "(?i).*(该地区不允许发布|此地区不支持发布|不能在你所在地区发布|所在地区.*无法发布|" +
    "not available in your region|posting.*not available.*region|region.*not allowed.*post).*";
  if (
    tikTokTextSelector(regionPattern).exists() ||
    tikTokDescSelector(regionPattern).exists()
  ) {
    throw taskError(
      "REGION_POSTING_RESTRICTED",
      "TikTok reported that posting is unavailable in the current region"
    );
  }
  var pattern =
    "(?i).*(验证码|安全验证|滑动验证|验证你的身份|操作过于频繁|可疑活动|" +
    "captcha|security verification|verify your identity|too many attempts|suspicious activity).*";
  if (tikTokTextSelector(pattern).exists() || tikTokDescSelector(pattern).exists()) {
    throw taskError(
      "RISK_CHALLENGE",
      "TikTok requires manual security verification; automation stopped"
    );
  }
  var loginPattern = "(?i)^(登录|注册|Log in|Sign up)$";
  if (tikTokTextSelector(loginPattern).exists()) {
    throw taskError("LOGIN_REQUIRED", "TikTok account is not signed in");
  }
}

/**
 * 关闭不影响流程的普通提示，不处理任何安全验证。
 *
 * @returns {void}
 */
function dismissTransientDialogs() {
  assertNoBlockingChallenge();
  findAndClick(["暂时不要", "以后再说", "Not now", "Maybe later", "Later"], 350, true);
}

/**
 * 启动 TikTok 并等待前台包切换完成。
 *
 * @param {number} timeoutMs - 最大等待时间
 * @returns {void}
 */
function launchTikTok(timeoutMs) {
  app.launchPackage(TIKTOK_PACKAGE);
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    if (currentPackage() === TIKTOK_PACKAGE) {
      dismissTransientDialogs();
      return;
    }
    sleep(250);
  }
  throw taskError("TIKTOK_NOT_FOREGROUND", "TikTok did not enter the foreground");
}

/**
 * 从未提交的残留编辑页安全返回 TikTok 主导航，不保存草稿也不触发发布。
 *
 * @returns {UiObject|null} 可点击的主页标签；已经在本人主页时返回 null
 */
function recoverMainNavigation() {
  for (var attempt = 0; attempt < 6; attempt++) {
    assertNoBlockingChallenge();
    if (isOwnProfileGrid()) return null;
    var profileTab = findProfileTab(700);
    if (profileTab) return profileTab;
    var close = findSemanticNode(["关闭", "Close"], 250, true);
    if (close) {
      if (!performSemanticClick(close)) break;
      pause(700, 1100);
      continue;
    }
    var discard = findSemanticNode(["放弃", "Discard"], 250, true);
    if (discard) {
      if (!performSemanticClick(discard)) break;
      pause(700, 1100);
      continue;
    }
    back();
    pause(650, 1000);
  }
  return findProfileTab(1000);
}

/**
 * 查找当前账号的主页底部导航按钮。
 *
 * @param {number} timeoutMs - 最大等待时间
 * @returns {UiObject|null} 主页导航节点
 */
function findProfileTab(timeoutMs) {
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    var nodes = tikTokDescSelector("(?i)^(主页|个人主页|Profile|我)$").find();
    for (var i = 0; nodes && i < nodes.length; i++) {
      var bounds = nodes[i].bounds();
      if (bounds && bounds.bottom > device.height * 0.8) return nodes[i];
    }
    var textNodes = tikTokTextSelector("(?i)^(主页|个人主页|Profile|我)$").find();
    for (var j = 0; textNodes && j < textNodes.length; j++) {
      var textBounds = textNodes[j].bounds();
      if (textBounds && textBounds.bottom > device.height * 0.8) return textNodes[j];
    }
    sleep(250);
  }
  return null;
}

/**
 * 判断当前页面是否为本人作品网格页。
 *
 * @returns {boolean} 是否为本人主页
 */
function isOwnProfileGrid() {
  var handleNodes = packageName(TIKTOK_PACKAGE).textMatches("^@[^\\s@]{2,}$").find();
  var profileAction = findSemanticNode(
    ["编辑资料", "编辑个人资料", "分享个人主页", "Edit profile", "Share profile"],
    120,
    true
  );
  var playNodes = packageName(TIKTOK_PACKAGE)
    .id(TIKTOK_PACKAGE + ":id/tv_play_count")
    .find();
  return Boolean(
    handleNodes &&
      handleNodes.length &&
      (profileAction || (playNodes && playNodes.length))
  );
}

/**
 * 读取本人主页上方的 TikTok 账号名。
 *
 * @returns {string} 不含 @ 的账号名
 */
function readProfileHandle() {
  var preferred = packageName(TIKTOK_PACKAGE).id(TIKTOK_PACKAGE + ":id/se1").findOne(500);
  var value = preferred ? normalizeHandle(preferred.text()) : "";
  if (value) return value;
  var nodes = packageName(TIKTOK_PACKAGE).textMatches("^@[^\\s@]{2,}$").find();
  for (var i = 0; nodes && i < nodes.length; i++) {
    var bounds = nodes[i].bounds();
    if (bounds && bounds.top < device.height * 0.5) {
      value = normalizeHandle(nodes[i].text());
      if (value) return value;
    }
  }
  return "";
}

/**
 * 进入本人主页、读取账号并按配置严格校验。
 *
 * @returns {string} 已验证账号名
 */
function navigateToAndVerifyProfile() {
  assertNoBlockingChallenge();
  if (!isOwnProfileGrid()) {
    var profileTab = findProfileTab(1200) || recoverMainNavigation();
    if (!isOwnProfileGrid() && (!profileTab || !performSemanticClick(profileTab))) {
      throw taskError("PROFILE_NOT_FOUND", "TikTok profile navigation was not found");
    }
    if (!isOwnProfileGrid()) pause(1800, 2800);
  }
  dismissTransientDialogs();
  profileHandle = readProfileHandle();
  if (!profileHandle) {
    throw taskError("ACCOUNT_UNREADABLE", "Current TikTok account could not be read");
  }
  var expected = normalizeHandle(
    request.expectedHandle ||
      (request.account && request.account.expectedHandle) ||
      (request.recoveryContext && request.recoveryContext.expectedHandle) ||
      (request.recoveryContext && request.recoveryContext.account && request.recoveryContext.account.expectedHandle) ||
      (request.publicationContext && request.publicationContext.expectedHandle) ||
      (request.internalHints && request.internalHints.expectedHandle)
  );
  if (expected && profileHandle !== expected) {
    throw taskError("ACCOUNT_MISMATCH", "Current TikTok account does not match the configured account");
  }
  return profileHandle;
}

/**
 * 判断路径是否为受支持的单张图片或单个视频。
 *
 * @param {string} filePath - 文件路径
 * @returns {boolean} 是否支持
 */
function isSupportedMedia(filePath) {
  return /\.(jpe?g|png|webp|mp4|mov|m4v)$/i.test(String(filePath || ""));
}

/**
 * 解码所选素材的非敏感元数据并验证文件确实可读。
 *
 * @returns {Object} 大小、宽高和可选时长
 */
function readSelectedMediaMetadata() {
  var source = new java.io.File(selectedMediaPath);
  var sizeBytes = Number(source.length());
  if (!source.isFile() || sizeBytes <= 0) {
    throw taskError("MEDIA_UNREADABLE", "Selected TikTok media is not a readable file");
  }
  if (selectedMediaType === "image") {
    var options = new android.graphics.BitmapFactory.Options();
    options.inJustDecodeBounds = true;
    android.graphics.BitmapFactory.decodeFile(selectedMediaPath, options);
    var imageWidth = Number(options.outWidth || 0);
    var imageHeight = Number(options.outHeight || 0);
    if (imageWidth <= 0 || imageHeight <= 0) {
      throw taskError("MEDIA_DECODE_FAILED", "Selected TikTok image could not be decoded");
    }
    return {
      sizeBytes: sizeBytes,
      width: imageWidth,
      height: imageHeight,
      durationMs: 0
    };
  }
  var retriever = new android.media.MediaMetadataRetriever();
  try {
    retriever.setDataSource(selectedMediaPath);
    var durationMs = Number(
      retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION) || 0
    );
    var videoWidth = Number(
      retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH) || 0
    );
    var videoHeight = Number(
      retriever.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT) || 0
    );
    if (durationMs <= 0 || videoWidth <= 0 || videoHeight <= 0) {
      throw taskError("MEDIA_DECODE_FAILED", "Selected TikTok video metadata is invalid");
    }
    return {
      sizeBytes: sizeBytes,
      width: videoWidth,
      height: videoHeight,
      durationMs: durationMs
    };
  } catch (error) {
    if (error && error.code) throw error;
    throw taskError("MEDIA_DECODE_FAILED", "Selected TikTok video could not be decoded");
  } finally {
    try {
      retriever.release();
    } catch (ignoredRelease) {}
  }
}

/**
 * 仅接受本期显式支持的逐作品设置，不改变账号级隐私。
 * @param {*} value - 可选的逐作品设置
 * @returns {Object|null} 已校验设置或未请求
 */
function normalizeRequestedPostSettings(value) {
  if (typeof value === "undefined") return null;
  if (!value || typeof value !== "object" || value instanceof Array ||
      Object.keys(value).sort().join(",") !== "audience,commercialDisclosure" ||
      value.audience !== "PUBLIC" || value.commercialDisclosure !== "YOUR_BRAND") {
    throw taskError("POST_SETTINGS_INVALID", "Requested post settings are unsupported");
  }
  return { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND" };
}

/**
 * 从已保存恢复上下文读取历史核验证据；不生成新的核验时间。
 * @param {*} value - 历史证据
 * @returns {Object|null} 结构有效的原证据
 */
function validatedPostSettingsEvidence(value) {
  if (typeof value === "undefined" || value === null) return null;
  if (!value || typeof value !== "object" || value instanceof Array ||
      Object.keys(value).sort().join(",") !== "audience,commercialDisclosure,verified,verifiedAt" ||
      value.audience !== "PUBLIC" || value.commercialDisclosure !== "YOUR_BRAND" ||
      value.verified !== true || typeof value.verifiedAt !== "number" ||
      !isFinite(value.verifiedAt) || value.verifiedAt <= 0 ||
      Math.floor(value.verifiedAt) !== value.verifiedAt || value.verifiedAt > Date.now()) {
    throw taskError("POST_SETTINGS_NOT_VERIFIED", "Saved post settings evidence is invalid");
  }
  return value;
}

/**
 * 在 Android 上逐块计算实际素材字节摘要。
 * @param {string} filePath - 已选素材路径
 * @returns {string} 小写 SHA256
 */
function sha256SelectedFile(filePath) {
  var stream = null;
  try {
    var digest = java.security.MessageDigest.getInstance("SHA-256");
    stream = new java.io.FileInputStream(new java.io.File(filePath));
    var buffer = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 65536);
    var length;
    while ((length = stream.read(buffer)) !== -1) {
      if (remainingTaskMs() <= 0) throw taskError("TASK_DEADLINE", "Task deadline reached");
      digest.update(buffer, 0, length);
    }
    var result = digest.digest();
    var hex = "";
    for (var i = 0; i < result.length; i++) {
      var part = (Number(result[i]) & 255).toString(16);
      hex += part.length === 1 ? "0" + part : part;
    }
    return hex;
  } catch (error) {
    if (error && error.code) throw error;
    throw taskError("MEDIA_HASH_UNREADABLE", "Selected media digest could not be verified");
  } finally {
    if (stream) stream.close();
  }
}

/**
 * 重新核对待分享文件，阻止审批后替换素材。
 * @returns {void}
 */
function assertSelectedMediaIntegrity() {
  if (selectedExpectedSha256 && sha256SelectedFile(selectedMediaPath) !== selectedExpectedSha256) {
    throw taskError("MEDIA_HASH_MISMATCH", "Selected media differs from the approved digest");
  }
}

/**
 * 查找唯一可见语义设置，拒绝同名控件歧义。
 * @param {string[]} labels - 精确可见标签
 * @param {number} timeoutMs - 最大等待时间
 * @returns {UiObject|null} 唯一节点
 */
function findUniqueSettingNode(labels, timeoutMs) {
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  do {
    assertNoBlockingChallenge();
    var found = [];
    var seen = {};
    for (var i = 0; i < labels.length; i++) {
      var pattern = "(?i)^" + escapeRegex(labels[i]) + "(?:[,， ]+(?:selected|not selected|checked|unchecked|已选中|未选中|已勾选|未勾选))?$";
      var collections = [tikTokTextSelector(pattern).find(), tikTokDescSelector(pattern).find()];
      for (var c = 0; c < collections.length; c++) {
        var nodes = collections[c];
        for (var j = 0; nodes && j < nodes.length; j++) {
          var node = nodes[j];
          if (accessibleBoolean(node, ["visibleToUser", "isVisibleToUser"]) === false) continue;
          var bounds = node.bounds();
          if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) continue;
          var key = bounds.left + ":" + bounds.top + ":" + bounds.right + ":" + bounds.bottom;
          if (!seen[key]) { seen[key] = true; found.push(node); }
        }
      }
    }
    if (found.length > 1) throw taskError("POST_SETTINGS_AMBIGUOUS", "A post setting could not be identified uniquely");
    if (found.length === 1) return found[0];
    if (Date.now() < endAt) sleep(150);
  } while (Date.now() < endAt);
  return null;
}

/**
 * 安全读取可选无障碍布尔属性。
 * @param {UiObject} node - 设置节点
 * @param {string[]} names - 兼容属性方法名
 * @returns {boolean|null} 读取值或未知
 */
function accessibleBoolean(node, names) {
  for (var i = 0; node && i < names.length; i++) {
    try {
      if (typeof node[names[i]] === "function") {
        var value = node[names[i]]();
        if (typeof value === "boolean") return value;
      }
    } catch (ignored) {}
  }
  return null;
}

/**
 * 读取节点明确的选中状态，不把普通文本的默认 false 当作开关状态。
 * @param {UiObject} node - 设置节点
 * @returns {boolean|null} 选中状态或未知
 */
function directChoiceState(node) {
  var checkable = accessibleBoolean(node, ["checkable", "isCheckable"]);
  var className = "";
  try { className = String(node.className()); } catch (ignoredClass) {}
  if (checkable === true || /(?:Switch|CheckBox|RadioButton)$/.test(className)) {
    return accessibleBoolean(node, ["checked", "isChecked"]);
  }
  if (accessibleBoolean(node, ["selected", "isSelected"]) === true) return true;
  var description = "";
  try { description = normalizeText(node.desc()); } catch (ignoredDescription) {}
  if (/(?:,|，)\s*(?:not selected|unchecked|未选中|未勾选)$/i.test(description)) return false;
  if (/(?:,|，)\s*(?:selected|checked|已选中|已勾选)$/i.test(description)) return true;
  return null;
}

/**
 * 在标签所在行内寻找唯一开关/单选控件，禁止跨行猜测。
 * @param {UiObject} label - 精确标签
 * @returns {boolean|null} 可证明的设置状态
 */
function settingChoiceState(label) {
  var direct = directChoiceState(label);
  if (direct !== null) return direct;
  var origin = label.bounds();
  var container = label;
  for (var level = 0; container && level < 3; level++) {
    var queue = [{ node: container, depth: 0 }];
    var states = [];
    var seen = {};
    for (var index = 0; index < queue.length && index < 40; index++) {
      var item = queue[index];
      var bounds = item.node.bounds();
      if (bounds && Math.abs(bounds.centerY() - origin.centerY()) <= Math.max(36, origin.height() * 1.5)) {
        var state = directChoiceState(item.node);
        var key = bounds.left + ":" + bounds.top + ":" + bounds.right + ":" + bounds.bottom;
        if (state !== null && !seen[key]) { seen[key] = true; states.push(state); }
      }
      if (item.depth < 2) {
        var count = Number(item.node.childCount());
        for (var i = 0; i < count && queue.length < 40; i++) queue.push({ node: item.node.child(i), depth: item.depth + 1 });
      }
    }
    if (states.length > 1) return null;
    if (states.length === 1) return states[0];
    container = container.parent();
  }
  return null;
}

/**
 * 设置或只读核对一项明确可访问的开关/单选状态。
 * @param {string[]} labels - 精确标签
 * @param {boolean} desired - 期望状态
 * @param {boolean} readOnly - 是否禁止修改
 * @param {string} code - 无法核实时的错误码
 * @returns {void}
 */
function requireSettingChoice(labels, desired, readOnly, code) {
  var node = findUniqueSettingNode(labels, 2000);
  var state = node ? settingChoiceState(node) : null;
  if (state === null || (readOnly && state !== desired)) throw taskError(code, "Required post setting could not be verified");
  if (state !== desired) {
    if (accessibleBoolean(node, ["enabled", "isEnabled"]) === false) throw taskError(code, "Required post setting is unavailable");
    if (!performSemanticClick(node)) throw taskError(code, "Required post setting could not be changed");
    pause(600, 850);
    assertNoBlockingChallenge();
    node = findUniqueSettingNode(labels, 1500);
    if (!node || settingChoiceState(node) !== desired) throw taskError(code, "Required post setting readback did not match");
  }
}

/**
 * 从作品设置页返回文案编辑器，绝不确认账号隐私或权利协议。
 * @returns {void}
 */
function returnToPostEditor() {
  for (var i = 0; i < 3; i++) {
    assertNoBlockingChallenge();
    if (getDistinctInputs().length && findSemanticNode(["发布", "Post"], 250, true)) return;
    back();
    pause(550, 800);
  }
  throw taskError("POST_SETTINGS_NOT_VERIFIED", "Could not return to the post editor safely");
}

/**
 * 从文案编辑器打开逐作品受众选项，不进入账号级隐私设置。
 * @returns {void}
 */
function openPublicAudienceChoices() {
  var entry = findUniqueSettingNode(["谁可以观看此视频", "谁可以观看此作品", "谁可以观看", "Who can watch this video", "Who can view this post", "Everyone", "所有人", "公开", "Friends", "好友", "Only you", "仅自己"], 3000);
  if (!entry || !performSemanticClick(entry)) throw taskError("AUDIENCE_PUBLIC_UNAVAILABLE", "Public post audience is unavailable");
  pause(550, 850);
  assertNoBlockingChallenge();
  var privateOption = findUniqueSettingNode(["Only you", "仅自己", "Only me", "仅限自己"], 1500);
  var friendsOption = findUniqueSettingNode(["Friends", "好友", "互相关注的好友"], 500);
  if (!privateOption && !friendsOption) throw taskError("AUDIENCE_PUBLIC_UNAVAILABLE", "Per-post audience choices were not identified");
}

/**
 * 核对当前作品的公开受众；缺少 Everyone 时不进入账号隐私设置。
 * @param {boolean} readOnly - 是否仅核对现有选择
 * @returns {void}
 */
function configurePublicAudience(readOnly) {
  openPublicAudienceChoices();
  var publicLabels = ["Everyone", "所有人", "公开"];
  var choice = findUniqueSettingNode(publicLabels, 1500);
  var selected = choice ? settingChoiceState(choice) : null;
  if (selected === null || (readOnly && !selected)) throw taskError("AUDIENCE_PUBLIC_UNAVAILABLE", "Public post audience could not be verified");
  if (!selected) {
    if (accessibleBoolean(choice, ["enabled", "isEnabled"]) === false || !performSemanticClick(choice)) throw taskError("AUDIENCE_PUBLIC_UNAVAILABLE", "Public post audience is unavailable");
    pause(600, 850);
    assertNoBlockingChallenge();
    if (getDistinctInputs().length && findSemanticNode(["发布", "Post"], 200, true)) openPublicAudienceChoices();
  }
  requireSettingChoice(publicLabels, true, true, "AUDIENCE_PUBLIC_UNAVAILABLE");
  var done = findUniqueSettingNode(["Done", "完成", "Save", "保存"], 500);
  if (done) {
    if (!performSemanticClick(done)) throw taskError("AUDIENCE_PUBLIC_UNAVAILABLE", "Public audience could not be saved");
    pause(500, 750);
  }
  returnToPostEditor();
}

/**
 * 设置并核对自有品牌商业披露，权利确认弹窗必须由人处理。
 * @param {boolean} readOnly - 是否仅核对现有选择
 * @returns {void}
 */
function configureCommercialDisclosure(readOnly) {
  var labels = ["Content disclosure and ads", "内容披露和广告", "内容披露与广告", "商业内容披露"];
  var entry = findUniqueSettingNode(labels, 1000);
  if (!entry) {
    if (!findAndClick(["More options", "更多选项", "更多设置"], 1500, true)) throw taskError("COMMERCIAL_DISCLOSURE_NOT_VERIFIED", "Commercial disclosure settings are unavailable");
    entry = findUniqueSettingNode(labels, 2000);
  }
  if (!entry || !performSemanticClick(entry)) throw taskError("COMMERCIAL_DISCLOSURE_NOT_VERIFIED", "Commercial disclosure settings are unavailable");
  pause(550, 850);
  requireSettingChoice(["Disclose commercial content", "披露商业内容", "商业内容披露"], true, readOnly, "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  requireSettingChoice(["Your brand", "你的品牌", "您的品牌", "自己的品牌", "自有品牌"], true, readOnly, "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  requireSettingChoice(["Branded content", "品牌内容", "品牌合作内容"], false, readOnly, "COMMERCIAL_DISCLOSURE_NOT_VERIFIED");
  var save = findUniqueSettingNode(["Save", "保存", "Done", "完成"], 1000);
  if (save) {
    if (!performSemanticClick(save)) throw taskError("COMMERCIAL_DISCLOSURE_NOT_VERIFIED", "Commercial disclosure could not be saved");
    pause(550, 850);
  }
  returnToPostEditor();
}

/**
 * 在首次核验后冻结证据，提交前复查不能替换原证据时间。
 * @param {boolean} readOnly - 提交前必须使用只读复查
 * @returns {void}
 */
function applyRequestedPostSettings(readOnly) {
  if (!requestedPostSettings) return;
  configurePublicAudience(readOnly);
  configureCommercialDisclosure(readOnly);
  assertNoBlockingChallenge();
  if (!postSettingsEvidence) {
    if (readOnly) throw taskError("POST_SETTINGS_NOT_VERIFIED", "An original settings readback is required");
    postSettingsEvidence = { audience: "PUBLIC", commercialDisclosure: "YOUR_BRAND", verified: true, verifiedAt: Date.now() };
  }
}

/**
 * 从新版或旧版参数中读取已选定的单个素材。
 *
 * @returns {void}
 */
function prepareSelectedContent() {
  var media = request.media || {};
  var content = request.content || {};
  requestedPostSettings = normalizeRequestedPostSettings(request.postSettings);
  selectedExpectedSha256 = String(media.expectedSha256 || "");
  if (selectedExpectedSha256 && !/^[a-f0-9]{64}$/.test(selectedExpectedSha256)) {
    throw taskError("MEDIA_HASH_INVALID", "Expected media digest is invalid");
  }
  selectedMediaPath = String(
    media.path || request.selectedMediaPath || request.videoPath || request.imagePath || ""
  ).trim();
  selectedMediaType = String(media.kind || request.mediaType || "").toLowerCase();
  if (!selectedMediaType && selectedMediaPath) {
    selectedMediaType = /\.(mp4|mov|m4v)$/i.test(selectedMediaPath) ? "video" : "image";
  }
  selectedTitle = String(content.title != null ? content.title : request.title || "").trim();
  selectedDetails = String(content.details != null ? content.details : request.details || "").trim();
  selectedCaption = String(content.caption || "").trim();
  if (!selectedCaption) {
    selectedCaption = selectedTitle && selectedDetails
      ? selectedTitle + "\n" + selectedDetails
      : selectedTitle || selectedDetails;
  }
  if (action === "publish") {
    if (!selectedMediaPath || !isSupportedMedia(selectedMediaPath) || !files.exists(selectedMediaPath)) {
      throw taskError("MEDIA_UNAVAILABLE", "Selected TikTok media is missing or unsupported");
    }
    if (selectedMediaType !== "image" && selectedMediaType !== "video") {
      throw taskError("MEDIA_TYPE_INVALID", "Selected TikTok media type is invalid");
    }
    if (!selectedCaption) {
      throw taskError("CAPTION_REQUIRED", "TikTok title or details is required");
    }
  } else if (action === "preflight" && selectedMediaPath) {
    if (!isSupportedMedia(selectedMediaPath) || !files.exists(selectedMediaPath)) {
      throw taskError("MEDIA_UNAVAILABLE", "Selected TikTok media is missing or unsupported");
    }
    if (selectedMediaType !== "image" && selectedMediaType !== "video") {
      throw taskError("MEDIA_TYPE_INVALID", "Selected TikTok media type is invalid");
    }
  }
  if (selectedMediaPath) {
    selectedMediaMetadata = readSelectedMediaMetadata();
    assertSelectedMediaIntegrity();
  }
}

/**
 * 原子写入任务检查点。
 *
 * @param {string} checkpointPhase - EDITOR_READY、COMMITTING 或 SUBMITTED
 * @param {Object} extra - 需要持久化的恢复上下文
 * @returns {void}
 */
function writeCheckpoint(checkpointPhase, extra) {
  if (typeof taskCheckpointPath === "undefined" || !String(taskCheckpointPath)) {
    if (contractVersion >= 2 && action === "publish") {
      throw taskError("CHECKPOINT_UNAVAILABLE", "Publish checkpoint path is unavailable");
    }
    return;
  }
  var path = String(taskCheckpointPath);
  var temporaryPath = path + ".tmp";
  var data = {
    contractVersion: 2,
    publicationId: publicationId,
    phase: checkpointPhase,
    timestamp: Date.now(),
    baselinePostIds: baselinePostIds,
    baselineTileCount: baselineTileCount
  };
  if (postSettingsEvidence) data.postSettingsEvidence = postSettingsEvidence;
  if (extra) {
    for (var key in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, key)) data[key] = extra[key];
    }
  }
  var parentPath = String(new java.io.File(path).getParent() || "");
  if (parentPath) files.ensureDir(parentPath + "/");
  files.write(temporaryPath, JSON.stringify(data));
  try {
    var source = java.nio.file.Paths.get(temporaryPath);
    var target = java.nio.file.Paths.get(path);
    java.nio.file.Files.move(
      source,
      target,
      java.nio.file.StandardCopyOption.REPLACE_EXISTING,
      java.nio.file.StandardCopyOption.ATOMIC_MOVE
    );
  } catch (atomicError) {
    try {
      android.system.Os.rename(temporaryPath, path);
    } catch (renameError) {
      throw taskError("CHECKPOINT_WRITE_FAILED", "Could not commit publish checkpoint");
    }
  }
}

/**
 * 等待 Mobile 客户端确认指定检查点。
 *
 * @param {string} expectedPhase - 必须由客户端原样确认的阶段
 * @returns {void}
 */
function waitForCheckpointAck(expectedPhase) {
  if (typeof taskCheckpointAckPath === "undefined" || !String(taskCheckpointAckPath)) {
    if (contractVersion >= 2) {
      throw taskError("CHECKPOINT_ACK_UNAVAILABLE", "Publish checkpoint acknowledgement path is unavailable");
    }
    return;
  }
  var configured = request.taskCheckpointAckTimeoutMs || request.checkpointAckTimeoutMs;
  var timeoutMs = boundedNumber(configured, 1000, 30000, 10000);
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    if (files.exists(String(taskCheckpointAckPath))) {
      var value = normalizeText(files.read(String(taskCheckpointAckPath)));
      if (value === expectedPhase) return;
    }
    sleep(100);
  }
  throw taskError("CHECKPOINT_ACK_TIMEOUT", "Publish checkpoint was not acknowledged");
}

/**
 * 查询已进入 MediaStore 的素材 content URI。
 *
 * @param {string} mediaPath - 素材绝对路径
 * @returns {android.net.Uri|null} content URI
 */
function queryMediaContentUri(mediaPath) {
  var cursor = null;
  try {
    var collection = android.provider.MediaStore.Files.getContentUri("external");
    var idColumn = android.provider.MediaStore.Files.FileColumns._ID;
    var dataColumn = android.provider.MediaStore.MediaColumns.DATA;
    cursor = context.getContentResolver().query(
      collection,
      [idColumn],
      dataColumn + " = ?",
      [mediaPath],
      idColumn + " DESC"
    );
    if (cursor && cursor.moveToFirst()) {
      return android.content.ContentUris.withAppendedId(collection, cursor.getLong(0));
    }
  } catch (ignored) {
    return null;
  } finally {
    if (cursor) cursor.close();
  }
  return null;
}

/**
 * 将素材加入 MediaStore 后取得可授权的 content URI。
 *
 * @returns {android.net.Uri|null} content URI
 */
function getSelectedMediaContentUri() {
  var uri = queryMediaContentUri(selectedMediaPath);
  if (uri) return uri;
  var lowerPath = selectedMediaPath.toLowerCase();
  var mimeType = selectedMediaType === "video" ? "video/mp4" : "image/jpeg";
  if (/\.png$/.test(lowerPath)) mimeType = "image/png";
  else if (/\.webp$/.test(lowerPath)) mimeType = "image/webp";
  else if (/\.(mov|m4v)$/.test(lowerPath)) mimeType = "video/quicktime";
  try {
    android.media.MediaScannerConnection.scanFile(
      context,
      [selectedMediaPath],
      [mimeType],
      null
    );
    var endAt = Date.now() + Math.min(5000, remainingTaskMs());
    while (Date.now() < endAt) {
      sleep(250);
      uri = queryMediaContentUri(selectedMediaPath);
      if (uri) return uri;
    }
  } catch (ignoredScan) {}
  return null;
}

/**
 * 对摘要绑定任务核对分享 URI 的实际文件身份，禁止选择图库中的近似素材。
 * @param {android.net.Uri} uri - 本次唯一分享 URI
 * @returns {void}
 */
function verifySelectedMediaContentUri(uri) {
  if (!selectedExpectedSha256) return;
  var cursor = null;
  try {
    var columns = android.provider.MediaStore.MediaColumns;
    cursor = context.getContentResolver().query(uri, [columns.DATA, columns.SIZE], null, null, null);
    if (!cursor || Number(cursor.getCount()) !== 1 || !cursor.moveToFirst()) throw new Error("identity unavailable");
    var actual = new java.io.File(String(cursor.getString(0))).getCanonicalPath();
    var selected = new java.io.File(selectedMediaPath);
    if (String(actual) !== String(selected.getCanonicalPath()) || Number(cursor.getLong(1)) !== Number(selected.length())) {
      throw new Error("identity differs");
    }
  } catch (error) {
    throw taskError("MEDIA_URI_IDENTITY_UNVERIFIED", "The selected media URI identity could not be verified");
  } finally {
    if (cursor) cursor.close();
  }
}

/**
 * 通过 Android 分享 Intent 打开单个图片或视频编辑器。
 *
 * @returns {void}
 */
function openSelectedMediaInTikTok() {
  assertSelectedMediaIntegrity();
  var builder = new android.os.StrictMode.VmPolicy.Builder();
  android.os.StrictMode.setVmPolicy(builder.build());
  var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
  intent.setType(selectedMediaType === "video" ? "video/*" : "image/*");
  var mediaUri = getSelectedMediaContentUri();
  if (!mediaUri) {
    if (selectedExpectedSha256) throw taskError("MEDIA_URI_IDENTITY_UNVERIFIED", "Approved media needs a verifiable content URI");
    mediaUri = android.net.Uri.fromFile(new java.io.File(selectedMediaPath));
    warnings.push("LEGACY_FILE_URI_FALLBACK");
  }
  verifySelectedMediaContentUri(mediaUri);
  assertSelectedMediaIntegrity();
  intent.putExtra(android.content.Intent.EXTRA_STREAM, mediaUri);
  intent.setClipData(android.content.ClipData.newRawUri("TikTok media", mediaUri));
  intent.setPackage(TIKTOK_PACKAGE);
  intent.addFlags(
    android.content.Intent.FLAG_ACTIVITY_NEW_TASK |
      android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
  );
  app.startActivity(intent);
}

/**
 * 等待文案编辑页，最多跨过四个语义“下一步”页面。
 *
 * @returns {void}
 */
function reachCaptionEditor() {
  for (var i = 0; i < 4; i++) {
    assertNoBlockingChallenge();
    var inputs = getDistinctInputs();
    var post = findSemanticNode(["发布", "Post"], 250, true);
    if (inputs.length && post) return;
    var next = findSemanticNode(["下一步", "Next"], 5000, true);
    if (next && performSemanticClick(next)) pause(900, 1500);
  }
  throw taskError("EDITOR_NOT_READY", "TikTok caption editor did not become ready");
}

/**
 * 获取按纵向和横向排序、去除重复坐标的 TikTok 输入框。
 *
 * @returns {UiObject[]} 输入框数组
 */
function getDistinctInputs() {
  var nodes = packageName(TIKTOK_PACKAGE).className("android.widget.EditText").find();
  var distinct = [];
  var seen = {};
  for (var i = 0; nodes && i < nodes.length; i++) {
    var bounds = nodes[i].bounds();
    if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) continue;
    var key = bounds.left + ":" + bounds.top + ":" + bounds.right + ":" + bounds.bottom;
    if (!seen[key]) {
      seen[key] = true;
      distinct.push(nodes[i]);
    }
  }
  distinct.sort(function (a, b) {
    var first = a.bounds();
    var second = b.bounds();
    return first.top === second.top ? first.left - second.left : first.top - second.top;
  });
  return distinct;
}

/**
 * 计算 Unicode 码点数量，避免 emoji 的 UTF-16 代理对被计为两个字符。
 *
 * @param {string} value - 待统计文本
 * @returns {number} Unicode 字符数
 */
function unicodeCharacterCount(value) {
  var javaValue = new java.lang.String(String(value || ""));
  return Number(javaValue.codePointCount(0, javaValue.length()));
}

/**
 * 仅统一 Android 换行并去除不可见零宽字符，保留空格和换行语义用于全文校验。
 *
 * @param {*} value - 输入控件或目标文案
 * @returns {string} 可用于严格输入校验的文本
 */
function normalizeInputText(value) {
  return String(value || "").replace(/\r\n?/g, "\n").replace(/\u200b/g, "");
}

/**
 * 校验重新获取的输入控件包含完整目标文本及相同字符数。
 *
 * @param {UiObject|null} node - 重新获取的 TikTok 输入节点
 * @param {string} expected - 完整目标文本
 * @returns {boolean} 是否完整一致
 */
function inputContainsExactText(node, expected) {
  if (!node) return false;
  try {
    var actual = String(node.text() || "");
    return (
      normalizeInputText(actual) === normalizeInputText(expected) &&
      unicodeCharacterCount(actual) === unicodeCharacterCount(expected)
    );
  } catch (error) {
    return false;
  }
}

/**
 * 使用 UiObject.setText 写入图片标题并重新获取控件验证。
 *
 * @param {UiObject} node - TikTok 标题输入节点
 * @param {string} value - 完整标题
 * @param {Function} resolveNode - 重新获取标题控件的函数
 * @returns {boolean} 是否写入并验证成功
 */
function setAndVerifyTitle(node, value, resolveNode) {
  if (!node || !value) return true;
  try {
    node.click();
    pause(120, 220);
    if (!node.setText(value)) return false;
    pause(250, 450);
    return inputContainsExactText(resolveNode(), value);
  } catch (error) {
    return false;
  }
}

/**
 * 向当前已聚焦的 TikTok 输入控件发送 ADB Keyboard 全文替换广播。
 *
 * @param {string} value - 原样放入 text extra 的 Unicode 文本
 * @returns {boolean} 是否成功发出限定包广播
 */
function sendAdbKeyboardText(value) {
  if (currentPackage() !== TIKTOK_PACKAGE) return false;
  try {
    var intent = new android.content.Intent(ADB_KEYBOARD_SET_TEXT_ACTION);
    intent.setPackage(ADB_KEYBOARD_PACKAGE);
    intent.putExtra("text", String(value));
    context.sendBroadcast(intent);
    return currentPackage() === TIKTOK_PACKAGE;
  } catch (error) {
    return false;
  }
}

/**
 * 写入详情或视频单文案；UiObject 失败后仅使用 ADB Keyboard 包广播回退。
 *
 * @param {UiObject} node - TikTok 详情或单文案输入节点
 * @param {string} value - 完整目标文本
 * @param {Function} resolveNode - 重新获取目标控件的函数
 * @returns {boolean} 是否写入并验证成功
 */
function setAndVerifyLongCaption(node, value, resolveNode) {
  if (!node || !value) return true;
  try {
    node.click();
    pause(120, 220);
    if (node.setText(value)) {
      pause(250, 450);
      if (inputContainsExactText(resolveNode(), value)) return true;
    }
    var focused = resolveNode();
    if (!focused) return false;
    var focusedBounds = focused.bounds();
    if (
      !focusedBounds ||
      !click(focusedBounds.centerX(), focusedBounds.centerY())
    ) {
      return false;
    }
    pause(120, 220);
    focused = resolveNode();
    if (!focused || !focused.isFocused()) return false;
    if (!sendAdbKeyboardText(value)) return false;
    var endAt = Date.now() + Math.min(3500, remainingTaskMs());
    while (Date.now() < endAt) {
      pause(120, 220);
      if (inputContainsExactText(resolveNode(), value)) return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

/**
 * 识别图片发布页的标题和详情输入框；已知语义 ID 优先，控件高度仅作版本兼容兜底。
 *
 * @param {UiObject[]} inputs - 当前可见输入框
 * @returns {{title: UiObject, details: UiObject}|null} 唯一字段映射
 */
function identifyPhotoCaptionFields(inputs) {
  if (!inputs || inputs.length < 2) return null;
  var title = packageName(TIKTOK_PACKAGE)
    .id(TIKTOK_PACKAGE + ":id/h04")
    .findOne(180);
  var details = packageName(TIKTOK_PACKAGE)
    .id(TIKTOK_PACKAGE + ":id/h00")
    .findOne(180);
  if (title && details) return { title: title, details: details };
  var byHeight = inputs.slice().sort(function (a, b) {
    return a.bounds().height() - b.bounds().height();
  });
  if (byHeight[0].bounds().height() === byHeight[byHeight.length - 1].bounds().height()) {
    return null;
  }
  return { title: byHeight[0], details: byHeight[byHeight.length - 1] };
}

/**
 * 重新获取当前图片标题输入框。
 *
 * @returns {UiObject|null} 标题输入框
 */
function resolvePhotoTitleInput() {
  var fields = identifyPhotoCaptionFields(getDistinctInputs());
  return fields ? fields.title : null;
}

/**
 * 重新获取当前图片详情输入框。
 *
 * @returns {UiObject|null} 详情输入框
 */
function resolvePhotoDetailsInput() {
  var fields = identifyPhotoCaptionFields(getDistinctInputs());
  return fields ? fields.details : null;
}

/**
 * 重新获取当前视频单文案输入框。
 *
 * @returns {UiObject|null} 单文案输入框
 */
function resolveSingleCaptionInput() {
  var inputs = getDistinctInputs();
  return inputs.length ? inputs[0] : null;
}

/**
 * 写入标题和详情，并验证完整语义值。
 *
 * @returns {void}
 */
function enterAndVerifyCaption() {
  var inputs = getDistinctInputs();
  if (!inputs.length) throw taskError("CAPTION_FIELD_MISSING", "TikTok caption field was not found");
  var success = false;
  if (inputs.length >= 2 && (selectedTitle || selectedDetails)) {
    var fields = identifyPhotoCaptionFields(inputs);
    success = Boolean(fields);
    if (success && selectedDetails) {
      success = setAndVerifyLongCaption(
        fields.details,
        selectedDetails,
        resolvePhotoDetailsInput
      );
    }
    fields = identifyPhotoCaptionFields(getDistinctInputs());
    if (success && selectedTitle) {
      success = Boolean(
        fields && setAndVerifyTitle(fields.title, selectedTitle, resolvePhotoTitleInput)
      );
    }
    fields = identifyPhotoCaptionFields(getDistinctInputs());
    success =
      success &&
      Boolean(fields) &&
      (!selectedTitle || inputContainsExactText(fields.title, selectedTitle)) &&
      (!selectedDetails || inputContainsExactText(fields.details, selectedDetails));
  } else {
    success = setAndVerifyLongCaption(
      inputs[0],
      selectedCaption,
      resolveSingleCaptionInput
    );
  }
  if (!success) {
    throw taskError(
      "CAPTION_INPUT_FAILED",
      "TikTok caption input could not be verified exactly"
    );
  }
  assertNoBlockingChallenge();
}

/**
 * 获取可见作品卡片并按最上行、从左到右、多行顺序排序。
 *
 * @returns {UiObject[]} 排序后的作品节点
 */
function getSortedProfileTiles() {
  var nodes = packageName(TIKTOK_PACKAGE).id(TIKTOK_PACKAGE + ":id/tv_play_count").find();
  var tiles = [];
  var seen = {};
  for (var i = 0; nodes && i < nodes.length; i++) {
    var bounds = nodes[i].bounds();
    if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) continue;
    var key = Math.floor(bounds.centerX() / 10) + ":" + Math.floor(bounds.centerY() / 10);
    if (!seen[key]) {
      seen[key] = true;
      tiles.push(nodes[i]);
    }
  }
  tiles.sort(function (a, b) {
    var first = a.bounds();
    var second = b.bounds();
    var rowDelta = first.top - second.top;
    return Math.abs(rowDelta) < 30 ? first.left - second.left : rowDelta;
  });
  return tiles;
}

/**
 * 从作品节点点击其语义卡片。
 *
 * @param {UiObject} tile - 播放量节点
 * @returns {boolean} 是否点击成功
 */
function openProfileTile(tile) {
  return performSemanticClick(tile);
}

/**
 * 判断作品详情页是否包含精确的目标标题和详情。
 *
 * @returns {boolean} 是否匹配本次 publication 上下文
 */
function currentPostMatchesContent() {
  var nodes = packageName(TIKTOK_PACKAGE).className("android.widget.TextView").find();
  var texts = [];
  for (var i = 0; nodes && i < nodes.length; i++) {
    var value = normalizeText(nodes[i].text());
    if (value) texts.push(value);
  }
  var describedNodes = packageName(TIKTOK_PACKAGE).descMatches(".+").find();
  for (var describedIndex = 0; describedNodes && describedIndex < describedNodes.length; describedIndex++) {
    var description = normalizeText(describedNodes[describedIndex].desc());
    if (description) texts.push(description);
  }
  var caption = normalizeText(selectedCaption);
  var title = normalizeText(selectedTitle);
  var details = normalizeText(selectedDetails);
  var captionMatch = false;
  var titleMatch = !title;
  var detailsMatch = !details;
  for (var j = 0; j < texts.length; j++) {
    if (caption && (texts[j] === caption || texts[j].indexOf(caption) >= 0)) captionMatch = true;
    if (title && (texts[j] === title || texts[j].indexOf(title) >= 0)) titleMatch = true;
    if (details && (texts[j] === details || texts[j].indexOf(details) >= 0)) detailsMatch = true;
  }
  return captionMatch || (titleMatch && detailsMatch);
}

/**
 * 查找当前作品详情页右侧的语义分享按钮。
 *
 * @param {number} timeoutMs - 最大等待时间
 * @returns {UiObject|null} 分享按钮
 */
function findShareButton(timeoutMs) {
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    var pattern = "(?i).*(分享视频|分享照片|Share).*";
    var nodes = tikTokDescSelector(pattern).find();
    if (!nodes || !nodes.length) nodes = tikTokTextSelector(pattern).find();
    for (var i = 0; nodes && i < nodes.length; i++) {
      var bounds = nodes[i].bounds();
      if (bounds && bounds.centerX() > device.width * 0.65) return nodes[i];
    }
    sleep(250);
  }
  return null;
}

/**
 * 判断 TikTok 分享面板当前是否仍然打开。
 *
 * @returns {boolean} 分享面板是否打开
 */
function isShareSheetOpen() {
  return Boolean(
    findSemanticNode(["分享到", "Share to", "复制链接", "Copy link"], 120, false)
  );
}

/**
 * 判断主机名是否属于 TikTok。
 *
 * @param {string} host - URL 主机名
 * @returns {boolean} 是否为 TikTok 域名
 */
function isTikTokHost(host) {
  var normalized = String(host || "").toLowerCase();
  return normalized === "tiktok.com" || /\.tiktok\.com$/.test(normalized);
}

/**
 * 将 TikTok 规范链接清除查询参数并验证作品路径。
 *
 * @param {string} value - 候选 URL
 * @returns {Object|null} 规范链接信息
 */
function parseCanonicalPostUrl(value) {
  try {
    var parsed = new java.net.URL(String(value));
    if (!isTikTokHost(String(parsed.getHost()))) return null;
    var path = decodeURIComponent(String(parsed.getPath() || ""));
    var match = path.match(/^\/@([^/]+)\/(video|photo)\/(\d+)\/?$/i);
    if (!match) return null;
    return {
      canonicalUrl:
        "https://www.tiktok.com/@" + encodeURIComponent(match[1]) + "/" + match[2].toLowerCase() + "/" + match[3],
      postId: match[3],
      postType: match[2].toLowerCase(),
      handle: normalizeHandle(match[1])
    };
  } catch (error) {
    return null;
  }
}

/**
 * 在每一跳均校验 TikTok 域名后解析短链接。
 *
 * @param {string} value - 剪贴板中的 TikTok URL
 * @returns {Object|null} 最终规范作品链接
 */
function resolveTikTokUrl(value) {
  var current = String(value || "");
  for (var redirect = 0; redirect < 6; redirect++) {
    var canonical = parseCanonicalPostUrl(current);
    if (canonical) return canonical;
    var parsed;
    try {
      parsed = new java.net.URL(current);
    } catch (invalidUrl) {
      return null;
    }
    if (!isTikTokHost(String(parsed.getHost()))) return null;
    var connection = null;
    try {
      connection = parsed.openConnection();
      connection.setInstanceFollowRedirects(false);
      connection.setConnectTimeout(5000);
      connection.setReadTimeout(5000);
      connection.setRequestProperty("User-Agent", "Mozilla/5.0 (Android) TikTokLinkVerifier/1.0");
      connection.connect();
      var location = connection.getHeaderField("Location");
      if (!location) return null;
      current = String(new java.net.URL(parsed, String(location)).toString());
      var next = new java.net.URL(current);
      if (!isTikTokHost(String(next.getHost()))) return null;
    } catch (networkError) {
      return null;
    } finally {
      try {
        if (connection && connection.disconnect) connection.disconnect();
      } catch (ignoredDisconnect) {}
    }
  }
  return null;
}

/**
 * 从剪贴板文本中提取一个 TikTok URL。
 *
 * @param {string} clipboard - 剪贴板文本
 * @returns {string} URL 或空字符串
 */
function extractUrl(clipboard) {
  var match = String(clipboard || "").match(/https?:\/\/[^\s]+/i);
  return match ? match[0].replace(/[),，。]+$/, "") : "";
}

/**
 * 读取系统剪贴板，必要时短暂切到 AutoJS6 前台。
 *
 * @returns {string} 剪贴板文本
 */
function readClipboardText() {
  var value = String(getClip() || "");
  if (value) return value;
  app.launchPackage(AUTOJS_PACKAGE);
  pause(700, 1100);
  value = String(getClip() || "");
  app.launchPackage(TIKTOK_PACKAGE);
  pause(1100, 1700);
  return value;
}

/**
 * 使用分享面板中的语义“复制链接”动作获取当前作品链接。
 *
 * @param {number} maxAttempts - 最大尝试次数
 * @param {number} retryMs - 尝试间隔
 * @returns {Object|null} 规范作品链接
 */
function copyCurrentPostUrl(maxAttempts, retryMs) {
  var originalClipboard = String(getClip() || "");
  try {
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      assertNoBlockingChallenge();
      setClip("");
      var share = findShareButton(5000);
      if (!share || !performSemanticClick(share)) {
        throw taskError("SHARE_ACTION_MISSING", "TikTok share action was not found");
      }
      pause(900, 1500);
      var copy = findSemanticNode(["复制链接", "Copy link"], 3000, false);
      if (copy && performSemanticClick(copy)) {
        pause(800, 1300);
        var candidate = extractUrl(readClipboardText());
        var resolved = candidate ? resolveTikTokUrl(candidate) : null;
        if (resolved) return resolved;
      }
      if (currentPackage() === TIKTOK_PACKAGE && isShareSheetOpen()) back();
      if (attempt + 1 < maxAttempts) boundedSleep(retryMs);
    }
    return null;
  } finally {
    setClip(originalClipboard);
  }
}

/**
 * 从新版恢复上下文、检查点提示或旧字段加载发布上下文。
 *
 * @returns {Object} publicationId 对应的恢复上下文
 */
function loadRecoveryContext() {
  var contextValue =
    request.recoveryContext ||
    request.publicationContext ||
    (request.internalHints && request.internalHints.recoveryContext) ||
    request.internalHints ||
    {};
  var contextPublicationId = String(contextValue.publicationId || "").trim();
  var contextContent = contextValue.content || {};
  var contextMedia = contextValue.media || {};
  if (publicationId && contextPublicationId && publicationId !== contextPublicationId) {
    throw taskError(
      "PUBLICATION_CONTEXT_MISMATCH",
      "Recovery context does not belong to the requested publicationId"
    );
  }
  publicationId = publicationId || contextPublicationId;
  requestedPostSettings = normalizeRequestedPostSettings(contextValue.postSettings);
  postSettingsEvidence = validatedPostSettingsEvidence(contextValue.postSettingsEvidence);
  if (postSettingsEvidence && (!requestedPostSettings || !contextPublicationId)) {
    throw taskError("POST_SETTINGS_NOT_VERIFIED", "Settings evidence needs the original publication context");
  }
  selectedTitle = String(
    contextValue.title != null
      ? contextValue.title
      : contextContent.title != null
        ? contextContent.title
        : request.title || ""
  ).trim();
  selectedDetails = String(
    contextValue.details != null
      ? contextValue.details
      : contextContent.details != null
        ? contextContent.details
        : request.details || ""
  ).trim();
  selectedCaption = String(contextValue.caption || contextContent.caption || "").trim();
  if (!selectedCaption) {
    selectedCaption = selectedTitle && selectedDetails
      ? selectedTitle + "\n" + selectedDetails
      : selectedTitle || selectedDetails;
  }
  selectedMediaType = String(
    contextValue.mediaType || contextMedia.kind || request.mediaType || ""
  ).toLowerCase();
  baselinePostIds = contextValue.baselinePostIds || request.baselinePostIds || [];
  if (!(baselinePostIds instanceof Array)) baselinePostIds = [];
  var contextTileCount = contextValue.baselineTileCount;
  baselineTileCount =
    typeof contextTileCount === "number" && contextTileCount >= 0
      ? Math.floor(contextTileCount)
      : null;
  if (!contextValue.postId && contextValue.canonicalUrl) {
    var canonical = parseCanonicalPostUrl(String(contextValue.canonicalUrl));
    if (canonical) contextValue.postId = canonical.postId;
  }
  if (!publicationId) {
    throw taskError("PUBLICATION_ID_REQUIRED", "Recovery requires the original publicationId");
  }
  if (!selectedCaption && !contextValue.postId && !contextValue.canonicalUrl) {
    throw taskError("RECOVERY_CONTEXT_REQUIRED", "Recovery requires the original publication context");
  }
  return contextValue;
}

/**
 * 返回数组是否包含指定字符串。
 *
 * @param {Array} values - 字符串数组
 * @param {string} expected - 目标字符串
 * @returns {boolean} 是否包含
 */
function containsString(values, expected) {
  for (var i = 0; i < values.length; i++) {
    if (String(values[i]) === String(expected)) return true;
  }
  return false;
}

/**
 * 扫描本人主页作品，按发布上下文找到唯一作品。
 *
 * @param {Object} recoveryContext - publicationId 对应的恢复上下文
 * @returns {Object|null} 唯一匹配作品
 */
function findPublicationPost(recoveryContext) {
  var expectedPostId = String(recoveryContext.postId || "");
  var hasTrustedBaseline = baselineTileCount !== null;
  if (!expectedPostId && !hasTrustedBaseline) {
    throw taskError(
      "RECOVERY_BASELINE_REQUIRED",
      "Publication recovery requires a trusted pre-publish profile baseline"
    );
  }
  if (
    !expectedPostId &&
    baselineTileCount > 0 &&
    baselinePostIds.length < baselineTileCount
  ) {
    throw taskError(
      "RECOVERY_BASELINE_INCOMPLETE",
      "Publication recovery baseline is incomplete"
    );
  }
  var matches = [];
  var matchedPostIds = {};
  var unresolvedContentMatches = 0;
  var unresolvedLinkCandidates = 0;
  var visited = {};
  var maxPosts = boundedNumber(request.scanMaxPosts, 3, 18, 12);
  var maxPages = boundedNumber(request.scanMaxPages, 1, 5, 3);
  for (var page = 0; page < maxPages && Object.keys(visited).length < maxPosts; page++) {
    var tiles = getSortedProfileTiles();
    for (var index = 0; index < tiles.length && Object.keys(visited).length < maxPosts; index++) {
      tiles = getSortedProfileTiles();
      if (index >= tiles.length) break;
      var bounds = tiles[index].bounds();
      var visibleKey = page + ":" + index + ":" + bounds.top + ":" + bounds.left;
      if (visited[visibleKey]) continue;
      visited[visibleKey] = true;
      if (!openProfileTile(tiles[index])) continue;
      pause(1100, 1700);
      assertNoBlockingChallenge();
      var contentMatched = currentPostMatchesContent();
      if (contentMatched || expectedPostId || hasTrustedBaseline) {
        var linkPolicy = request.link || {};
        var contentLinkAttempts = boundedNumber(
          linkPolicy.maxAttempts || request.linkMaxAttempts,
          1,
          8,
          8
        );
        var contentLinkRetryMs =
          boundedNumber(linkPolicy.retrySeconds || request.linkRetrySeconds, 2, 30, 15) * 1000;
        var link = copyCurrentPostUrl(
          contentMatched || hasTrustedBaseline ? contentLinkAttempts : 1,
          contentMatched || hasTrustedBaseline ? contentLinkRetryMs : 0
        );
        if (link) {
          var accountMatched = !profileHandle || !link.handle || link.handle === profileHandle;
          var baseline = containsString(baselinePostIds, link.postId);
          var typeMatched = !selectedMediaType || link.postType === selectedMediaType ||
            (selectedMediaType === "image" && link.postType === "photo");
          if (
            accountMatched &&
            typeMatched &&
            !baseline &&
            ((expectedPostId && link.postId === expectedPostId) ||
              (!expectedPostId && (contentMatched || hasTrustedBaseline)))
          ) {
            if (!matchedPostIds[link.postId]) {
              matchedPostIds[link.postId] = true;
              matches.push(link);
            }
          }
        } else if (!expectedPostId) {
          if (contentMatched) unresolvedContentMatches++;
          if (hasTrustedBaseline) unresolvedLinkCandidates++;
        }
      }
      back();
      pause(700, 1100);
      if (!isOwnProfileGrid()) navigateToAndVerifyProfile();
    }
    if (matches.length > 1 || (expectedPostId && matches.length)) break;
    swipe(
      Math.floor(device.width * 0.5),
      Math.floor(device.height * 0.78),
      Math.floor(device.width * 0.5),
      Math.floor(device.height * 0.42),
      500
    );
    pause(900, 1300);
  }
  if (matches.length > 1) {
    throw taskError("PUBLICATION_AMBIGUOUS", "More than one post matches the publication context");
  }
  if (matches.length && unresolvedLinkCandidates) {
    throw taskError(
      "PUBLICATION_AMBIGUOUS",
      "A candidate post was found while another visible post link remained unresolved"
    );
  }
  if (matches.length && unresolvedContentMatches) {
    throw taskError("PUBLICATION_AMBIGUOUS", "Publication context has unresolved duplicate matches");
  }
  if (matches.length === 1 || (matches.length === 0 && unresolvedContentMatches === 1)) {
    postConfirmed = true;
  }
  if (unresolvedContentMatches > 1) {
    throw taskError("PUBLICATION_AMBIGUOUS", "More than one visible post matches the publication context");
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * 采集发布前可见作品 ID，用于排除置顶和旧作品。
 *
 * @returns {{postIds: string[], tileCount: number}} 发布前作品基线
 */
function captureBaselinePostIds() {
  var originalClipboard = String(getClip() || "");
  var ids = [];
  var limit = boundedNumber(request.baselineMaxPosts, 3, 9, 6);
  try {
    var tiles = getSortedProfileTiles();
    var tileCount = Math.min(tiles.length, limit);
    for (var i = 0; i < tileCount; i++) {
      if (!openProfileTile(tiles[i])) {
        throw taskError(
          "BASELINE_CAPTURE_FAILED",
          "A visible profile post could not be opened before publishing"
        );
      }
      pause(900, 1400);
      var link = null;
      try {
        link = copyCurrentPostUrl(3, 1200);
      } catch (linkError) {
        throw taskError(
          "BASELINE_CAPTURE_FAILED",
          "A visible profile post link could not be read before publishing"
        );
      }
      if (!link || (profileHandle && link.handle !== profileHandle)) {
        throw taskError(
          "BASELINE_CAPTURE_FAILED",
          "A visible profile post could not be identified before publishing"
        );
      }
      if (!containsString(ids, link.postId)) ids.push(link.postId);
      back();
      pause(650, 950);
      if (!isOwnProfileGrid()) navigateToAndVerifyProfile();
      tiles = getSortedProfileTiles();
    }
    if (ids.length !== tileCount) {
      throw taskError(
        "BASELINE_CAPTURE_FAILED",
        "The pre-publish profile baseline contained duplicate or missing post IDs"
      );
    }
    return { postIds: ids, tileCount: tileCount };
  } finally {
    setClip(originalClipboard);
  }
}

/**
 * 在本人主页执行一次有界下拉刷新。
 *
 * @returns {void}
 */
function refreshProfileGrid() {
  if (!isOwnProfileGrid()) return;
  swipe(
    Math.floor(device.width * 0.5),
    Math.floor(device.height * 0.34),
    Math.floor(device.width * 0.5),
    Math.floor(device.height * 0.72),
    500
  );
  pause(1300, 2100);
  assertNoBlockingChallenge();
}

/**
 * 等待点击发布后的页面离开编辑器并检测明确失败。
 *
 * @returns {void}
 */
function waitForSubmission() {
  var timeoutMs = boundedNumber(request.uploadWaitMs, 15000, 120000, 90000);
  var endAt = Date.now() + Math.min(timeoutMs, remainingTaskMs());
  while (Date.now() < endAt) {
    assertNoBlockingChallenge();
    if (
      tikTokTextSelector("(?i).*(上传失败|发布失败|Couldn't upload|Post failed|Upload failed).*").exists()
    ) {
      throw taskError("UPLOAD_FAILED", "TikTok reported that the post upload failed");
    }
    if (findProfileTab(250)) return;
    sleep(700);
  }
  throw taskError("PUBLISH_OUTCOME_UNKNOWN", "TikTok did not confirm submission before the deadline");
}

/**
 * 构造统一任务数据。
 *
 * @param {string} outcome - CONFIRMED、PENDING、UNKNOWN 或 NOT_PUBLISHED
 * @param {boolean} wasPublished - 是否确认已发布
 * @param {boolean} retrySafe - 是否可安全重新执行 publish
 * @param {string} nextAction - 建议下一操作
 * @param {Object|null} post - 作品链接信息
 * @param {Object|null} error - 错误信息
 * @returns {Object} 统一结果数据
 */
function buildResult(outcome, wasPublished, retrySafe, nextAction, post, error) {
  var normalizedPost = post
    ? {
        shareUrl: post.canonicalUrl,
        canonicalUrl: post.canonicalUrl,
        postId: post.postId,
        postType: post.postType,
        verified: true
      }
    : {
        shareUrl: "",
        canonicalUrl: "",
        postId: "",
        postType: selectedMediaType === "image" ? "photo" : selectedMediaType,
        verified: false
      };
  var result = {
    contractVersion: contractVersion >= 2 ? 2 : 1,
    action: action,
    publicationId: publicationId,
    phase: phase,
    outcome: outcome,
    published: wasPublished,
    retrySafe: retrySafe,
    nextAction: nextAction,
    account: { verified: Boolean(profileHandle), matched: Boolean(profileHandle) },
    media: {
      kind: selectedMediaType,
      metadata: selectedMediaMetadata
    },
    post: normalizedPost,
    warnings: warnings,
    baselinePostIds: baselinePostIds,
    baselineTileCount: baselineTileCount,
    error: error,
    success: outcome === "CONFIRMED" || outcome === "READY" || outcome === "FOUND",
    postUrl: normalizedPost.canonicalUrl,
    mediaType: selectedMediaType
  };
  if (postSettingsEvidence) result.postSettingsEvidence = postSettingsEvidence;
  return result;
}

/**
 * 设置脚本成功终态。
 *
 * @param {string} code - 稳定成功码
 * @param {string} message - 成功说明
 * @param {Object} data - 结果数据
 * @returns {void}
 */
function finishSuccess(code, message, data) {
  taskStatus = "SUCCESS";
  taskCode = code;
  taskMessage = message;
  taskResult = JSON.stringify(data);
}

/**
 * 设置脚本失败终态。
 *
 * @param {string} code - 稳定失败码
 * @param {string} message - 失败说明
 * @param {Object} data - 结果数据
 * @returns {void}
 */
function finishFailure(code, message, data) {
  taskStatus = "FAILURE";
  taskCode = code;
  taskMessage = message;
  taskResult = JSON.stringify(data);
}

/**
 * 执行无发布副作用的环境预检。
 *
 * @returns {void}
 */
function runPreflight() {
  phase = "PREFLIGHT";
  prepareSelectedContent();
  launchTikTok(10000);
  navigateToAndVerifyProfile();
  phase = "READY";
  finishSuccess(
    "PREFLIGHT_OK",
    "TikTok preflight passed",
    buildResult("READY", false, true, "publish", null, null)
  );
}

/**
 * 执行单图片或单视频的直接发布。
 *
 * @returns {void}
 */
function runPublish() {
  if (contractVersion >= 2 && !publicationId) {
    throw taskError("PUBLICATION_ID_REQUIRED", "Publish requires publicationId");
  }
  prepareSelectedContent();
  phase = "VERIFYING_ACCOUNT";
  launchTikTok(10000);
  navigateToAndVerifyProfile();
  phase = "CAPTURING_BASELINE";
  var baseline = captureBaselinePostIds();
  baselinePostIds = baseline.postIds;
  baselineTileCount = baseline.tileCount;
  phase = "OPENING_EDITOR";
  openSelectedMediaInTikTok();
  pause(3500, 5000);
  reachCaptionEditor();
  phase = "EDITOR_READY";
  enterAndVerifyCaption();
  assertNoBlockingChallenge();
  applyRequestedPostSettings(false);
  writeCheckpoint("EDITOR_READY", null);
  waitForCheckpointAck("EDITOR_READY");
  applyRequestedPostSettings(true);
  assertSelectedMediaIntegrity();
  assertNoBlockingChallenge();
  var postButton = findSemanticNode(["发布", "Post"], 8000, true);
  if (!postButton) throw taskError("POST_ACTION_MISSING", "TikTok Post action was not found");
  if (remainingTaskMs() < 120000) {
    throw taskError(
      "INSUFFICIENT_COMMIT_TIME",
      "Less than 120 seconds remain; publish was not started"
    );
  }
  phase = "COMMITTING";
  writeCheckpoint("COMMITTING", null);
  waitForCheckpointAck("COMMITTING");
  if (!clickSemanticCenterOnce(postButton)) {
    throw taskError("POST_ACTION_FAILED", "TikTok Post action could not be activated");
  }
  submitted = true;
  phase = "SUBMITTED";
  writeCheckpoint("SUBMITTED", null);
  waitForSubmission();
  phase = "LOCATING_PUBLICATION";
  navigateToAndVerifyProfile();
  refreshProfileGrid();
  var contextValue = {
    publicationId: publicationId,
    title: selectedTitle,
    details: selectedDetails,
    caption: selectedCaption,
    mediaType: selectedMediaType,
    baselinePostIds: baselinePostIds,
    baselineTileCount: baselineTileCount
  };
  var post = findPublicationPost(contextValue);
  if (!post) {
    phase = postConfirmed ? "LINK_PENDING" : "SUBMITTED";
    finishFailure(
      postConfirmed ? "PUBLISHED_LINK_PENDING" : "PUBLISH_OUTCOME_UNKNOWN",
      postConfirmed
        ? "Post was submitted but its verified link is not available yet"
        : "TikTok publish was submitted but the resulting post could not be verified",
      buildResult(postConfirmed ? "PENDING" : "UNKNOWN", postConfirmed, false, "recover", null, {
        code: postConfirmed ? "PUBLISHED_LINK_PENDING" : "PUBLISH_OUTCOME_UNKNOWN",
        message: postConfirmed
          ? "Verified post link is pending"
          : "Submitted post was not uniquely visible"
      })
    );
    return;
  }
  postConfirmed = true;
  phase = "LINK_CONFIRMED";
  writeCheckpoint("SUBMITTED", {
    postId: post.postId
  });
  finishSuccess(
    "POST_CONFIRMED",
    "TikTok post and canonical link were verified",
    buildResult("CONFIRMED", true, false, "none", post, null)
  );
}

/**
 * 按 publicationId 恢复上下文查询作品，recover 额外返回规范链接。
 *
 * @returns {void}
 */
function runRecoveryOrStatus() {
  var contextValue = loadRecoveryContext();
  phase = "VERIFYING_ACCOUNT";
  launchTikTok(10000);
  navigateToAndVerifyProfile();
  phase = "LOCATING_PUBLICATION";
  refreshProfileGrid();
  var post = findPublicationPost(contextValue);
  if (!post) {
    if (postConfirmed && action === "status") {
      phase = "FOUND";
      finishSuccess(
        "PUBLICATION_FOUND",
        "TikTok publication is visible; canonical link is still pending",
        buildResult("FOUND", true, false, "recover", null, null)
      );
      return;
    }
    phase = postConfirmed ? "LINK_PENDING" : "NOT_FOUND";
    finishFailure(
      postConfirmed ? "PUBLISHED_LINK_PENDING" : "PUBLICATION_NOT_FOUND",
      postConfirmed
        ? "Publication is visible but its canonical link is still pending"
        : "No unique post matched the original publication context",
      buildResult("PENDING", postConfirmed, false, "recover", null, {
        code: postConfirmed ? "PUBLISHED_LINK_PENDING" : "PUBLICATION_NOT_FOUND",
        message: postConfirmed
          ? "Verified post link is pending"
          : "Publication is not yet visible or uniquely identifiable"
      })
    );
    return;
  }
  phase = action === "status" ? "FOUND" : "LINK_CONFIRMED";
  finishSuccess(
    action === "status" ? "PUBLICATION_FOUND" : "POST_LINK_RECOVERED",
    action === "status" ? "TikTok publication was found" : "TikTok canonical link was recovered",
    buildResult(action === "status" ? "FOUND" : "CONFIRMED", true, false, "none", post, null)
  );
}

try {
  action = normalizeAction(request);
  reportProgress("Starting action " + action + ".");
  waitForAccessibility(10000);
  if (!isTikTokInstalled()) throw taskError("TIKTOK_NOT_INSTALLED", "TikTok is not installed");
  startUiErrorMonitor();
  if (action === "preflight") runPreflight();
  else if (action === "publish") runPublish();
  else runRecoveryOrStatus();
} catch (error) {
  var code = String(error && error.code ? error.code : "TIKTOK_AUTOMATION_FAILED");
  var message = String(error && error.message ? error.message : "TikTok automation failed");
  var causeCode = code;
  var outcome = postConfirmed
    ? "PENDING"
    : submitted || phase === "COMMITTING"
      ? "UNKNOWN"
      : "NOT_PUBLISHED";
  var wasPublished = postConfirmed;
  var retrySafe = !submitted && phase !== "COMMITTING";
  var nextAction = submitted || phase === "COMMITTING" ? "recover" : "publish";
  if (action === "recover" || action === "status") {
    outcome = "PENDING";
    retrySafe = false;
    nextAction =
      code === "RECOVERY_BASELINE_REQUIRED" || code === "RECOVERY_BASELINE_INCOMPLETE"
        ? "manual_review"
        : "recover";
  } else if (postConfirmed) {
    code = "PUBLISHED_LINK_PENDING";
    message = "Post was submitted but its verified link is not available yet";
    retrySafe = false;
    nextAction = "recover";
  } else if ((submitted || phase === "COMMITTING") && code !== "PUBLISHED_LINK_PENDING") {
    code = "PUBLISH_OUTCOME_UNKNOWN";
    message = "TikTok publish crossed the commit boundary; do not retry publish";
    retrySafe = false;
    nextAction = "recover";
  }
  finishFailure(
    code,
    message,
    buildResult(outcome, wasPublished, retrySafe, nextAction, null, {
      code: code,
      message: message,
      causeCode: causeCode === code ? undefined : causeCode
    })
  );
}
stopUiErrorMonitor();
