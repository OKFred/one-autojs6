package com.oneautojs6.capture;

/** Runs the pure JVM capture-policy truth table without Android or test-framework dependencies. */
public final class CapturePolicyTest {
    /** Prevents construction of the standalone test runner. */
    private CapturePolicyTest() {
    }

    /**
     * Checks enabling values, disabled defaults and every policy-result combination.
     *
     * @param args unused command-line arguments
     * @returns no value
     */
    public static void main(String[] args) {
        require(CapturePolicy.isEnabledSetting("1"), "explicit enabling value");
        String[] disabledValues = {null, "", "0", "2", "-1", "true", "false", "01", " 1", "1 "};
        for (String value : disabledValues) {
            require(!CapturePolicy.isEnabledSetting(value), "default and unexpected values stay off");
        }
        Boolean[] policyValues = {Boolean.TRUE, Boolean.FALSE, null};
        for (boolean original : new boolean[] {false, true}) {
            for (boolean enabled : new boolean[] {false, true}) {
                for (Boolean allowed : policyValues) {
                    boolean expected = original && !(enabled && Boolean.TRUE.equals(allowed));
                    require(CapturePolicy.effectiveSecure(original, enabled, allowed) == expected,
                            "policy truth table");
                }
            }
        }
        require(CapturePolicy.effectiveSecure(true, true, false), "DPM denial stays secure");
        require(CapturePolicy.effectiveSecure(true, true, null), "unavailable DPM stays secure");
        require(!CapturePolicy.effectiveSecure(true, true, true), "ordinary secure window opens");
        require(CapturePolicy.effectiveSecure(true, false, true), "switch off restores security");
        System.out.println("CapturePolicyTest: PASS");
    }

    /**
     * Fails the test process when a policy invariant does not hold.
     *
     * @param condition whether the invariant is satisfied
     * @param description the invariant's fixed description
     * @returns no value
     */
    private static void require(boolean condition, String description) {
        if (!condition) {
            throw new AssertionError(description);
        }
    }
}
