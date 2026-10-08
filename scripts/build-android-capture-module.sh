#!/usr/bin/env bash
set -eo pipefail

# /**
#  * Print command-line options and the requirements for a local-only build.
#  * @param {void} No arguments.
#  * @returns {void} Prints help without downloading, building or installing.
#  */
show_help() {
    printf '%s\n' \
        'Usage: bash scripts/build-android-capture-module.sh [options]' \
        '  --android-sdk-directory PATH  Android SDK (alias: --sdk)' \
        '  --build-tools-version NAME    Installed build-tools version; newest stable by default' \
        '  --jdk-directory PATH          JDK directory (alias: --jdk); JAVA_HOME or PATH by default' \
        '  --output-directory PATH       Output strictly inside the repository .tmp directory' \
        '  --help                        Show this help without doing a build' \
        '' \
        'Requires Bash 3.2+, a JDK supporting javac --release 8, Android SDK platform 33,' \
        'and build-tools with aapt2, d8.jar, apksigner.jar and zipalign -P 16 support.' \
        'Also requires standard POSIX utilities, curl or wget, and sha256sum or shasum.' \
        'Linux/macOS native SDKs and Git Bash with Windows SDK/JDK tools are supported.' \
        'Git Bash requires cygpath; D:/kits/android and /d/kits/android both work.' \
        'SDK default: ANDROID_SDK_ROOT, ANDROID_HOME, then a conventional local SDK path.' \
        'Reuses .tmp/android-capture-module/debug.keystore; never replaces an existing key.' \
        'Outputs the APK and build-result.json under ignored .tmp; does not use ADB.'
}

# /**
#  * Stop the build with a concise diagnostic.
#  * @param {string} message The reason the build cannot continue.
#  * @returns {void} Exits unsuccessfully.
#  */
die() { printf 'Build error: %s\n' "$*" >&2; exit 1; }

sdk_directory=''
jdk_directory=''
build_tools_version=''
output_directory=''
while (($#)); do
    case "$1" in
        --help|-h) show_help; exit 0 ;;
        --android-sdk-directory|--sdk|--jdk-directory|--jdk|--build-tools-version|--output-directory)
            (($# >= 2)) || die "Missing value for $1"
            case "$1" in
                --android-sdk-directory|--sdk) sdk_directory=$2 ;;
                --jdk-directory|--jdk) jdk_directory=$2 ;;
                --build-tools-version) build_tools_version=$2 ;;
                --output-directory) output_directory=$2 ;;
            esac
            shift 2 ;;
        *) die "Unknown argument: $1 (use --help)" ;;
    esac
done

windows_tools=false
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) windows_tools=true ;; esac
if "$windows_tools"; then
    command -v cygpath >/dev/null || die 'Git Bash/Cygwin requires cygpath.'
    # All native arguments below are explicitly converted, including classpaths.
    export MSYS2_ARG_CONV_EXCL='*'
    export MSYS_NO_PATHCONV=1
fi

# /**
#  * Normalize a user path for POSIX filesystem operations in the current shell.
#  * @param {string} path A native Windows or POSIX path.
#  * @returns {string} A POSIX path, without requiring the target to exist.
#  */
shell_path() {
    if "$windows_tools"; then cygpath -u -- "$1"; else printf '%s\n' "$1"; fi
}

# /**
#  * Resolve dot segments, existing symlinks and physical directory ancestors.
#  * @param {string} path A path whose final components may not yet exist.
#  * @returns {string} An absolute resolved path; refuses excessive symlink traversal.
#  */
canonical_path() {
    local path rest current component candidate target links=0
    path=$(shell_path "$1")
    if "$windows_tools" && command -v realpath >/dev/null; then
        realpath -m -- "$path"
        return
    fi
    case "$path" in /*) ;; *) path="$PWD/$path" ;; esac
    current='/'
    rest=${path#/}
    while [[ -n "$rest" ]]; do
        component=${rest%%/*}
        if [[ "$rest" == */* ]]; then rest=${rest#*/}; else rest=''; fi
        case "$component" in ''|.) continue ;; ..) current=$(dirname -- "$current"); continue ;; esac
        candidate="${current%/}/$component"
        if [[ -L "$candidate" ]]; then
            links=$((links + 1))
            ((links <= 40)) || die 'Too many symbolic links in a path.'
            target=$(readlink -- "$candidate") || die 'Cannot resolve a symbolic link.'
            target=$(shell_path "$target")
            case "$target" in /*) current='/'; target=${target#/} ;; esac
            if [[ -n "$rest" ]]; then rest="$target/$rest"; else rest=$target; fi
        elif [[ -d "$candidate" ]]; then
            current=$(cd -P -- "$candidate" && pwd -P) || die 'Cannot resolve a physical directory.'
        else
            current=$candidate
        fi
    done
    printf '%s\n' "$current"
}

# /**
#  * Convert a path for the SDK/JDK executables, without implicit MSYS conversion.
#  * @param {string} path An absolute POSIX path.
#  * @returns {string} Native Windows path on Git Bash, otherwise the input path.
#  */
native_path() {
    if "$windows_tools"; then cygpath -m -- "$1"; else printf '%s\n' "$1"; fi
}

script_directory=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repository_directory=$(cd -P -- "$script_directory/.." && pwd -P)
temporary_directory="$repository_directory/.tmp"
[[ ! -L "$temporary_directory" ]] || die 'The repository .tmp root must not be a symbolic link.'
[[ "$(canonical_path "$temporary_directory")" == "$temporary_directory" ]] || die 'The repository .tmp root escapes its physical path.'

# /**
#  * Require a physical path beneath the repository's own ignored .tmp directory.
#  * @param {string} path A candidate artifact path, including any existing symlinks.
#  * @returns {string} The validated canonical path; refuses the root itself and escapes.
#  */
checked_temporary_path() {
    local resolved
    resolved=$(canonical_path "$1")
    case "$resolved" in "$temporary_directory"/*) printf '%s\n' "$resolved" ;; *) die 'Artifact path must resolve beneath the repository .tmp directory.' ;; esac
}

# /**
#  * Validate an artifact file without following an existing file symlink.
#  * @param {string} path A cache, signing-key or published-artifact filename.
#  * @returns {string} A contained canonical path to a regular or not-yet-created file.
#  */
checked_artifact_path() {
    [[ ! -L "$1" ]] || die 'Artifact filenames must not be symbolic links.'
    [[ ! -e "$1" || -f "$1" ]] || die 'An artifact filename is occupied by a non-regular file.'
    checked_temporary_path "$1"
}

[[ -n "$output_directory" ]] || output_directory="$temporary_directory/android-capture-module"
output_directory=$(checked_temporary_path "$output_directory")
mkdir -p -- "$output_directory"
output_directory=$(checked_temporary_path "$output_directory")
dependencies_directory=$(checked_temporary_path "$output_directory/deps")
mkdir -p -- "$dependencies_directory"
dependencies_directory=$(checked_temporary_path "$dependencies_directory")
keystore_path=$(checked_artifact_path "$output_directory/debug.keystore")
final_apk=$(checked_artifact_path "$output_directory/android-capture-module-debug.apk")
report_path=$(checked_artifact_path "$output_directory/build-result.json")

# /**
#  * Resolve a native executable inside an SDK/JDK tool directory.
#  * @param {string} directory The tool directory.
#  * @param {string} name The executable's name without the optional .exe suffix.
#  * @returns {string} An executable path or an actionable error.
#  */
directory_tool() {
    if [[ -x "$1/$2" ]]; then printf '%s\n' "$1/$2"
    elif [[ -x "$1/$2.exe" ]]; then printf '%s\n' "$1/$2.exe"
    else die "Required executable is missing: $1/$2"; fi
}

[[ -n "$sdk_directory" ]] || sdk_directory=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
if [[ -z "$sdk_directory" ]]; then
    if "$windows_tools" && [[ -d /d/kits/android ]]; then sdk_directory=/d/kits/android
    elif [[ -d "${HOME:-}/Library/Android/sdk" ]]; then sdk_directory="${HOME}/Library/Android/sdk"
    elif [[ -d "${HOME:-}/Android/Sdk" ]]; then sdk_directory="${HOME}/Android/Sdk"
    else die 'Specify --android-sdk-directory or configure an Android SDK path.'; fi
fi
sdk_directory=$(canonical_path "$sdk_directory")
[[ -d "$sdk_directory" ]] || die 'The Android SDK directory does not exist.'
[[ -n "$jdk_directory" ]] || jdk_directory=${JAVA_HOME:-}
if [[ -n "$jdk_directory" ]]; then
    jdk_directory=$(canonical_path "$jdk_directory")
    java_tool=$(directory_tool "$jdk_directory/bin" java)
    javac_tool=$(directory_tool "$jdk_directory/bin" javac)
    jar_tool=$(directory_tool "$jdk_directory/bin" jar)
    keytool_tool=$(directory_tool "$jdk_directory/bin" keytool)
else
    java_tool=$(command -v java) || die 'java is missing; specify --jdk-directory.'
    javac_tool=$(command -v javac) || die 'javac is missing; specify --jdk-directory.'
    jar_tool=$(command -v jar) || die 'jar is missing; specify --jdk-directory.'
    keytool_tool=$(command -v keytool) || die 'keytool is missing; specify --jdk-directory.'
fi
if [[ -z "$build_tools_version" ]]; then
    best_major=-1; best_minor=-1; best_patch=-1
    for installed_directory in "$sdk_directory"/build-tools/*; do
        [[ -d "$installed_directory" ]] || continue
        installed_name=${installed_directory##*/}
        if [[ "$installed_name" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
            major=$((10#${BASH_REMATCH[1]})); minor=$((10#${BASH_REMATCH[2]})); patch=$((10#${BASH_REMATCH[3]}))
            if ((major > best_major || (major == best_major && minor > best_minor) || (major == best_major && minor == best_minor && patch > best_patch))); then
                build_tools_version=$installed_name; best_major=$major; best_minor=$minor; best_patch=$patch
            fi
        fi
    done
fi
[[ "$build_tools_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9]+)*$ ]] || die 'Specify a valid installed --build-tools-version.'
build_tools_directory="$sdk_directory/build-tools/$build_tools_version"
aapt2_tool=$(directory_tool "$build_tools_directory" aapt2)
zipalign_tool=$(directory_tool "$build_tools_directory" zipalign)
android_jar="$sdk_directory/platforms/android-33/android.jar"
d8_jar="$build_tools_directory/lib/d8.jar"
apksigner_jar="$build_tools_directory/lib/apksigner.jar"
for required_file in "$android_jar" "$d8_jar" "$apksigner_jar"; do [[ -f "$required_file" ]] || die "Required SDK file is missing: $required_file"; done

# /**
#  * Compute SHA256 using the standard hashing utility available on the host.
#  * @param {string} path The file to verify.
#  * @returns {string} Lowercase SHA256 digest.
#  */
sha256_file() {
    if command -v sha256sum >/dev/null; then sha256sum -- "$1" | awk '{print $1}'
    elif command -v shasum >/dev/null; then shasum -a 256 -- "$1" | awk '{print $1}'
    else die 'Install sha256sum or shasum to verify dependencies and APKs.'; fi
}

module_directory="$repository_directory/mobile/android-capture-module"
main_directory="$module_directory/app/src/main"
manifest_path="$main_directory/AndroidManifest.xml"
assets_directory="$main_directory/assets"
xposed_entry_path="$assets_directory/xposed_init"
[[ -f "$manifest_path" && -s "$xposed_entry_path" && -d "$main_directory/java" ]] || die 'Required module manifest, Java sources or Xposed asset is missing.'
min_api=$(sed -n 's/.*android:minSdkVersion="\([0-9][0-9]*\)".*/\1/p' "$manifest_path")
[[ "$min_api" == 33 ]] || die 'This local module build requires manifest minSdkVersion 33.'
build_directory=$(mktemp -d "$output_directory/build-$(date -u +%Y%m%dT%H%M%S)-XXXXXX")
build_directory=$(checked_temporary_path "$build_directory")
classes_directory="$build_directory/classes"
generated_directory="$build_directory/generated"
dex_directory="$build_directory/dex"
mkdir -p -- "$classes_directory" "$generated_directory" "$dex_directory"

# Official API 82 signature previously verified with rovo89's published master
# fingerprint 0DC82B3EB1C46D4833B4C434E82F08717235F333; API classes stay compile-only.
xposed_api_url='https://api.xposed.info/de/robv/android/xposed/api/82/api-82.jar'
xposed_api_sha256='f48c635f1c7469fdec0e00ad2ea0b7a6b2f5b55065784a35b7ca3a84615e8e25'
xposed_api_jar=$(checked_artifact_path "$dependencies_directory/api-82.jar")
if [[ ! -f "$xposed_api_jar" ]]; then
    download_path="$build_directory/api-82.download"
    printf '%s\n' 'Downloading the pinned official Xposed API 82 dependency.'
    if command -v curl >/dev/null; then curl --fail --location --silent --show-error --output "$(native_path "$download_path")" "$xposed_api_url"
    elif command -v wget >/dev/null; then wget -q -O "$(native_path "$download_path")" "$xposed_api_url"
    else die 'Install curl or wget to download the official Xposed API dependency.'; fi
    [[ "$(sha256_file "$download_path")" == "$xposed_api_sha256" ]] || die 'Downloaded API 82 JAR failed SHA256 verification.'
    mv -- "$download_path" "$xposed_api_jar"
fi
[[ "$(sha256_file "$xposed_api_jar")" == "$xposed_api_sha256" ]] || die 'Cached API 82 JAR failed SHA256 verification.'
android_jar_native=$(native_path "$android_jar")
xposed_api_native=$(native_path "$xposed_api_jar")
classpath_separator=':'
if "$windows_tools"; then classpath_separator=';'; fi
policy_tests_passed=false
policy_test="$module_directory/app/src/test/java/com/oneautojs6/capture/CapturePolicyTest.java"
if [[ -f "$policy_test" ]]; then
    test_classes="$build_directory/test-classes"
    mkdir -- "$test_classes"
    "$javac_tool" --release 8 -encoding UTF-8 -d "$(native_path "$test_classes")" \
        "$(native_path "$main_directory/java/com/oneautojs6/capture/CapturePolicy.java")" "$(native_path "$policy_test")"
    "$java_tool" -ea -cp "$(native_path "$test_classes")" com.oneautojs6.capture.CapturePolicyTest
    policy_tests_passed=true
fi

printf 'Building Android 13 module with build-tools %s.\n' "$build_tools_version"
resource_apk="$build_directory/resources.apk"
link_arguments=(link -o "$(native_path "$resource_apk")" --manifest "$(native_path "$manifest_path")" \
    -I "$android_jar_native" -A "$(native_path "$assets_directory")" --java "$(native_path "$generated_directory")" \
    --min-sdk-version "$min_api" --target-sdk-version 33)
resources_directory="$main_directory/res"
if [[ -d "$resources_directory" && -n "$(find "$resources_directory" -type f -print -quit)" ]]; then
    compiled_resources="$build_directory/compiled-res.zip"
    "$aapt2_tool" compile --dir "$(native_path "$resources_directory")" -o "$(native_path "$compiled_resources")"
    link_arguments+=("$(native_path "$compiled_resources")")
fi
"$aapt2_tool" "${link_arguments[@]}"
source_files=()
while IFS= read -r -d '' source_file; do source_files+=("$(native_path "$source_file")"); done < <(find "$main_directory/java" "$generated_directory" -type f -name '*.java' -print0)
((${#source_files[@]} > 0)) || die 'No module Java source files were found.'
"$javac_tool" --release 8 -encoding UTF-8 -cp "$android_jar_native$classpath_separator$xposed_api_native" \
    -d "$(native_path "$classes_directory")" "${source_files[@]}"
classes_jar="$build_directory/module-classes.jar"
"$jar_tool" --create --no-manifest --file "$(native_path "$classes_jar")" -C "$(native_path "$classes_directory")" .
"$jar_tool" tf "$(native_path "$classes_jar")" | tr -d '\r' > "$build_directory/class-entries.txt"
if grep -q '^de/robv/android/xposed/' "$build_directory/class-entries.txt"; then die 'Xposed API classes must not be bundled in the module.'; fi
"$java_tool" -Xmx1024M -cp "$(native_path "$d8_jar")" com.android.tools.r8.D8 --debug --min-api "$min_api" \
    --lib "$android_jar_native" --classpath "$xposed_api_native" --output "$(native_path "$dex_directory")" "$(native_path "$classes_jar")"
dex_arguments=(--update --file "$(native_path "$resource_apk")")
dex_count=0
for dex_file in "$dex_directory"/classes*.dex; do
    [[ -f "$dex_file" ]] || continue
    dex_arguments+=(-C "$(native_path "$dex_directory")" "${dex_file##*/}")
    dex_count=$((dex_count + 1))
done
((dex_count > 0)) || die 'D8 did not produce classes.dex.'
"$jar_tool" "${dex_arguments[@]}"

if [[ -e "$keystore_path" ]]; then
    [[ -f "$keystore_path" ]] || die 'Existing debug keystore is not a regular file; it will not be replaced.'
    printf '%s\n' 'Reusing the existing local debug keystore.'
else
    "$keytool_tool" -genkeypair -keystore "$(native_path "$keystore_path")" -storetype PKCS12 \
        -storepass android -keypass android -alias androiddebugkey -keyalg RSA -keysize 2048 \
        -validity 10000 -dname 'CN=Android Debug,O=one-autojs6,C=US'
fi
aligned_apk="$build_directory/aligned.apk"
signed_apk="$build_directory/android-capture-module-debug.apk"
"$zipalign_tool" -P 16 4 "$(native_path "$resource_apk")" "$(native_path "$aligned_apk")"
"$java_tool" -jar "$(native_path "$apksigner_jar")" sign --ks "$(native_path "$keystore_path")" --ks-key-alias androiddebugkey \
    --ks-pass pass:android --key-pass pass:android --v4-signing-enabled false --out "$(native_path "$signed_apk")" "$(native_path "$aligned_apk")"
"$java_tool" -jar "$(native_path "$apksigner_jar")" verify --verbose --print-certs "$(native_path "$signed_apk")"
"$zipalign_tool" -c -P 16 4 "$(native_path "$signed_apk")"
"$jar_tool" tf "$(native_path "$signed_apk")" | tr -d '\r' > "$build_directory/apk-entries.txt"
for required_entry in AndroidManifest.xml assets/xposed_init classes.dex; do
    [[ "$(grep -Fxc "$required_entry" "$build_directory/apk-entries.txt" | tr -d '\r')" == 1 ]] || die "Built APK is missing or duplicates $required_entry."
done
apk_check_directory="$build_directory/apk-check"
mkdir -- "$apk_check_directory"
(cd -- "$apk_check_directory" && "$jar_tool" xf "$(native_path "$signed_apk")" assets/xposed_init)
cmp -s -- "$xposed_entry_path" "$apk_check_directory/assets/xposed_init" || die 'The packaged Xposed entry-point asset differs from its source.'
final_apk=$(checked_artifact_path "$final_apk")
report_path=$(checked_artifact_path "$report_path")
cp -- "$signed_apk" "$build_directory/publish.apk"
mv -- "$build_directory/publish.apk" "$final_apk"
apk_sha256=$(sha256_file "$final_apk")
apk_bytes=$(wc -c < "$final_apk" | tr -d '[:space:]')

# /**
#  * Escape a filesystem path for the generated JSON build report.
#  * @param {string} value The string to serialize.
#  * @returns {string} A JSON-safe string body, without surrounding quotes.
#  */
json_escape() {
    local value=$1
    value=${value//\\/\\\\}; value=${value//\"/\\\"}
    value=${value//$'\n'/\\n}; value=${value//$'\r'/\\r}; value=${value//$'\t'/\\t}
    printf '%s' "$value"
}

printf '{\n  "apk": "%s",\n  "sha256": "%s",\n  "bytes": %s,\n  "buildTools": "%s",\n  "compileSdk": 33,\n  "xposedApi": 82,\n  "xposedApiSha256": "%s",\n  "policyTestsPassed": %s,\n  "signatureVerified": true,\n  "alignmentVerified": true,\n  "buildDirectory": "%s"\n}\n' \
    "$(json_escape "$(native_path "$final_apk")")" "$apk_sha256" "$apk_bytes" "$build_tools_version" "$xposed_api_sha256" \
    "$policy_tests_passed" "$(json_escape "$(native_path "$build_directory")")" > "$build_directory/build-result.json"
mv -- "$build_directory/build-result.json" "$report_path"
printf 'APK ready: %s\nSHA256: %s\nBuild report: %s\n' "$final_apk" "$apk_sha256" "$report_path"
