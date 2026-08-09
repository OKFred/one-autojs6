auto.waitFor();

var request = {{requestJson}};
var packageName = "com.zhiliaoapp.musically";
var statePath = "/sdcard/Download/tiktok_post_state.json";
var phase = "initializing";
var selectedMediaPath = "";
var selectedMediaType = "";
var selectedTitle = "";
var selectedDetails = "";
var selectedCaption = "";
var profileHandle = "";
var published = false;

/**
 * 输出脚本执行阶段。
 *
 * @param {string} message - 阶段说明
 */
function reportProgress(message) {
    console.log("[TikTok] " + message);
}

/**
 * 在指定范围内随机暂停，吸收页面渲染时间波动。
 *
 * @param {number} minMs - 最短毫秒数
 * @param {number} maxMs - 最长毫秒数
 */
function pause(minMs, maxMs) {
    sleep(random(minMs, maxMs));
}

/**
 * 点击控件自身、可点击父级或控件中心坐标。
 *
 * @param {UiObject} uiObject - 目标控件
 * @returns {boolean} 是否成功发起点击
 */
function performClick(uiObject) {
    if (!uiObject) return false;
    var current = uiObject;
    while (current && !current.isClickable()) current = current.parent();
    if (current && current.click()) return true;
    var bounds = uiObject.bounds();
    if (bounds && bounds.centerX() > 0 && bounds.centerY() > 0) {
        return click(bounds.centerX(), bounds.centerY());
    }
    return false;
}

/**
 * 转义选择器正则中的特殊字符。
 *
 * @param {string} value - 原始文本
 * @returns {string} 可安全拼入正则的文本
 */
function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 按文本或无障碍描述查找并点击控件。
 *
 * @param {string[]} keywords - 中英文候选文案
 * @param {number} timeoutMs - 总查找时长
 * @param {boolean} exact - 是否要求完整匹配
 * @returns {boolean} 是否点击成功
 */
function findAndClick(keywords, timeoutMs, exact) {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
        for (var i = 0; i < keywords.length; i++) {
            var escaped = escapeRegex(keywords[i]);
            var pattern = exact ? "(?i)^" + escaped + "$" : "(?i).*" + escaped + ".*";
            var target = textMatches(pattern).findOne(80) || descMatches(pattern).findOne(80);
            if (target && performClick(target)) {
                reportProgress("Clicked: " + keywords[i]);
                pause(700, 1400);
                return true;
            }
        }
        sleep(250);
    }
    return false;
}

/**
 * 关闭不影响发布流程的弹窗。
 */
function dismissTransientDialogs() {
    findAndClick(["暂时不要", "以后再说", "Not now", "Maybe later", "Later"], 500, true);
    if (textContains("及时接收新互动的通知").exists() || textContains("开启通知，第一时间").exists()) {
        var notificationClose = id(packageName + ":id/e62").findOne(300);
        if (notificationClose) performClick(notificationClose);
        pause(500, 900);
    }
}

/**
 * 读取本机 TikTok 发布历史。
 *
 * @returns {Object} 发布历史状态
 */
function loadState() {
    var emptyState = { posts: [], materialUses: {}, captionUses: {} };
    if (!files.exists(statePath)) return emptyState;
    try {
        var parsed = JSON.parse(files.read(statePath));
        parsed.posts = parsed.posts || [];
        parsed.materialUses = parsed.materialUses || {};
        parsed.captionUses = parsed.captionUses || {};
        return parsed;
    } catch (error) {
        reportProgress("History file is invalid; starting with empty history.");
        return emptyState;
    }
}

/**
 * 写入裁剪后的本机发布历史。
 *
 * @param {Object} state - 发布历史状态
 */
function saveState(state) {
    state.posts = state.posts.slice(-100);
    files.write(statePath, JSON.stringify(state));
}

/**
 * 执行发布间隔和单日发布量保护。
 *
 * @param {Object} state - 发布历史状态
 */
function enforcePostingLimits(state) {
    var now = Date.now();
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var todayCount = 0;
    var lastPublishedAt = 0;
    for (var i = 0; i < state.posts.length; i++) {
        var publishedAt = Number(state.posts[i].publishedAt || 0);
        if (publishedAt >= today.getTime()) todayCount++;
        if (publishedAt > lastPublishedAt) lastPublishedAt = publishedAt;
    }
    if (request.maxPostsPerDay > 0 && todayCount >= request.maxPostsPerDay) {
        throw new Error("Daily post limit reached: " + todayCount + "/" + request.maxPostsPerDay);
    }
    var elapsedSeconds = Math.floor((now - lastPublishedAt) / 1000);
    if (lastPublishedAt > 0 && request.minIntervalSeconds > 0 && elapsedSeconds < request.minIntervalSeconds) {
        throw new Error("Post cooldown active; retry after " + (request.minIntervalSeconds - elapsedSeconds) + " seconds");
    }
}

/**
 * 判断文件是否为支持轮换的图片或视频素材。
 *
 * @param {string} filePath - 文件路径
 * @returns {boolean} 是否可作为发布素材
 */
function isSupportedMedia(filePath) {
    return /\.(jpe?g|png|webp|mp4|mov|m4v)$/i.test(filePath) && filePath.indexOf("tiktok_auto_upload_tmp") < 0;
}

/**
 * 去重并移除不存在的素材路径。
 *
 * @param {string[]} paths - 候选素材路径
 * @returns {string[]} 有效且唯一的路径
 */
function uniqueExistingMedia(paths) {
    var seen = {};
    var result = [];
    for (var i = 0; i < paths.length; i++) {
        var filePath = String(paths[i] || "").trim();
        if (filePath && !seen[filePath] && isSupportedMedia(filePath) && files.exists(filePath)) {
            seen[filePath] = true;
            result.push(filePath);
        }
    }
    return result;
}

/**
 * 收集请求显式指定和素材目录中的图片或视频。
 *
 * @returns {string[]} 候选素材路径
 */
function collectMaterialCandidates() {
    if (request.videoPath) return uniqueExistingMedia([request.videoPath]);
    if (request.imagePath) return uniqueExistingMedia([request.imagePath]);
    var candidates = (request.imagePaths || []).concat(request.videoPaths || []);
    var materialDir = String(request.materialDir || "");
    if (!candidates.length && materialDir && files.exists(materialDir) && files.isDir(materialDir)) {
        var names = files.listDir(materialDir, function(name) {
            return isSupportedMedia(name);
        }) || [];
        for (var i = 0; i < names.length; i++) candidates.push(files.join(materialDir, names[i]));
    }
    return uniqueExistingMedia(candidates);
}

/**
 * 从候选项中选择最久未使用的一项，并对并列项随机化。
 *
 * @param {string[]} candidates - 候选字符串
 * @param {Object} uses - 字符串到最后使用时间的映射
 * @returns {string} 被选中的字符串
 */
function chooseLeastRecentlyUsed(candidates, uses) {
    if (!candidates.length) return "";
    var oldest = Number.MAX_SAFE_INTEGER;
    var oldestCandidates = [];
    for (var i = 0; i < candidates.length; i++) {
        var usedAt = Number(uses[candidates[i]] || 0);
        if (usedAt < oldest) {
            oldest = usedAt;
            oldestCandidates = [candidates[i]];
        } else if (usedAt === oldest) {
            oldestCandidates.push(candidates[i]);
        }
    }
    return oldestCandidates[random(0, oldestCandidates.length - 1)];
}

/**
 * 从标题和详情候选池生成本次发布文本。
 *
 * @param {Object} state - 发布历史状态
 * @returns {Object} 标题、详情和合并文案
 */
function chooseCaption(state) {
    var titleCandidates = (request.titles || []).slice();
    var detailCandidates = (request.detailsPool || []).slice();
    if (request.title) titleCandidates.push(request.title);
    if (request.details) detailCandidates.push(request.details);
    if (!titleCandidates.length) titleCandidates.push("");
    if (!detailCandidates.length) detailCandidates.push("");
    var combinations = [];
    for (var i = 0; i < titleCandidates.length; i++) {
        for (var j = 0; j < detailCandidates.length; j++) {
            var titleValue = String(titleCandidates[i] || "").trim();
            var detailValue = String(detailCandidates[j] || "").trim();
            var captionValue = titleValue && detailValue ? titleValue + "\n" + detailValue : titleValue || detailValue;
            if (captionValue) combinations.push(JSON.stringify({ title: titleValue, details: detailValue, caption: captionValue }));
        }
    }
    var serialized = chooseLeastRecentlyUsed(combinations, state.captionUses);
    if (!serialized) throw new Error("No usable title or details supplied");
    return JSON.parse(serialized);
}

/**
 * 通过 Android 分享 Intent 将指定图片或视频交给 TikTok。
 *
 * @param {string} mediaPath - 媒体文件绝对路径
 */
function openMediaInTikTok(mediaPath) {
    var builder = new android.os.StrictMode.VmPolicy.Builder();
    android.os.StrictMode.setVmPolicy(builder.build());
    var intent = new android.content.Intent(android.content.Intent.ACTION_SEND);
    var isVideo = /\.(mp4|mov|m4v)$/i.test(mediaPath);
    intent.setType(isVideo ? "video/*" : "image/*");
    intent.putExtra(android.content.Intent.EXTRA_STREAM, android.net.Uri.fromFile(new java.io.File(mediaPath)));
    intent.setPackage(packageName);
    intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK | android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION);
    app.startActivity(intent);
}

/**
 * 等待进入文案编辑页，并跨过可能存在的多个下一步页面。
 */
function reachCaptionEditor() {
    for (var i = 0; i < 4; i++) {
        dismissTransientDialogs();
        if (className("android.widget.EditText").exists() || textMatches("(?i)^(发布|Post)$").exists()) return;
        findAndClick(["下一步", "Next"], 6000, true);
        pause(1200, 2200);
    }
    if (!className("android.widget.EditText").exists()) throw new Error("Caption editor did not appear");
}

/**
 * 稳定设置单个输入控件并验证非空结果。
 *
 * @param {UiObject} node - 输入控件
 * @param {string} value - 待输入文本
 * @returns {boolean} 输入是否成功
 */
function setInputText(node, value) {
    if (!node || !value) return true;
    try {
        node.click();
        pause(250, 500);
        node.setText(value);
        pause(350, 650);
        if (String(node.text() || "").indexOf(value.substring(0, Math.min(8, value.length))) >= 0) return true;
        setText(value);
        pause(350, 650);
        return String(node.text() || "").length > 0;
    } catch (error) {
        return false;
    }
}

/**
 * 获取按屏幕纵向排序、且坐标不重复的可编辑输入框。
 * TikTok 部分版本会给同一输入框暴露多个不同 id 的无障碍节点。
 *
 * @returns {UiObject[]} 去重后的输入框
 */
function getDistinctInputs() {
    var nodes = className("android.widget.EditText").find();
    var distinct = [];
    var seen = {};
    for (var i = 0; nodes && i < nodes.length; i++) {
        var bounds = nodes[i].bounds();
        if (!bounds || bounds.width() <= 0 || bounds.height() <= 0) continue;
        var key = [bounds.left, bounds.top, bounds.right, bounds.bottom].join(":");
        if (seen[key]) continue;
        seen[key] = true;
        distinct.push(nodes[i]);
    }
    distinct.sort(function (a, b) {
        var aBounds = a.bounds();
        var bBounds = b.bounds();
        return aBounds.top === bBounds.top ? aBounds.left - bBounds.left : aBounds.top - bBounds.top;
    });
    return distinct;
}

/**
 * 根据页面输入框数量写入标题和详情。
 */
function enterCaption() {
    var inputs = getDistinctInputs();
    if (!inputs || inputs.length === 0) throw new Error("No editable caption field found");
    var success;
    if (inputs.length >= 2 && selectedTitle && selectedDetails) {
        // TikTok may auto-generate/overwrite the title when details are entered,
        // so details must be written first and the title must be the final write.
        success = setInputText(inputs[inputs.length - 1], selectedDetails);
        inputs = getDistinctInputs();
        success = success && inputs.length >= 2 && setInputText(inputs[0], selectedTitle);
    } else {
        success = setInputText(inputs[0], selectedCaption);
    }
    if (!success) throw new Error("TikTok caption input could not be verified");
    click(device.width / 2, Math.floor(device.height * 0.18));
    pause(700, 1200);
}

/**
 * 查找位于屏幕底部的当前账号主页导航按钮。
 *
 * @param {number} timeoutMs - 查找时长
 * @returns {UiObject|null} 匹配的底部导航控件
 */
function findProfileTab(timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
        var nodes = descMatches("(?i)^(主页|个人主页|Profile|我)$").find();
        for (var i = 0; nodes && i < nodes.length; i++) {
            if (nodes[i].bounds().bottom > device.height * 0.85) return nodes[i];
        }
        sleep(300);
    }
    return null;
}

/**
 * 判断 TikTok 作品分享面板是否仍覆盖在当前页面上。
 *
 * @returns {boolean} 分享面板是否打开
 */
function isShareSheetOpen() {
    return textMatches("(?i)^(分享到|Share to)$").exists() || textContains("复制链接").exists() || textContains("Copy link").exists();
}

/**
 * 等待发布页退出并检测明显上传错误。
 */
function waitForPublishCompletion() {
    pause(7000, 9000);
    var start = Date.now();
    while (Date.now() - start < 90000) {
        dismissTransientDialogs();
        if (textMatches("(?i).*(上传失败|发布失败|Couldn't upload|Post failed|重试).*").exists()) {
            throw new Error("TikTok reported an upload failure");
        }
        if (findProfileTab(300)) {
            published = true;
            return;
        }
        sleep(1200);
    }
    throw new Error("Timed out waiting for TikTok upload completion");
}

/**
 * 打开当前账号个人主页。
 */
function navigateToProfile() {
    if (isShareSheetOpen()) {
        back();
        pause(900, 1500);
    }
    if (!isOnOwnProfileGrid() && descMatches("(?i).*(分享视频|Share).*").exists() && (desc("返回").exists() || desc("Back").exists())) {
        back();
        pause(1800, 2800);
    }
    if (!isOnOwnProfileGrid()) {
        var profileTab = findProfileTab(8000);
        if (!profileTab || !performClick(profileTab)) throw new Error("Profile navigation button not found");
        pause(3000, 5000);
    }
    dismissTransientDialogs();
    swipe(device.width / 2, Math.floor(device.height * 0.35), device.width / 2, Math.floor(device.height * 0.72), 550);
    pause(3000, 5000);
    var handleNode = id(packageName + ":id/se1").findOne(3000);
    if (handleNode) profileHandle = String(handleNode.text() || "").replace(/^@/, "").trim();
    if (!profileHandle) throw new Error("Current TikTok profile handle could not be read");
}

/**
 * 判断当前页面是否仍是当前账号的个人主页。
 *
 * @returns {boolean} 是否处于个人主页网格页
 */
function isOnOwnProfileGrid() {
    return id(packageName + ":id/se1").exists() && id(packageName + ":id/tv_play_count").exists();
}

/**
 * 点击个人主页第一格作品的可点击卡片。
 *
 * @returns {boolean} 是否成功发起点击
 */
function clickLatestProfileTile() {
    var playCounts = id(packageName + ":id/tv_play_count").find();
    if (!playCounts || playCounts.length === 0) return false;
    var first = playCounts[0];
    for (var i = 1; i < playCounts.length; i++) {
        if (playCounts[i].bounds().left < first.bounds().left) first = playCounts[i];
    }
    var current = first;
    while (current && !current.isClickable()) current = current.parent();
    if (current && performClick(current)) return true;
    var bounds = first.bounds();
    return click(bounds.centerX(), Math.max(Math.floor(device.height * 0.42), bounds.top - 160));
}

/**
 * 校验打开的作品确实包含本次发布文案。
 *
 * @returns {boolean} 是否为本次发布的作品
 */
function isExpectedPublishedPost() {
    var markers = [selectedTitle, selectedDetails];
    var captionMatched = false;
    for (var i = 0; i < markers.length; i++) {
        if (!markers[i]) continue;
        var marker = markers[i].substring(0, Math.min(markers[i].length, 32));
        if (textContains(marker).exists()) {
            captionMatched = true;
            break;
        }
    }
    return captionMatched && descMatches("(?i).*(分享视频|Share).*").exists();
}

/**
 * 打开个人主页最新作品，并严格核对本次发布文案。
 */
function openLatestPost() {
    for (var attempt = 0; attempt < 3; attempt++) {
        if (!isOnOwnProfileGrid()) throw new Error("Left the current account profile before opening the latest post");
        if (!clickLatestProfileTile()) throw new Error("Latest profile tile could not be clicked");
        pause(2200, 3400);
        if (isExpectedPublishedPost()) return;
        if (desc("返回").exists() || desc("Back").exists()) {
            back();
            pause(1200, 1800);
        }
    }
    throw new Error("Latest profile post did not match the submitted caption");
}

/**
 * 查找当前作品右侧的分享按钮。
 *
 * @param {number} timeoutMs - 查找时长
 * @returns {UiObject|null} 分享按钮
 */
function findShareButton(timeoutMs) {
    var start = Date.now();
    while (Date.now() - start < timeoutMs) {
        var nodes = descMatches("(?i).*(分享视频|Share).*").find();
        for (var i = 0; nodes && i < nodes.length; i++) {
            var bounds = nodes[i].bounds();
            if (bounds.centerX() > device.width * 0.72 && bounds.centerY() > device.height * 0.35) return nodes[i];
        }
        sleep(300);
    }
    return null;
}

/**
 * 从剪贴板文本中提取并校验 TikTok 链接。
 *
 * @param {string} clipboard - 剪贴板文本
 * @returns {string} 有效 TikTok URL，无效时返回空字符串
 */
function extractTikTokUrl(clipboard) {
    var match = String(clipboard || "").match(/https?:\/\/[^\s]+/i);
    if (!match) return "";
    var url = match[0].replace(/[),，。]+$/, "");
    if (!/^https?:\/\/(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com|vt\.tiktok\.com)\//i.test(url)) return "";
    return url;
}

/**
 * 通过作品分享面板复制并验证链接，失败时重试。
 *
 * @returns {string} 已验证的 TikTok URL
 */
function copyPostUrl() {
    var maxAttempts = Math.max(1, Number(request.linkMaxAttempts || 8));
    var retryMs = Math.max(2000, Number(request.linkRetrySeconds || 15) * 1000);
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
        setClip("");
        var shareButton = findShareButton(7000);
        if (!shareButton || !performClick(shareButton)) throw new Error("Share button not found on latest post");
        pause(1500, 2500);
        var shareSheetOpen = isShareSheetOpen();
        var clickedCopy = findAndClick(["复制链接", "Copy link"], 2500, false);
        if (!clickedCopy && shareSheetOpen) {
            clickedCopy = click(Math.floor(device.width * 0.105), Math.floor(device.height * 0.765));
            if (clickedCopy) pause(700, 1400);
        }
        if (clickedCopy) {
            pause(1200, 2200);
            var url = extractTikTokUrl(getClip());
            if (url) return url;
            reportProgress("TikTok is still processing the post; retrying link copy (" + (attempt + 1) + "/" + maxAttempts + ").");
        } else {
            reportProgress("Copy link action was unavailable; retrying (" + (attempt + 1) + "/" + maxAttempts + ").");
        }
        if (isShareSheetOpen()) {
            back();
            pause(900, 1500);
        }
        if (attempt + 1 < maxAttempts) sleep(retryMs);
    }
    return "";
}

/**
 * 仅从个人主页补取最新作品链接，不再次发布素材。
 *
 * @returns {Object} 结构化链接结果
 */
function retrieveLatestPostUrl() {
    selectedTitle = String(request.title || "");
    selectedDetails = String(request.details || "");
    phase = "opening_profile";
    navigateToProfile();
    openLatestPost();
    phase = "copying_link";
    var postUrl = copyPostUrl();
    if (!postUrl) {
        taskStatus = "FAILURE";
        return {
            success: false,
            published: true,
            linkOnly: true,
            phase: phase,
            postUrl: "",
            profileHandle: profileHandle,
            title: selectedTitle,
            details: selectedDetails,
            error: "Latest post is still processing or no valid TikTok URL was copied"
        };
    }
    updateMatchingPostUrl(postUrl);
    return {
        success: true,
        published: true,
        linkOnly: true,
        phase: "completed",
        postUrl: postUrl,
        profileHandle: profileHandle,
        title: selectedTitle,
        details: selectedDetails
    };
}

/**
 * 记录一次已经发布到 TikTok 的内容。
 *
 * @param {Object} state - 发布历史状态
 * @param {string} postUrl - 作品链接，可为空
 */
function recordPublishedPost(state, postUrl) {
    var now = Date.now();
    state.materialUses[selectedMediaPath] = now;
    state.captionUses[JSON.stringify({ title: selectedTitle, details: selectedDetails, caption: selectedCaption })] = now;
    state.posts.push({ publishedAt: now, mediaPath: selectedMediaPath, mediaType: selectedMediaType, caption: selectedCaption, postUrl: postUrl || "" });
    saveState(state);
}

/**
 * 为刚记录的发布补充校验后的作品链接。
 *
 * @param {Object} state - 发布历史状态
 * @param {string} postUrl - 已验证的作品链接
 */
function updateLatestPostUrl(state, postUrl) {
    if (!state.posts.length || !postUrl) return;
    state.posts[state.posts.length - 1].postUrl = postUrl;
    saveState(state);
}

/**
 * 补链模式下按本次文案匹配最近发布记录并写回链接。
 *
 * @param {string} postUrl - 已验证格式的 TikTok 链接
 */
function updateMatchingPostUrl(postUrl) {
    if (!postUrl) return;
    var state = loadState();
    var markers = [selectedTitle, selectedDetails];
    for (var i = state.posts.length - 1; i >= 0; i--) {
        var caption = String(state.posts[i].caption || "");
        for (var j = 0; j < markers.length; j++) {
            if (markers[j] && caption.indexOf(markers[j]) >= 0) {
                state.posts[i].postUrl = postUrl;
                state.posts[i].profileHandle = profileHandle;
                saveState(state);
                return;
            }
        }
    }
}

/**
 * 执行完整 TikTok 图片或视频发布与链接回传流程。
 *
 * @returns {Object} 结构化发布结果
 */
function runTikTokPost() {
    var state = loadState();
    enforcePostingLimits(state);
    phase = "selecting_material";
    var materials = collectMaterialCandidates();
    if (!materials.length) throw new Error("No supported media found in the supplied material pool");
    selectedMediaPath = request.videoPath || request.imagePath ? materials[0] : chooseLeastRecentlyUsed(materials, state.materialUses);
    selectedMediaType = /\.(mp4|mov|m4v)$/i.test(selectedMediaPath) ? "video" : "image";
    var caption = chooseCaption(state);
    selectedTitle = caption.title;
    selectedDetails = caption.details;
    selectedCaption = caption.caption;
    reportProgress("Selected " + selectedMediaType + " material " + selectedMediaPath + " from " + materials.length + " candidate(s).");

    phase = "opening_editor";
    openMediaInTikTok(selectedMediaPath);
    pause(6000, 8000);
    dismissTransientDialogs();
    reachCaptionEditor();

    phase = "entering_caption";
    enterCaption();
    phase = "submitting_post";
    if (!findAndClick(["发布", "Post"], 10000, true)) throw new Error("Post button not found");
    phase = "waiting_for_upload";
    waitForPublishCompletion();
    recordPublishedPost(state, "");
    phase = "opening_profile";
    navigateToProfile();
    openLatestPost();
    phase = "copying_link";
    var postUrl = copyPostUrl();
    updateLatestPostUrl(state, postUrl);
    if (!postUrl) {
        taskStatus = "FAILURE";
        return {
            success: false,
            published: true,
            phase: phase,
            postUrl: "",
            selectedMediaPath: selectedMediaPath,
            mediaType: selectedMediaType,
            profileHandle: profileHandle,
            title: selectedTitle,
            details: selectedDetails,
            error: "Post was published, but no valid TikTok URL was copied"
        };
    }
    phase = "completed";
    return {
        success: true,
        published: true,
        phase: phase,
        postUrl: postUrl,
        selectedMediaPath: selectedMediaPath,
        mediaType: selectedMediaType,
        profileHandle: profileHandle,
        title: selectedTitle,
        details: selectedDetails
    };
}

try {
    reportProgress("Starting TikTok auto-post process.");
    taskResult = JSON.stringify(request.linkOnly ? retrieveLatestPostUrl() : runTikTokPost());
} catch (error) {
    taskStatus = "FAILURE";
    taskResult = JSON.stringify({
        success: false,
        published: request.linkOnly ? true : published,
        phase: phase,
        postUrl: "",
        selectedMediaPath: selectedMediaPath,
        mediaType: selectedMediaType,
        profileHandle: profileHandle,
        title: selectedTitle,
        details: selectedDetails,
        error: String(error && error.message ? error.message : error)
    });
}
