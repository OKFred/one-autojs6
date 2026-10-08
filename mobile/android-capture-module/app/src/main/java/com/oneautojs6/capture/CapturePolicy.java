package com.oneautojs6.capture;

/** Determines the ordinary-window capture override without Android dependencies. */
public final class CapturePolicy {
    public static final String SETTING_KEY = "one_autojs6_secure_capture_enabled";

    /** Prevents construction of the stateless policy. */
    private CapturePolicy() {
    }

    /**
     * Accepts only the explicit enabling value; missing or malformed settings stay disabled.
     *
     * @param settingValue the raw global setting, or null when absent
     * @returns whether the override is enabled
     */
    public static boolean isEnabledSetting(String settingValue) {
        return "1".equals(settingValue);
    }

    /**
     * Removes ordinary window security only when the device policy positively permits capture.
     *
     * @param originalSecure the result produced by Android
     * @param enabled whether the user enabled the ordinary-window override
     * @param screenCaptureAllowed the device-policy result, or null when it is unavailable
     * @returns the effective security result, preserving the original on unavailable policy
     */
    public static boolean effectiveSecure(boolean originalSecure, boolean enabled,
            Boolean screenCaptureAllowed) {
        if (!originalSecure || !enabled || !Boolean.TRUE.equals(screenCaptureAllowed)) {
            return originalSecure;
        }
        return false;
    }
}
