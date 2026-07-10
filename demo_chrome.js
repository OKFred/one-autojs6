// 启动 Chrome 浏览器并打开百度
app.intent({
    action: "VIEW",
    data: "https://www.baidu.com",
    packageName: "com.android.chrome",
    flags: ["ACTIVITY_NEW_TASK"]
});

// 延迟 5 秒，以确保页面加载并给用户看
sleep(5000);
