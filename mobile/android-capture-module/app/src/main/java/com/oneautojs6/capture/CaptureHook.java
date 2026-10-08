package com.oneautojs6.capture;

import android.content.ContentResolver;
import android.content.Context;
import android.database.ContentObserver;
import android.os.Binder;
import android.os.Build;
import android.os.Handler;
import android.provider.Settings;
import android.view.WindowManager;

import java.lang.reflect.Field;
import java.lang.reflect.Member;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.function.BiConsumer;
import java.util.function.Consumer;

import de.robv.android.xposed.IXposedHookLoadPackage;
import de.robv.android.xposed.XC_MethodHook;
import de.robv.android.xposed.XposedBridge;
import de.robv.android.xposed.callbacks.XC_LoadPackage;

/** Applies a user-controlled ordinary-window capture policy inside Android 13 system_server. */
public final class CaptureHook implements IXposedHookLoadPackage {
    private static final String LOG_PREFIX = "OneAutoJS6Capture: ";
    private static final int SYNTHETIC_CLASS_LIMIT = 256;
    private final Object lifecycleLock = new Object();
    private final List<XC_MethodHook.Unhook> installedHooks = new ArrayList<>();
    private final Set<String> loggedCodes = new HashSet<>();
    private volatile boolean active;
    private volatile boolean enabled;
    private boolean initializationStarted;
    private boolean restoreQueued;
    private Field showUserIdField;
    private Field attributesField;
    private Method policyInstanceMethod;
    private Method captureAllowedMethod;
    private Method refreshCaptureMethod;
    private Object windowManager;
    private Handler windowManagerHandler;
    private ContentResolver resolver;
    private ContentObserver observer;

    /**
     * Installs hooks only in the Android 13 system process and rolls back partial installation.
     *
     * @param param the package and process being loaded by LSPosed
     * @returns no value
     */
    @Override
    public void handleLoadPackage(XC_LoadPackage.LoadPackageParam param) {
        if (!"android".equals(param.packageName) || !"android".equals(param.processName)
                || Build.VERSION.SDK_INT != 33) {
            return;
        }
        synchronized (lifecycleLock) {
            if (initializationStarted) {
                return;
            }
            initializationStarted = true;
        }
        try {
            ClassLoader loader = param.classLoader;
            Class<?> windowState = Class.forName("com.android.server.wm.WindowState", false, loader);
            Class<?> windowManagerClass = Class.forName(
                    "com.android.server.wm.WindowManagerService", false, loader);
            Class<?> policyCache = Class.forName("android.app.admin.DevicePolicyCache", false, loader);
            showUserIdField = windowState.getDeclaredField("mShowUserId");
            showUserIdField.setAccessible(true);
            attributesField = declaredField(windowState, "mAttrs");
            policyInstanceMethod = declaredMethod(policyCache, "getInstance");
            captureAllowedMethod = declaredMethod(policyCache, "isScreenCaptureAllowed", int.class);
            refreshCaptureMethod = declaredMethod(windowManagerClass, "refreshScreenCaptureDisabled");
            deoptimizeCallers(loader, windowManagerClass);
            addHook(XposedBridge.hookMethod(declaredMethod(windowState, "isSecureLocked"),
                    new XC_MethodHook() {
                        /**
                         * Preserves app attributes and device policy while changing the result.
                         *
                         * @param hookParam the original secure-window result
                         * @returns no value
                         */
                        @Override
                        protected void afterHookedMethod(MethodHookParam hookParam) {
                            applyWindowPolicy(hookParam);
                        }
                    }));
            addHook(XposedBridge.hookMethod(declaredMethod(windowManagerClass, "systemReady"),
                    new XC_MethodHook() {
                        /**
                         * Registers the setting observer after the window manager is ready.
                         *
                         * @param hookParam the completed window-manager readiness call
                         * @returns no value
                         */
                        @Override
                        protected void afterHookedMethod(MethodHookParam hookParam) {
                            if (!hookParam.hasThrowable()) {
                                startObserving(hookParam.thisObject);
                            }
                        }
                    }));
            active = true;
        } catch (Throwable ignored) {
            failClosed("HOOK_INIT_FAILED");
        }
    }

    /**
     * Retains Android's result on every unexpected value or policy-reflection failure.
     *
     * @param param the secure-window hook result
     * @returns no value
     */
    private void applyWindowPolicy(XC_MethodHook.MethodHookParam param) {
        if (!active || !enabled || param.hasThrowable() || !Boolean.TRUE.equals(param.getResult())) {
            return;
        }
        try {
            WindowManager.LayoutParams attributes =
                    (WindowManager.LayoutParams) attributesField.get(param.thisObject);
            if ((attributes.flags & WindowManager.LayoutParams.FLAG_SECURE) == 0) {
                return;
            }
            int userId = showUserIdField.getInt(param.thisObject);
            Object cache = policyInstanceMethod.invoke(null);
            Object allowed = captureAllowedMethod.invoke(cache, userId);
            if (!(allowed instanceof Boolean)) {
                failClosed("POLICY_RESULT_UNEXPECTED");
                return;
            }
            param.setResult(CapturePolicy.effectiveSecure(true, enabled, (Boolean) allowed));
        } catch (Throwable ignored) {
            failClosed("POLICY_READ_FAILED");
        }
    }

    /**
     * Starts cached setting observation and refreshes existing surfaces on the WMS handler.
     *
     * @param service the initialized window manager
     * @returns no value
     */
    private void startObserving(Object service) {
        synchronized (lifecycleLock) {
            if (!active || observer != null) {
                return;
            }
            try {
                windowManager = service;
                Context context = (Context) declaredField(service.getClass(), "mContext").get(service);
                windowManagerHandler = (Handler) declaredField(service.getClass(), "mH").get(service);
                resolver = context.getContentResolver();
                observer = new ContentObserver(windowManagerHandler) {
                    /**
                     * Re-reads the toggle before scheduling a refresh of all existing windows.
                     *
                     * @param selfChange whether the notification originated from this observer
                     * @returns no value
                     */
                    @Override
                    public void onChange(boolean selfChange) {
                        updateSettingAndRefresh(false);
                    }
                };
                resolver.registerContentObserver(Settings.Global.getUriFor(CapturePolicy.SETTING_KEY),
                        false, observer);
            } catch (Throwable ignored) {
                failClosed("OBSERVER_INIT_FAILED");
                return;
            }
        }
        updateSettingAndRefresh(true);
    }

    /**
     * Updates the volatile toggle and dispatches surface refresh without per-window I/O.
     *
     * @param announceReady whether a successful refresh should announce hook readiness
     * @returns no value
     */
    private void updateSettingAndRefresh(final boolean announceReady) {
        if (!active) {
            return;
        }
        try {
            enabled = CapturePolicy.isEnabledSetting(
                    Settings.Global.getString(resolver, CapturePolicy.SETTING_KEY));
            if (!windowManagerHandler.post(new Runnable() {
                /** Refreshes ordinary window surfaces and reports only a fixed status code. */
                @Override
                public void run() {
                    if (!active) {
                        return;
                    }
                    try {
                        invokeSurfaceRefresh();
                        if (announceReady && active) {
                            logOnce("HOOK_READY");
                        }
                    } catch (Throwable ignored) {
                        failClosed("SURFACE_REFRESH_FAILED");
                    }
                }
            })) {
                failClosed("HANDLER_POST_FAILED");
            }
        } catch (Throwable ignored) {
            failClosed("SETTINGS_READ_FAILED");
        }
    }

    /**
     * Runs the native all-window refresh with the system process identity.
     *
     * @returns no value
     * @throws Exception when the window-manager refresh cannot be invoked
     */
    private void invokeSurfaceRefresh() throws Exception {
        long identity = Binder.clearCallingIdentity();
        try {
            refreshCaptureMethod.invoke(windowManager);
        } finally {
            Binder.restoreCallingIdentity(identity);
        }
    }

    /**
     * Deoptimizes direct callers and generated refresh-lambda bodies before installing the hook.
     *
     * @param loader the system-server class loader
     * @param windowManagerClass the window-manager implementation class
     * @returns no value
     * @throws Exception when a required caller or the LSPosed deoptimization API is unavailable
     */
    private void deoptimizeCallers(ClassLoader loader, Class<?> windowManagerClass) throws Exception {
        Method deoptimize = XposedBridge.class.getDeclaredMethod("deoptimizeMethod", Member.class);
        deoptimize.setAccessible(true);
        Class<?> animator = Class.forName("com.android.server.wm.WindowStateAnimator", false, loader);
        Class<?> root = Class.forName("com.android.server.wm.RootWindowContainer", false, loader);
        deoptimizeNamedMethods(deoptimize, animator, "createSurfaceLocked");
        deoptimizeNamedMethods(deoptimize, windowManagerClass, "relayoutWindow");
        deoptimizeNamedMethods(deoptimize, root, "refreshSecureSurfaceState");
        boolean foundRefreshLambda = false;
        for (Method method : root.getDeclaredMethods()) {
            if (method.getName().startsWith("lambda$refreshSecureSurfaceState$")) {
                deoptimize.invoke(null, method);
                foundRefreshLambda = true;
            }
        }
        for (int index = 0; index < SYNTHETIC_CLASS_LIMIT; index++) {
            Class<?> synthetic;
            try {
                synthetic = Class.forName(root.getName() + "$$ExternalSyntheticLambda" + index,
                        false, loader);
            } catch (ClassNotFoundException ignored) {
                continue;
            }
            if (Consumer.class.isAssignableFrom(synthetic)
                    || BiConsumer.class.isAssignableFrom(synthetic)) {
                deoptimizeNamedMethods(deoptimize, synthetic, "accept");
                foundRefreshLambda = true;
            }
        }
        if (!foundRefreshLambda) {
            throw new NoSuchMethodException("REFRESH_LAMBDA_UNAVAILABLE");
        }
    }

    /**
     * Deoptimizes all overloads of a required caller and rejects missing implementations.
     *
     * @param deoptimize the runtime LSPosed deoptimization method
     * @param owner the caller's declaring class
     * @param name the required caller name
     * @returns no value
     * @throws Exception when invocation fails or the caller is absent
     */
    private static void deoptimizeNamedMethods(Method deoptimize, Class<?> owner, String name)
            throws Exception {
        int count = 0;
        for (Method method : owner.getDeclaredMethods()) {
            if (name.equals(method.getName())) {
                deoptimize.invoke(null, method);
                count++;
            }
        }
        if (count == 0) {
            throw new NoSuchMethodException("REQUIRED_CALLER_UNAVAILABLE");
        }
    }

    /**
     * Stores each successful hook so a subsequent initialization failure can remove it.
     *
     * @param hook the newly installed hook handle
     * @returns no value
     */
    private void addHook(XC_MethodHook.Unhook hook) {
        if (hook == null) {
            throw new IllegalStateException("HOOK_HANDLE_UNAVAILABLE");
        }
        synchronized (lifecycleLock) {
            installedHooks.add(hook);
        }
    }

    /**
     * Stops overrides, removes partial hooks and attempts to restore existing surfaces.
     *
     * @param code the fixed diagnostic code to emit once
     * @returns no value
     */
    private void failClosed(String code) {
        active = false;
        enabled = false;
        logOnce(code);
        synchronized (lifecycleLock) {
            for (XC_MethodHook.Unhook hook : installedHooks) {
                try {
                    hook.unhook();
                } catch (Throwable ignored) {
                    logOnce("HOOK_UNINSTALL_FAILED");
                }
            }
            installedHooks.clear();
            if (observer != null && resolver != null) {
                try {
                    resolver.unregisterContentObserver(observer);
                } catch (Throwable ignored) {
                    logOnce("OBSERVER_UNREGISTER_FAILED");
                }
                observer = null;
            }
            if (!restoreQueued && windowManager != null && windowManagerHandler != null
                    && refreshCaptureMethod != null) {
                restoreQueued = true;
                if (!windowManagerHandler.post(new Runnable() {
                    /** Attempts one native-policy restoration after hooks have been removed. */
                    @Override
                    public void run() {
                        try {
                            invokeSurfaceRefresh();
                        } catch (Throwable ignored) {
                            logOnce("SURFACE_RESTORE_FAILED");
                        }
                    }
                })) {
                    logOnce("SURFACE_RESTORE_FAILED");
                }
            }
        }
    }

    /**
     * Resolves a declared method for a fixed Android 13 signature.
     *
     * @param owner the declaring class
     * @param name the method name
     * @param parameters the exact parameter types
     * @returns the accessible method
     * @throws NoSuchMethodException when the ROM does not provide the signature
     */
    private static Method declaredMethod(Class<?> owner, String name, Class<?>... parameters)
            throws NoSuchMethodException {
        Method method = owner.getDeclaredMethod(name, parameters);
        method.setAccessible(true);
        return method;
    }

    /**
     * Resolves a declared window-manager field without reading window names or app payloads.
     *
     * @param owner the declaring class
     * @param name the field name
     * @returns the accessible field
     * @throws NoSuchFieldException when the ROM does not provide the field
     */
    private static Field declaredField(Class<?> owner, String name) throws NoSuchFieldException {
        Field field = owner.getDeclaredField(name);
        field.setAccessible(true);
        return field;
    }

    /**
     * Logs only fixed diagnostic codes and suppresses repeated messages.
     *
     * @param code the non-sensitive status code
     * @returns no value
     */
    private void logOnce(String code) {
        synchronized (loggedCodes) {
            if (loggedCodes.add(code)) {
                XposedBridge.log(LOG_PREFIX + code);
            }
        }
    }
}
