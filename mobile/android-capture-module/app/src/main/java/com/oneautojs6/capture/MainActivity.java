package com.oneautojs6.capture;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.io.IOException;
import java.util.concurrent.TimeUnit;

/** Local root-operated switch for ordinary secure windows on an Android 13 test device. */
public final class MainActivity extends Activity {
    private static final String SETTING = CapturePolicy.SETTING_KEY;
    private TextView status;
    private Button enable;
    private Button disable;

    /**
     * Build a local control screen without collecting screen contents or credentials.
     * @param savedInstanceState Previous activity state, if any.
     * @return Nothing.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(32, 48, 32, 32);
        ScrollView scroll = new ScrollView(this);
        scroll.addView(panel);
        setContentView(scroll);
        TextView title = new TextView(this);
        title.setText("远控画面兼容 · Android 13");
        title.setTextSize(24);
        panel.addView(title);
        status = new TextView(this);
        status.setTextSize(18);
        status.setPadding(0, 24, 0, 24);
        panel.addView(status);
        TextView detail = new TextView(this);
        detail.setText("首次使用：在 LSPosed 启用本模块，仅勾选 Android 系统，然后重启手机。\n\n"
            + "启用后：所有普通 FLAG_SECURE 窗口可以通过现有截图、投屏和录屏链路显示。"
            + "已加载模块时，切换开关会刷新现有窗口。\n\n"
            + "企业禁截策略、独立安全 SurfaceView 和 DRM 保护画面仍受保护。"
            + "密码输入框仍显示原来的掩码，不会变为明文。\n\n"
            + "全局设置键可被其他 App 读取；本功能不保证对 App 不可感知。"
            + "开始录制前，请确认当前页面内容适合保存。\n");
        detail.setTextSize(16);
        panel.addView(detail);
        enable = new Button(this);
        enable.setText("开启全局画面兼容");
        enable.setOnClickListener(view -> changeSetting(true));
        panel.addView(enable);
        disable = new Button(this);
        disable.setText("关闭并恢复窗口保护");
        disable.setOnClickListener(view -> changeSetting(false));
        panel.addView(disable);
        Button fixture = new Button(this);
        fixture.setText("打开无敏感信息测试页面");
        fixture.setOnClickListener(view -> startActivity(new Intent(this, FixtureActivity.class)));
        panel.addView(fixture);
    }

    /** Refresh the desired switch state whenever this page returns to the foreground. @return Nothing. */
    @Override
    public void onResume() {
        super.onResume();
        updateStatus();
    }

    /** Display configured state without treating configuration as proof that the hook is loaded. @return Nothing. */
    private void updateStatus() {
        boolean requested = CapturePolicy.isEnabledSetting(
            Settings.Global.getString(getContentResolver(), SETTING));
        status.setText("全局开关：" + (requested ? "开启" : "关闭")
            + "\n模块是否生效请使用测试页面验收。");
        status.setTextColor(requested ? Color.rgb(0, 100, 70) : Color.DKGRAY);
    }

    /**
     * Run one fixed root settings command and check its exit and readback on a worker thread.
     * @param requested Whether global capture compatibility should be enabled.
     * @return Nothing.
     */
    private void changeSetting(boolean requested) {
        enable.setEnabled(false);
        disable.setEnabled(false);
        status.setText("正在设置，请完成可能出现的 root 授权…");
        new Thread(() -> {
            String failure = null;
            Process process = null;
            try {
                process = new ProcessBuilder("su", "-c", "settings put global " + SETTING
                    + (requested ? " 1" : " 0")).redirectErrorStream(true).start();
                if (!process.waitFor(30, TimeUnit.SECONDS)) {
                    process.destroyForcibly();
                    failure = "root 授权或设置超时，请检查 Magisk。";
                } else if (process.exitValue() != 0
                    || CapturePolicy.isEnabledSetting(
                        Settings.Global.getString(getContentResolver(), SETTING)) != requested) {
                    failure = "设置失败，请检查 Magisk 是否允许本模块使用 root。";
                }
            } catch (IOException error) {
                failure = "无法启动 root 命令，请检查 Magisk。";
            } catch (InterruptedException error) {
                Thread.currentThread().interrupt();
                failure = "设置已中断，请重新检查开关状态。";
            } finally {
                if (process != null) {
                    process.destroy();
                }
            }
            final String result = failure;
            runOnUiThread(() -> {
                if (isFinishing() || isDestroyed()) {
                    return;
                }
                enable.setEnabled(true);
                disable.setEnabled(true);
                updateStatus();
                if (result != null) {
                    status.setText(result);
                }
            });
        }, "capture-setting").start();
    }
}
