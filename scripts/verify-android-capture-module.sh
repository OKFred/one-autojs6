#!/usr/bin/env bash
set -Eeuo pipefail

# /** Prints dependencies, fixed scope and recovery limitations. @returns No value. */
usage() {
  printf '%s\n' \
    'Usage: bash scripts/verify-android-capture-module.sh [--adb PATH] [--serial SERIAL]' \
    '       [--output DIRECTORY] [--timeout SECONDS] [--jdk DIRECTORY]' \
    'Requires Bash 4+, GNU coreutils (timeout, realpath, base64, mktemp) and a JDK.' \
    'Supports Git Bash on Windows and Linux; no PowerShell or Python is used.' \
    'Run only with the non-sensitive FixtureActivity already foreground on API 33,' \
    'user 0/display 0, one resumed activity, and the global toggle absent or exactly 0.' \
    'Root and a loaded legacy-compatible Android-system hook must already work.' \
    'This restarts only com.oneautojs6.capture, briefly enables the GLOBAL toggle,' \
    'and checks root screencap PNGs. Use a test screen without sensitive notifications' \
    'or overlays; focus snapshots cannot exclude changes between checks.' \
    'It does not install, reboot, record, or open business apps. It restores the toggle' \
    'but does not restore the original fixture mode. Disconnects, SIGKILL or machine' \
    'failure can prevent trap recovery. In that case manually restore the fixed key:' \
    '  adb -s SERIAL shell '\''su -c "settings put global one_autojs6_secure_capture_enabled 0"'\''' \
    'Use settings delete global with the same fixed key if it was initially absent.' \
    'All generated artifacts stay below the repository .tmp directory. Raw dumps' \
    'and device serials are never stored. Other capture routes need separate checks.'
}

adb_tool=''
serial=''
output_dir=''
command_timeout=20
jdk_dir=''
while (($#)); do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --adb|--serial|--output|--timeout|--jdk)
      (($# >= 2)) || { printf '%s\n' 'A command option is missing its value.' >&2; exit 2; }
      case "$1" in
        --adb) adb_tool=$2 ;; --serial) serial=$2 ;; --output) output_dir=$2 ;;
        --timeout) command_timeout=$2 ;; --jdk) jdk_dir=$2 ;;
      esac
      shift 2 ;;
    *) printf '%s\n' 'Unknown command option; use --help.' >&2; exit 2 ;;
  esac
done
((BASH_VERSINFO[0] >= 4)) || { printf '%s\n' 'Bash 4 or newer is required.' >&2; exit 2; }
[[ $command_timeout =~ ^([1-9]|[12][0-9]|30)$ ]] || { printf '%s\n' 'Timeout must be an integer from 1 to 30 seconds.' >&2; exit 2; }
for required_tool in timeout realpath base64 mktemp date sleep mkdir find tr cat; do
  command -v "$required_tool" >/dev/null || { printf 'Required tool is missing: %s\n' "$required_tool" >&2; exit 2; }
done
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
windows_paths=false
command -v cygpath >/dev/null && windows_paths=true

# /** Converts native Windows arguments to Bash paths. @param path Tool or output path. @returns Bash path. */
shell_path() { if $windows_paths; then cygpath -u -- "$1"; else printf '%s\n' "$1"; fi; }
# /** Converts a Bash file path for native Java. @param path Existing or prospective path. @returns Native absolute path. */
java_path() { if $windows_paths; then cygpath -am -- "$1"; else printf '%s\n' "$1"; fi; }
# /** Compares canonical paths using host filesystem case rules. @param left First path. @param right Second path. @returns Comparison status. */
same_path() { if $windows_paths; then [[ ${1,,} == "${2,,}" ]]; else [[ $1 == "$2" ]]; fi; }

temp_dir="$repo_dir/.tmp"
mkdir -p -- "$temp_dir"
temp_real=$(realpath -- "$temp_dir")
same_path "$temp_real" "$temp_dir" || { printf '%s\n' 'Repository .tmp must not resolve through a symlink outside its expected path.' >&2; exit 2; }

# /** Resolves output paths and refuses symlink escape from .tmp. @param path Candidate output. @returns Canonical path. */
inside_temp() {
  local resolved compare prefix
  resolved=$(realpath -m -- "$1")
  compare=$resolved; prefix=$temp_real/
  if $windows_paths; then compare=${compare,,}; prefix=${prefix,,}; fi
  [[ $compare == "$prefix"* ]] || { printf '%s\n' 'Output must resolve beneath repository .tmp.' >&2; return 1; }
  printf '%s\n' "$resolved"
}

if [[ -z $output_dir ]]; then
  artifact_parent=$(inside_temp "$temp_dir/android-capture-module")
  mkdir -p -- "$artifact_parent"
  output_dir=$(mktemp -d "$artifact_parent/verify-$(date -u +%Y%m%dT%H%M%S)-XXXXXX")
else
  output_dir=$(inside_temp "$(shell_path "$output_dir")")
  [[ ! -e $output_dir || -d $output_dir ]] || { printf '%s\n' 'Output must be a directory.' >&2; exit 2; }
  [[ ! -d $output_dir || -z $(find "$output_dir" -mindepth 1 -print -quit) ]] || { printf '%s\n' 'Output must be empty to preserve previous evidence.' >&2; exit 2; }
  mkdir -p -- "$output_dir"
fi
output_dir=$(inside_temp "$output_dir")
if [[ -n $jdk_dir ]]; then
  jdk_dir=$(shell_path "$jdk_dir")
  java_tool="$jdk_dir/bin/java"; javac_tool="$jdk_dir/bin/javac"
  [[ -x $java_tool ]] || java_tool+=.exe
  [[ -x $javac_tool ]] || javac_tool+=.exe
else
  java_tool=$(command -v java || command -v java.exe || true)
  javac_tool=$(command -v javac || command -v javac.exe || true)
fi
[[ -n $java_tool && -x $java_tool && -n $javac_tool && -x $javac_tool ]] || { printf '%s\n' 'A working JDK with java and javac is required.' >&2; exit 2; }
if [[ -z $adb_tool ]]; then
  adb_tool=$(command -v adb || command -v adb.exe || true)
  if [[ -z $adb_tool && -x /d/kits/android/platform-tools/adb.exe ]]; then adb_tool=/d/kits/android/platform-tools/adb.exe; fi
else
  adb_tool=$(shell_path "$adb_tool")
fi
[[ -n $adb_tool && -x $adb_tool ]] || { printf '%s\n' 'The ADB executable was not found; specify --adb.' >&2; exit 2; }
class_dir=$(mktemp -d "$output_dir/.helper-XXXXXX")
MSYS2_ARG_CONV_EXCL='*' "$javac_tool" --release 8 -encoding UTF-8 -d "$(java_path "$class_dir")" \
  "$(java_path "$repo_dir/scripts/lib/android-capture-verifier.java")"
native_classes=$(java_path "$class_dir")

# /** Runs only the pure Java helper. @param arguments Fixed computation arguments. @returns Helper output. */
helper() { MSYS2_ARG_CONV_EXCL='*' "$java_tool" -Dfile.encoding=UTF-8 -Djava.awt.headless=true -cp "$native_classes" CaptureVerifier "$@" | tr -d '\r'; }
# /** Runs bounded ADB and suppresses raw stderr. @param arguments Fixed ADB argv. @returns Text or bytes without serial logging. */
adb_call() { MSYS2_ARG_CONV_EXCL='*' timeout --foreground --kill-after=5s "${command_timeout}s" "$adb_tool" "${device_args[@]}" "$@" 2>/dev/null; }
# /** Removes transport CRs and surrounding whitespace from fixed scalar readback. @returns Trimmed text. */
trim_text() { local value; value=$(cat); value=${value//$'\r'/}; value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"; printf '%s' "$value"; }
# /** Stops with a fixed non-sensitive code. @param code Failure code. @returns No value. */
die() { failure=$1; printf '%s\n' "$1" >&2; exit 1; }

device_args=()
initial_setting=''
have_initial=false
mutation_started=false
default_off=false
dynamic_observed=false
passed=false
setting_restored=false
failure=''
restoration_failure=''
stages=''
controller_pid=$BASHPID

# /** Attempts fixed-key restoration and writes the sanitized report on every normal exit. @param status Original exit status. @returns Final exit status. */
finish() {
  local status=$1 restored_value
  [[ $BASHPID == "$controller_pid" ]] || return 0
  trap - EXIT ERR INT TERM
  set +e
  if $have_initial; then
    if $mutation_started; then
      if [[ $initial_setting == null ]]; then
        adb_call shell 'su -c "settings delete global one_autojs6_secure_capture_enabled"' >/dev/null
      else
        adb_call shell 'su -c "settings put global one_autojs6_secure_capture_enabled 0"' >/dev/null
      fi
      if (($? != 0)); then restoration_failure=TOGGLE_RESTORE_FAILED; fi
    fi
    restored_value=$(adb_call shell settings get global one_autojs6_secure_capture_enabled | trim_text)
    if (($? == 0)) && [[ $restored_value == "$initial_setting" && -z $restoration_failure ]]; then
      setting_restored=true
    else
      restoration_failure=TOGGLE_RESTORE_UNVERIFIED; passed=false; status=1
      [[ -n $failure ]] || failure=TOGGLE_RESTORE_UNVERIFIED
    fi
  fi
  if ((status != 0)); then passed=false; [[ -n $failure ]] || failure=VERIFICATION_FAILED; fi
  if ! printf '%s' "$stages" | helper report "$initial_setting" "$default_off" "$dynamic_observed" "$passed" "$setting_restored" "$failure" "$restoration_failure" \
      > "$output_dir/verification-result.json"; then
    printf '%s\n' 'REPORT_WRITE_FAILED' >&2; status=1
  fi
  printf 'Fixture verification report: %s/verification-result.json\n' "$output_dir"
  exit "$status"
}
trap 'finish "$?"' EXIT
trap 'failure=${failure:-VERIFICATION_FAILED}' ERR
trap 'failure=INTERRUPTED; exit 130' INT
trap 'failure=INTERRUPTED; exit 143' TERM

# /** Reads both dumps only into memory and requires the exact fixture. @param token Optional window. @param secure Optional flag. @returns Guard state TSV. */
get_guard() {
  local activities windows
  activities=$(adb_call shell dumpsys activity activities) || die ACTIVITY_QUERY_FAILED
  windows=$(adb_call shell dumpsys window) || die WINDOW_QUERY_FAILED
  printf '%s\0%s' "$activities" "$windows" | helper guard "${1:-}" "${2:-}"
}
# /** Restarts only the fixture for a fixed mode. @param mode plain/secure/dynamic. @param token Previous window. @returns New guard state TSV. */
start_mode() {
  local mode=$1 previous=$2 launch state activity window secure
  get_guard "$previous" >/dev/null
  adb_call shell am force-stop --user 0 com.oneautojs6.capture >/dev/null || die FIXTURE_STOP_FAILED
  launch=$(adb_call shell am start -W --user 0 -n com.oneautojs6.capture/.FixtureActivity --es mode "$mode") || die FIXTURE_START_FAILED
  [[ $launch =~ (^|$'\n')Status:[[:space:]]+ok[[:space:]]*($|$'\n') ]] || die FIXTURE_START_FAILED
  [[ ! $launch =~ (^|$'\n')[[:space:]]*(Error|Exception) ]] || die FIXTURE_START_FAILED
  case "$mode" in plain) state=$(get_guard '' false) ;; secure) state=$(get_guard '' true) ;; dynamic) state=$(get_guard) ;; *) die FIXTURE_MODE_INVALID ;; esac
  IFS=$'\t' read -r activity window secure <<< "$state"
  [[ $window != "$previous" ]] || die FIXTURE_WINDOW_NOT_REPLACED
  printf '%s\n' "$state"
}
# /** Writes only the fixed toggle after a same-window guard. @param value 1 or 0. @param token Window. @returns No value. */
set_toggle() {
  local value=$1 window=$2 readback
  get_guard "$window" >/dev/null
  mutation_started=true
  case "$value" in
    1) adb_call shell 'su -c "settings put global one_autojs6_secure_capture_enabled 1"' >/dev/null || die TOGGLE_WRITE_FAILED ;;
    0) adb_call shell 'su -c "settings put global one_autojs6_secure_capture_enabled 0"' >/dev/null || die TOGGLE_WRITE_FAILED ;;
    *) die TOGGLE_VALUE_INVALID ;;
  esac
  readback=$(adb_call shell settings get global one_autojs6_secure_capture_enabled | trim_text)
  [[ $readback == "$value" ]] || die TOGGLE_READBACK_FAILED
  sleep 0.75
}
# /** Keeps PNG transport bytes in memory until both guards pass. @param stage Fixed filename. @param window Token. @param secure Flag. @param visible Expected palette. @param baseline Optional TSV. @returns Updates metrics/stage evidence. */
capture() {
  local stage=$1 window=$2 secure=$3 visible=$4 baseline=${5:-} encoded measured status=0 png_path
  get_guard "$window" "$secure" >/dev/null
  encoded=$(adb_call exec-out 'su -c "screencap -p"' | helper encode-png) || die SCREENSHOT_COMMAND_FAILED
  [[ ${#encoded} -le 27962028 ]] || die PNG_BYTE_LENGTH_INVALID
  get_guard "$window" "$secure" >/dev/null
  png_path="$output_dir/$stage.png"
  printf '%s' "$encoded" | base64 --decode > "$png_path" || die PNG_ENCODING_INVALID
  measured=$(helper measure "$(java_path "$png_path")" "$stage" "$secure" "$visible" "$baseline") || status=$?
  [[ $measured == *$'\n'* ]] || die PNG_CALCULATION_FAILED
  last_metrics=${measured%%$'\n'*}
  stages+="${measured#*$'\n'}"$'\n'
  ((status == 0)) || die FIXTURE_PIXEL_VALIDATION_FAILED
}

devices=$(adb_call devices) || die DEVICE_DISCOVERY_FAILED
authorized=()
while IFS= read -r line; do
  line=${line//$'\r'/}
  if [[ $line =~ ^([^[:space:]]+)[[:space:]]+device[[:space:]]*$ ]]; then authorized+=("${BASH_REMATCH[1]}"); fi
done <<< "$devices"
if [[ -z $serial ]]; then
  ((${#authorized[@]} == 1)) || die DEVICE_SELECTION_REQUIRED
  serial=${authorized[0]}
fi
matching=0
for device in "${authorized[@]}"; do [[ $device != "$serial" ]] || matching=$((matching + 1)); done
((matching == 1)) || die DEVICE_SELECTION_INVALID
device_args=(-s "$serial")
sdk=$(adb_call shell getprop ro.build.version.sdk | trim_text)
[[ $sdk == 33 ]] || die ANDROID_API_NOT_SUPPORTED
initial_state=$(get_guard)
IFS=$'\t' read -r activity initial_window secure <<< "$initial_state"
root_uid=$(adb_call shell 'su -c "id -u"' | trim_text)
[[ $root_uid == 0 ]] || die ROOT_AUTHORIZATION_REQUIRED
initial_setting=$(adb_call shell settings get global one_autojs6_secure_capture_enabled | trim_text)
[[ $initial_setting == null || $initial_setting == 0 ]] || die INITIAL_TOGGLE_MUST_BE_OFF
have_initial=true; default_off=true

state=$(start_mode plain "$initial_window")
IFS=$'\t' read -r activity plain_window secure <<< "$state"
capture 00-plain-off "$plain_window" false true
baseline=$last_metrics
state=$(start_mode secure "$plain_window")
IFS=$'\t' read -r activity secure_window secure <<< "$state"
capture 01-secure-off "$secure_window" true false "$baseline"
set_toggle 1 "$secure_window"
capture 02-same-window-on "$secure_window" true true "$baseline"
set_toggle 0 "$secure_window"
capture 03-same-window-off "$secure_window" true false "$baseline"
set_toggle 1 "$secure_window"
state=$(start_mode secure "$secure_window")
IFS=$'\t' read -r activity fresh_window secure <<< "$state"
capture 04-new-secure-on "$fresh_window" true true "$baseline"
state=$(start_mode dynamic "$fresh_window")
IFS=$'\t' read -r activity dynamic_window dynamic_initial <<< "$state"
deadline=$((SECONDS + 8))
while :; do
  state=$(get_guard "$dynamic_window")
  IFS=$'\t' read -r activity window dynamic_secure <<< "$state"
  [[ $dynamic_secure != true ]] || break
  ((SECONDS < deadline)) || die DYNAMIC_FLAG_TIMEOUT
  sleep 0.2
done
[[ $dynamic_initial != false ]] || dynamic_observed=true
capture 05-dynamic-secure-on "$dynamic_window" true true "$baseline"
passed=true
