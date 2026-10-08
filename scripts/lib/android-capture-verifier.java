import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.imageio.ImageIO;

/** Pure guard, PNG and report calculations shared by the Bash verifier and offline tests. */
final class CaptureVerifier {
    private static final String SHORT_COMPONENT = "com.oneautojs6.capture/.FixtureActivity";
    private static final String FULL_COMPONENT = "com.oneautojs6.capture/com.oneautojs6.capture.FixtureActivity";
    private static final int MAX_INPUT_BYTES = 20 * 1024 * 1024;
    private static final Set<String> KNOWN_FLAGS = new HashSet<>(Arrays.asList(
            "ALLOW_LOCK_WHILE_SCREEN_ON", "DIM_BEHIND", "BLUR_BEHIND", "NOT_FOCUSABLE",
            "NOT_TOUCHABLE", "NOT_TOUCH_MODAL", "TOUCHABLE_WHEN_WAKING", "KEEP_SCREEN_ON",
            "LAYOUT_IN_SCREEN", "LAYOUT_NO_LIMITS", "FULLSCREEN", "FORCE_NOT_FULLSCREEN", "DITHER",
            "SECURE", "SCALED", "IGNORE_CHEEK_PRESSES", "LAYOUT_INSET_DECOR", "ALT_FOCUSABLE_IM",
            "WATCH_OUTSIDE_TOUCH", "SHOW_WHEN_LOCKED", "SHOW_WALLPAPER", "TURN_SCREEN_ON",
            "DISMISS_KEYGUARD", "SPLIT_TOUCH", "HARDWARE_ACCELERATED", "LAYOUT_IN_OVERSCAN",
            "TRANSLUCENT_STATUS", "TRANSLUCENT_NAVIGATION", "LOCAL_FOCUS_MODE", "SLIPPERY",
            "LAYOUT_ATTACHED_IN_DECOR", "DRAWS_SYSTEM_BAR_BACKGROUNDS"));

    /** Runs one explicitly selected pure calculation; errors never include device input. @param args Fixed command arguments. @returns No value. */
    public static void main(String[] args) {
        try {
            switch (args[0]) {
                case "guard": {
                    String[] dumps = new String(readInput(), StandardCharsets.UTF_8).split("\u0000", -1);
                    require(dumps.length == 2, "GUARD_INPUT_INVALID");
                    Guard guard = parseGuard(dumps[0], dumps[1], args[1], args[2]);
                    System.out.println(guard.activity + "\t" + guard.window + "\t" + guard.secure);
                    break;
                }
                case "measure": {
                    Path pngPath = Paths.get(args[1]);
                    require(Files.size(pngPath) <= MAX_INPUT_BYTES, "PNG_BYTE_LENGTH_INVALID");
                    byte[] png = Files.readAllBytes(pngPath);
                    Metrics metrics = measure(png);
                    boolean visible = Boolean.parseBoolean(args[4]);
                    boolean passed = passes(metrics, visible, args[5]);
                    System.out.println(metrics.tsv());
                    System.out.println("{\"stage\":" + json(args[2]) + ",\"png\":" + json(args[1])
                            + ",\"expectedVisible\":" + visible + ",\"appFlagSecure\":" + args[3]
                            + ",\"passed\":" + passed + ",\"metrics\":" + metrics.json() + "}");
                    if (!passed) { System.exit(2); }
                    break;
                }
                case "report": {
                    String stages = new String(readInput(), StandardCharsets.UTF_8).trim().replace("\n", ",");
                    System.out.println("{\"fixture\":" + json(SHORT_COMPONENT)
                            + ",\"captureMethod\":\"root screencap PNG\",\"initialSetting\":" + optionalJson(args[1])
                            + ",\"defaultOffVerified\":" + args[2] + ",\"observedDynamicTransition\":" + args[3]
                            + ",\"passed\":" + args[4] + ",\"settingRestored\":" + args[5]
                            + ",\"failure\":" + optionalJson(args[6]) + ",\"restorationFailure\":" + optionalJson(args[7])
                            + ",\"stages\":[" + stages + "]}");
                    break;
                }
                case "self-test": selfTest(); break;
                case "encode-png": System.out.println(Base64.getEncoder().encodeToString(readInput())); break;
                case "fixture-png": System.out.write(syntheticPng("visible".equals(args[1]))); break;
                default: throw new IllegalArgumentException("HELPER_COMMAND_INVALID");
            }
        } catch (Throwable error) {
            String code = error instanceof IllegalArgumentException ? error.getMessage() : "HELPER_CALCULATION_FAILED";
            if (code == null || !code.matches("[A-Z_]+")) { code = "HELPER_CALCULATION_FAILED"; }
            System.err.println(code);
            System.exit(1);
        }
    }

    /** Reads bounded standard input without writing raw dumps. @returns Input bytes. @throws Exception On an input failure. */
    private static byte[] readInput() throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = System.in.read(buffer)) != -1) {
            require(output.size() + count <= MAX_INPUT_BYTES, "HELPER_INPUT_TOO_LARGE");
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    /** Compiles fixed multiline dump patterns. @param expression Fixed regex. @returns Compiled pattern. */
    private static Pattern pattern(String expression) {
        return Pattern.compile(expression, Pattern.MULTILINE);
    }

    /** Checks either supported spelling of the fixed fixture component. @param component Parsed component. @returns Whether it is the fixture. */
    private static boolean fixture(String component) {
        return SHORT_COMPONENT.equals(component) || FULL_COMPONENT.equals(component);
    }

    /** Parses strict synthetic or real dump strings without I/O. @param activities Activity dump. @param windows Complete window dump. @param expectedWindow Optional token. @param expectedSecure Optional boolean. @returns Guarded fixed-fixture state. */
    private static Guard parseGuard(String activities, String windows, String expectedWindow, String expectedSecure) {
        Set<String> resumed = new HashSet<>();
        Matcher lines = pattern("^[\\t ]*(?:topResumedActivity\\s*=|mResumedActivity\\s*:|Resumed\\s*:)\\s*([^\\r\\n]+)").matcher(activities);
        Pattern recordPattern = Pattern.compile("^ActivityRecord\\{([A-Fa-f0-9]+)\\s+u(\\d+)\\s+(\\S+)\\s+t\\d+(?:\\s[^}]*)?\\}$");
        while (lines.find()) {
            String text = lines.group(1).trim();
            if ("null".equals(text)) { continue; }
            Matcher record = recordPattern.matcher(text);
            require(record.matches() && "0".equals(record.group(2)) && fixture(record.group(3)), "FOREGROUND_GUARD_REFUSED");
            resumed.add(record.group(1).toLowerCase(Locale.ROOT));
        }
        require(resumed.size() == 1, "FOREGROUND_GUARD_REFUSED");
        Matcher focusLines = pattern("^[\\t ]*mCurrentFocus\\s*=\\s*([^\\r\\n]+)").matcher(windows);
        require(focusLines.find(), "FOREGROUND_GUARD_REFUSED");
        String focusText = focusLines.group(1).trim();
        require(!focusLines.find(), "FOREGROUND_GUARD_REFUSED");
        Matcher focused = Pattern.compile("^Window\\{([A-Fa-f0-9]+)\\s+u(\\d+)\\s+([^}\\r\\n]+)\\}$").matcher(focusText);
        require(focused.matches() && "0".equals(focused.group(2)) && fixture(focused.group(3).trim()), "FOREGROUND_GUARD_REFUSED");
        String windowToken = focused.group(1).toLowerCase(Locale.ROOT);
        require(expectedWindow.isEmpty() || windowToken.equalsIgnoreCase(expectedWindow), "SAME_WINDOW_GUARD_REFUSED");
        Matcher sections = Pattern.compile("(?ms)^[\\t ]*Window #\\d+\\s+Window\\{([A-Fa-f0-9]+)\\s+u(\\d+)\\s+([^}\\r\\n]+)\\}:[\\t ]*\\r?\\n(.*?)(?=^[\\t ]*Window #\\d+\\s+Window\\{|\\z)").matcher(windows);
        String body = null;
        while (sections.find()) {
            if (!sections.group(1).equalsIgnoreCase(windowToken)) { continue; }
            require(body == null && "0".equals(sections.group(2)) && fixture(sections.group(3).trim()), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
            body = sections.group(4);
        }
        require(body != null, "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        Matcher displays = pattern("^[\\t ]*mDisplayId=(\\d+)(?:\\s|$)").matcher(body);
        require(displays.find() && "0".equals(displays.group(1)) && !displays.find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        Matcher owners = pattern("^[\\t ]*mOwnerUid=\\d+\\s+[^\\r\\n]*\\bpackage=(\\S+)").matcher(body);
        require(owners.find() && "com.oneautojs6.capture".equals(owners.group(1)) && !owners.find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        Matcher attributes = Pattern.compile("(?ms)^[\\t ]*mAttrs=(.*?)(?=^[\\t ]*Requested w=)").matcher(body);
        require(attributes.find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        String attrs = attributes.group(1);
        require(!attributes.find() && Pattern.compile("\\bty=BASE_APPLICATION\\b").matcher(attrs).find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        Matcher flagLines = pattern("^[\\t ]*fl=([^\\r\\n]+)").matcher(attrs);
        require(flagLines.find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        String flags = flagLines.group(1).trim().replaceFirst("}+$", "").trim();
        require(!flagLines.find(), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        boolean secure;
        if (flags.matches("(?i)(?:0x)?[a-f0-9]+")) {
            long value;
            try { value = Long.parseLong(flags.replaceFirst("(?i)^0x", ""), 16); }
            catch (NumberFormatException error) { throw new IllegalArgumentException("WINDOW_ATTRIBUTES_GUARD_REFUSED"); }
            require(value <= 0xffffffffL && (value & 0x80) != 0, "WINDOW_ATTRIBUTES_GUARD_REFUSED");
            secure = (value & 0x2000) != 0;
        } else {
            Set<String> names = new HashSet<>();
            for (String flag : flags.split("[\\s|]+")) {
                if (flag.startsWith("FLAG_")) { flag = flag.substring(5); }
                require(KNOWN_FLAGS.contains(flag), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
                names.add(flag);
            }
            require(names.contains("KEEP_SCREEN_ON"), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
            secure = names.contains("SECURE");
        }
        require(expectedSecure.isEmpty() || secure == Boolean.parseBoolean(expectedSecure), "WINDOW_ATTRIBUTES_GUARD_REFUSED");
        return new Guard(resumed.iterator().next(), windowToken, secure);
    }

    /** Rejects a fixed invariant with a non-sensitive code. @param valid Invariant state. @param code Fixed failure code. @returns No value. */
    private static void require(boolean valid, String code) {
        if (!valid) { throw new IllegalArgumentException(code); }
    }

    /** Samples PNG pixels using the existing verifier thresholds. @param png PNG bytes. @returns Dimensions, palette fractions and hash. @throws Exception On invalid encoding. */
    private static Metrics measure(byte[] png) throws Exception {
        require(png.length >= 32 && png.length <= MAX_INPUT_BYTES, "PNG_BYTE_LENGTH_INVALID");
        byte[] signature = {(byte) 137, 80, 78, 71, 13, 10, 26, 10};
        for (int index = 0; index < signature.length; index++) {
            require(png[index] == signature[index], "PNG_ENCODING_INVALID");
        }
        require(png[12] == 'I' && png[13] == 'H' && png[14] == 'D' && png[15] == 'R', "PNG_ENCODING_INVALID");
        ByteBuffer dimensions = ByteBuffer.wrap(png, 16, 8);
        int width = dimensions.getInt(), height = dimensions.getInt();
        require(width >= 200 && height >= 300 && (long) width * height <= 40_000_000L, "PNG_DIMENSIONS_INVALID");
        ImageIO.setUseCache(false);
        BufferedImage image = ImageIO.read(new ByteArrayInputStream(png));
        require(image != null && image.getWidth() >= 200 && image.getHeight() >= 300, "PNG_DIMENSIONS_INVALID");
        require((long) image.getWidth() * image.getHeight() <= 40_000_000L, "PNG_DIMENSIONS_INVALID");
        int stride = Math.max(4, (int) Math.ceil(Math.max(image.getWidth(), image.getHeight()) / 220.0));
        int samples = 0, dark = 0, blue = 0, orange = 0;
        for (int y = (int) (image.getHeight() * 0.08); y < (int) (image.getHeight() * 0.90); y += stride) {
            for (int x = (int) (image.getWidth() * 0.08); x < (int) (image.getWidth() * 0.92); x += stride) {
                int pixel = image.getRGB(x, y);
                int red = (pixel >> 16) & 255, green = (pixel >> 8) & 255, cyan = pixel & 255;
                samples++;
                if (red <= 35 && green <= 35 && cyan <= 35) { dark++; }
                if (red <= 95 && green >= 45 && green <= 145 && cyan >= 125) { blue++; }
                if (red >= 190 && green >= 120 && green <= 235 && cyan <= 135) { orange++; }
            }
        }
        require(samples > 0, "PNG_SAMPLES_INVALID");
        StringBuilder hash = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(png)) { hash.append(String.format("%02x", value & 255)); }
        return new Metrics(image.getWidth(), image.getHeight(), samples, dark / (double) samples,
                blue / (double) samples, orange / (double) samples, hash.toString());
    }

    /** Applies the original relative palette and black-screen limits. @param current Current metrics. @param visible Expected palette visibility. @param baseline Optional TSV metrics. @returns Whether pixels pass. */
    private static boolean passes(Metrics current, boolean visible, String baseline) {
        double minimumBlue = 0.15, minimumOrange = 0.01;
        if (!baseline.isEmpty()) {
            String[] values = baseline.split("\\t");
            require(values.length == 7 && current.width == Integer.parseInt(values[0])
                    && current.height == Integer.parseInt(values[1]), "PNG_DIMENSIONS_CHANGED");
            minimumBlue = Math.max(minimumBlue, Double.parseDouble(values[4]) * 0.65);
            minimumOrange = Math.max(minimumOrange, Double.parseDouble(values[5]) * 0.55);
        }
        return visible ? current.blue >= minimumBlue && current.orange >= minimumOrange
                : current.dark >= 0.96 && current.blue <= 0.01 && current.orange <= 0.005;
    }

    /** Quotes one JSON value without adding dependencies. @param value Plain string. @returns JSON string. */
    private static String json(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (char character : value.toCharArray()) {
            if (character == '"' || character == '\\') { result.append('\\').append(character); }
            else if (character < 32) { result.append(String.format("\\u%04x", (int) character)); }
            else { result.append(character); }
        }
        return result.append('"').toString();
    }

    /** Represents an unset report field as null. @param value Report field. @returns JSON value. */
    private static String optionalJson(String value) { return value.isEmpty() ? "null" : json(value); }

    /** Creates a wholly synthetic window dump. @param flags Fixed test flags. @returns Synthetic dump. */
    private static String syntheticWindow(String flags) {
        return "WINDOW MANAGER WINDOWS (dumpsys window)\n  Window #0 Window{bb22 u0 " + SHORT_COMPONENT + "}:\n"
                + "    mDisplayId=0 rootTaskId=1 mSession=synthetic\n"
                + "    mOwnerUid=10000 showForAllUsers=false package=com.oneautojs6.capture appop=NONE\n"
                + "    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION\n      fl=" + flags
                + "\n      fitTypes=STATUS_BARS NAVIGATION_BARS}\n    Requested w=400 h=800 mLayoutSeq=1\n"
                + "  mCurrentFocus=Window{bb22 u0 " + SHORT_COMPONENT + "}\n";
    }

    /** Checks acceptance identity and flags. @param activity Synthetic activities. @param window Synthetic windows. @param secure Expected flag. @returns One counted case. */
    private static int accepted(String activity, String window, boolean secure) {
        Guard state = parseGuard(activity, window, "bb22", Boolean.toString(secure));
        require(state.activity.equals("aa11") && state.window.equals("bb22") && state.secure == secure, "OFFLINE_TEST_FAILED");
        return 1;
    }

    /** Requires a guard-specific rejection. @param activity Synthetic activities. @param window Synthetic windows. @param expectedSecure Optional flag. @returns One counted case. */
    private static int rejected(String activity, String window, String expectedSecure) {
        try { parseGuard(activity, window, "bb22", expectedSecure); }
        catch (IllegalArgumentException error) {
            require(error.getMessage().endsWith("GUARD_REFUSED"), "OFFLINE_TEST_FAILED");
            return 1;
        }
        throw new IllegalArgumentException("OFFLINE_TEST_FAILED");
    }

    /** Runs the same 32 guard cases plus in-memory palette checks. @returns No value. @throws Exception On a failed case. */
    private static void selfTest() throws Exception {
        String modern = "topResumedActivity=ActivityRecord{aa11 u0 " + SHORT_COMPONENT + " t1}";
        String legacy = modern.replace("topResumedActivity=", "mResumedActivity: ");
        String summary = modern.replace("topResumedActivity=", "Resumed: ");
        String secure = syntheticWindow("KEEP_SCREEN_ON SECURE HARDWARE_ACCELERATED");
        int count = 0;
        count += accepted(modern, secure, true);
        count += accepted(legacy, secure, true);
        count += accepted(summary, secure, true);
        count += accepted(modern + "\n" + modern + "\n" + legacy + "\n" + summary, secure, true);
        count += accepted(modern + "\n" + summary.replace(SHORT_COMPONENT, FULL_COMPONENT), secure, true);
        count += accepted(modern.replace("aa11", "AA11"), secure.replace("bb22", "BB22"), true);
        count += accepted(modern, syntheticWindow("FLAG_KEEP_SCREEN_ON | FLAG_SECURE | FLAG_HARDWARE_ACCELERATED"), true);
        count += accepted(modern, syntheticWindow("0x2080"), true);
        count += accepted(modern, syntheticWindow("2080"), true);
        count += accepted(modern, syntheticWindow("KEEP_SCREEN_ON HARDWARE_ACCELERATED"), false);
        count += accepted(modern, syntheticWindow("0x80"), false);
        String other = modern.replace(SHORT_COMPONENT, "com.example.other/.OtherActivity");
        count += rejected(other, secure, "");
        count += rejected(modern + "\n" + summary.replace("aa11", "cc33").replace(SHORT_COMPONENT, "com.example.other/.OtherActivity"), secure, "");
        count += rejected(modern + "\n" + legacy.replace("aa11", "cc33"), secure, "");
        count += rejected(modern.replace("u0", "u10"), secure, "");
        count += rejected("topResumedActivity=null", secure, "");
        count += rejected(modern + "\nResumed: unknown-format", secure, "");
        count += rejected(modern, secure.replace(SHORT_COMPONENT, "com.example.other/.OtherActivity"), "");
        count += rejected(modern, secure + "\n  mCurrentFocus=Window{cc33 u0 " + SHORT_COMPONENT + "}", "");
        count += rejected(modern, secure + "\n  mCurrentFocus=null", "");
        count += rejected(modern, secure.replace("u0", "u10"), "");
        count += rejected(modern, secure.replace("mDisplayId=0", "mDisplayId=1"), "");
        count += rejected(modern, secure.replace("package=com.oneautojs6.capture", "package=com.example.other"), "");
        count += rejected(modern, secure.replace("ty=BASE_APPLICATION", "ty=APPLICATION_OVERLAY"), "");
        String second = secure.replace("Window #0", "Window #1").replaceAll("(?m)^[\\t ]*mCurrentFocus=.*(?:\\r?\\n|$)", "");
        count += rejected(modern, secure + "\n" + second, "");
        count += rejected(modern, secure.replaceAll("(?m)^[\\t ]*mCurrentFocus=.*(?:\\r?\\n|$)", ""), "");
        count += rejected(modern, syntheticWindow("UNKNOWN_FORMAT"), "");
        count += rejected(modern, syntheticWindow("KEEP_SCREEN_ON UNKNOWN_FORMAT"), "");
        count += rejected(modern, syntheticWindow("0x2000"), "");
        count += rejected(modern, syntheticWindow("100000000"), "");
        count += rejected(modern, secure.replace("bb22", "cc33"), "");
        count += rejected(modern, secure, "false");
        require(count == 32, "OFFLINE_TEST_FAILED");
        Metrics visible = measure(syntheticPng(true));
        Metrics dark = measure(syntheticPng(false));
        require(passes(visible, true, "") && passes(visible, true, visible.tsv())
                && passes(dark, false, visible.tsv()) && !passes(dark, true, visible.tsv())
                && !passes(visible, false, visible.tsv()), "OFFLINE_TEST_FAILED");
        rejectedPng(new byte[MAX_INPUT_BYTES + 1], "PNG_BYTE_LENGTH_INVALID");
        rejectedPng(new byte[32], "PNG_ENCODING_INVALID");
        byte[] oversizedDimensions = syntheticPng(true);
        ByteBuffer.wrap(oversizedDimensions, 16, 4).putInt(Integer.MAX_VALUE);
        rejectedPng(oversizedDimensions, "PNG_DIMENSIONS_INVALID");
        System.out.println("Guard parser offline tests: PASS (32 cases; 8 PNG checks; no ADB calls or raw dumps saved).");
    }

    /** Checks that invalid PNGs fail before decoding. @param png Test bytes. @param code Expected fixed code. @returns No value. @throws Exception On an unexpected result. */
    private static void rejectedPng(byte[] png, String code) throws Exception {
        try { measure(png); }
        catch (IllegalArgumentException error) { require(code.equals(error.getMessage()), "OFFLINE_TEST_FAILED"); return; }
        throw new IllegalArgumentException("OFFLINE_TEST_FAILED");
    }

    /** Generates test-only palette pixels without reading any device. @param visible Whether to draw the palette. @returns PNG bytes. @throws Exception On encoding failure. */
    private static byte[] syntheticPng(boolean visible) throws Exception {
        BufferedImage image = new BufferedImage(400, 800, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < 800; y++) {
            for (int x = 0; x < 400; x++) {
                image.setRGB(x, y, !visible ? 0 : (y >= 100 && y < 260 ? 0xffb41e : 0x145ab4));
            }
        }
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        ImageIO.write(image, "png", output);
        return output.toByteArray();
    }

    /** Holds the non-sensitive parsed fixture identity and flag state. */
    private static final class Guard {
        final String activity, window;
        final boolean secure;
        /** Stores parsed identity. @param activity Activity token. @param window Window token. @param secure Requested flag. @returns New state. */
        Guard(String activity, String window, boolean secure) { this.activity = activity; this.window = window; this.secure = secure; }
    }

    /** Holds fixture PNG metrics. */
    private static final class Metrics {
        final int width, height, samples;
        final double dark, blue, orange;
        final String hash;
        /** Stores calculated metrics. @param width Width. @param height Height. @param samples Count. @param dark Dark fraction. @param blue Blue fraction. @param orange Orange fraction. @param hash SHA256. @returns New metrics. */
        Metrics(int width, int height, int samples, double dark, double blue, double orange, String hash) {
            this.width = width; this.height = height; this.samples = samples;
            this.dark = dark; this.blue = blue; this.orange = orange; this.hash = hash;
        }
        /** Formats a fixed TSV baseline. @returns TSV metrics. */
        String tsv() { return width + "\t" + height + "\t" + samples + "\t" + dark + "\t" + blue + "\t" + orange + "\t" + hash; }
        /** Formats metrics for the evidence report. @returns JSON metrics. */
        String json() { return "{\"width\":" + width + ",\"height\":" + height + ",\"samples\":" + samples
                + ",\"darkFraction\":" + dark + ",\"blueFraction\":" + blue + ",\"orangeFraction\":" + orange + ",\"sha256\":" + CaptureVerifier.json(hash) + "}"; }
    }
}
