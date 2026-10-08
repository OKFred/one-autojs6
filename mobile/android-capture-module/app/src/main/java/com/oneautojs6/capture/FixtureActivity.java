package com.oneautojs6.capture;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Non-sensitive initial/dynamic FLAG_SECURE fixture, with app-side flags readback. */
public final class FixtureActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private TextView status;

    /**
     * Create a colorful test window with no account, network, or message operations.
     * @param savedInstanceState Previous activity state, if any.
     * @return Nothing.
     */
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String mode = getIntent().getStringExtra("mode");
        if (!"plain".equals(mode) && !"dynamic".equals(mode)) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(24, 36, 24, 24);
        panel.setBackgroundColor(Color.rgb(20, 90, 180));
        setContentView(panel);
        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(22);
        panel.addView(status);
        TextView marker = new TextView(this);
        marker.setText("ONE-AUTOJS6\n无敏感信息的取图测试\n蓝色背景 + 橙色标记");
        marker.setTextSize(25);
        marker.setTextColor(Color.BLACK);
        marker.setBackgroundColor(Color.rgb(255, 180, 30));
        marker.setPadding(24, 36, 24, 36);
        panel.addView(marker);
        EditText password = new EditText(this);
        password.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        password.setText("fixture-only");
        password.setTextColor(Color.WHITE);
        password.setHint("仅测试掩码，不输入真实密码");
        password.setSaveEnabled(false);
        panel.addView(password);
        Button add = new Button(this);
        add.setText("动态加上 FLAG_SECURE");
        add.setOnClickListener(view -> setSecure(true));
        panel.addView(add);
        Button clear = new Button(this);
        clear.setText("清除测试窗口 FLAG_SECURE");
        clear.setOnClickListener(view -> setSecure(false));
        panel.addView(clear);
        updateStatus();
        if ("dynamic".equals(mode)) {
            handler.postDelayed(() -> setSecure(true), 2500);
        }
    }

    /**
     * Change only this fixture window's secure flag to exercise relayout.
     * @param secure Whether this fixture should request FLAG_SECURE.
     * @return Nothing.
     */
    private void setSecure(boolean secure) {
        if (secure) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
        updateStatus();
    }

    /** Show the application's unmodified attributes for detectability acceptance. @return Nothing. */
    private void updateStatus() {
        boolean secure = (getWindow().getAttributes().flags & WindowManager.LayoutParams.FLAG_SECURE) != 0;
        status.setText("App 读到 FLAG_SECURE：" + secure + "\n屏幕内容只有测试数据");
    }

    /** Cancel delayed fixture updates when the test window is destroyed. @return Nothing. */
    @Override
    public void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }
}
