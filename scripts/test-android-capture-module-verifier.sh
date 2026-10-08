#!/usr/bin/env bash
set -Eeuo pipefail

# /** Implements a synthetic ADB process; never invokes or discovers a real device. @param arguments Fixed test argv. @returns Synthetic transport output. */
fake_adb() {
  local directory=$CAPTURE_TEST_STATE setting mode window_id dynamic_queries token flags palette command
  IFS=' ' read -r setting mode window_id dynamic_queries < "$directory/state"
  if [[ ${1:-} == -s ]]; then [[ ${2:-} == capture-fixture-only ]] || return 91; shift 2; fi
  command="$*"
  printf '%s\n' "$command" >> "$directory/commands"
  case "$command" in
    devices)
      printf 'List of devices attached\ncapture-fixture-only\tdevice\n'
      [[ ${CAPTURE_TEST_MULTI_DEVICE:-0} != 1 ]] || printf 'capture-other-fixture\tdevice\n'
      return 0 ;;
    'shell getprop ro.build.version.sdk') printf '33\n'; return 0 ;;
    'shell su -c "id -u"') printf '0\n'; return 0 ;;
    'shell settings get global one_autojs6_secure_capture_enabled') printf '%s\n' "$setting"; return 0 ;;
    'shell su -c "settings put global one_autojs6_secure_capture_enabled 1"') setting=1 ;;
    'shell su -c "settings put global one_autojs6_secure_capture_enabled 0"') setting=0 ;;
    'shell su -c "settings delete global one_autojs6_secure_capture_enabled"') setting=null ;;
    'shell am force-stop --user 0 com.oneautojs6.capture') return 0 ;;
    'shell am start -W --user 0 -n com.oneautojs6.capture/.FixtureActivity --es mode '* )
      mode=${!#}; [[ $mode == plain || $mode == secure || $mode == dynamic ]] || return 92
      window_id=$((window_id + 1)); dynamic_queries=0
      printf 'Status: ok\n';;
    'shell dumpsys activity activities')
      if [[ -e $directory/lost-foreground ]]; then
        printf 'topResumedActivity=ActivityRecord{aa11 u0 com.example.other/.OtherActivity t1}\n'
      else
        printf 'topResumedActivity=ActivityRecord{aa11 u0 com.oneautojs6.capture/.FixtureActivity t1}\n'
      fi
      return 0 ;;
    'shell dumpsys window')
      printf -v token '%x' "$window_id"
      flags='KEEP_SCREEN_ON HARDWARE_ACCELERATED'
      if [[ $mode == secure || ( $mode == dynamic && $dynamic_queries -gt 0 ) ]]; then flags+=' SECURE'; fi
      [[ $mode != dynamic ]] || dynamic_queries=$((dynamic_queries + 1))
      printf 'WINDOW MANAGER WINDOWS\n  Window #0 Window{%s u0 com.oneautojs6.capture/.FixtureActivity}:\n' "$token"
      printf '    mDisplayId=0 rootTaskId=1 mSession=synthetic\n'
      printf '    mOwnerUid=10000 showForAllUsers=false package=com.oneautojs6.capture appop=NONE\n'
      printf '    mAttrs={(0,0)(fillxfill) ty=BASE_APPLICATION\n      fl=%s\n' "$flags"
      printf '      fitTypes=STATUS_BARS NAVIGATION_BARS}\n    Requested w=400 h=800 mLayoutSeq=1\n'
      printf '  mCurrentFocus=Window{%s u0 com.oneautojs6.capture/.FixtureActivity}\n' "$token" ;;
    'exec-out su -c "screencap -p"')
      if [[ $setting == 1 && $mode == secure ]]; then
        [[ ${CAPTURE_TEST_FAIL_CAPTURE:-0} != 1 ]] || return 93
        [[ ${CAPTURE_TEST_TIMEOUT_CAPTURE:-0} != 1 ]] || sleep 10
      fi
      palette=black
      [[ $setting != 1 && $mode != plain ]] || palette=visible
      MSYS2_ARG_CONV_EXCL='*' "$CAPTURE_TEST_JAVA" -Djava.awt.headless=true -cp "$CAPTURE_TEST_CLASSES" CaptureVerifier fixture-png "$palette"
      if [[ $setting == 1 && $mode == secure && ${CAPTURE_TEST_LOSE_FOREGROUND:-0} == 1 ]]; then : > "$directory/lost-foreground"; fi
      return 0 ;;
    *) printf '%s\n' 'UNEXPECTED_SYNTHETIC_ADB_COMMAND' >&2; return 94 ;;
  esac
  printf '%s %s %s %s\n' "$setting" "$mode" "$window_id" "$dynamic_queries" > "$directory/state"
}
if [[ ${CAPTURE_TEST_FAKE_ADB:-0} == 1 ]]; then fake_adb "$@"; exit $?; fi

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' 'Usage: bash scripts/test-android-capture-module-verifier.sh [--jdk DIRECTORY]' \
    'Requires Bash 4+, GNU coreutils and a JDK; supports Git Bash on Windows/Linux.' \
    'Runs the 32 strict guard cases, PNG limits/palette checks and synthetic ADB' \
    'success/failure/timeout/foreground-loss restoration cases. No real ADB is used.' \
    'Synthetic artifacts and compiled helper classes remain under repository .tmp.'
  exit 0
fi
jdk_dir=''
if (($#)); then
  [[ $# == 2 && $1 == --jdk ]] || { printf '%s\n' 'Unknown test option; use --help.' >&2; exit 2; }
  jdk_dir=$2
fi
((BASH_VERSINFO[0] >= 4)) || { printf '%s\n' 'Bash 4 or newer is required.' >&2; exit 2; }
for required_tool in timeout realpath base64 mktemp date sleep mkdir find tr cat cp chmod; do
  command -v "$required_tool" >/dev/null || { printf 'Required tool is missing: %s\n' "$required_tool" >&2; exit 2; }
done
repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
windows_paths=false
command -v cygpath >/dev/null && windows_paths=true

# /** Converts Bash paths for native Java. @param path Bash path. @returns Native path. */
native_path() { if $windows_paths; then cygpath -am -- "$1"; else printf '%s\n' "$1"; fi; }
# /** Compares canonical host paths. @param left First path. @param right Second path. @returns Comparison status. */
same_path() { if $windows_paths; then [[ ${1,,} == "${2,,}" ]]; else [[ $1 == "$2" ]]; fi; }
temp_dir="$repo_dir/.tmp"
mkdir -p -- "$temp_dir"
same_path "$(realpath -- "$temp_dir")" "$temp_dir" || { printf '%s\n' 'Repository .tmp must have its expected canonical location.' >&2; exit 2; }
test_dir=$(mktemp -d "$temp_dir/capture-verifier-test-XXXXXX")
if [[ -n $jdk_dir ]]; then
  $windows_paths && jdk_dir=$(cygpath -u -- "$jdk_dir")
  java_tool="$jdk_dir/bin/java"; javac_tool="$jdk_dir/bin/javac"
  [[ -x $java_tool ]] || java_tool+=.exe
  [[ -x $javac_tool ]] || javac_tool+=.exe
else
  java_tool=$(command -v java || command -v java.exe || true)
  javac_tool=$(command -v javac || command -v javac.exe || true)
fi
[[ -n $java_tool && -x $java_tool && -n $javac_tool && -x $javac_tool ]] || { printf '%s\n' 'A working JDK is required.' >&2; exit 2; }
mkdir -- "$test_dir/classes"
native_classes=$(native_path "$test_dir/classes")
MSYS2_ARG_CONV_EXCL='*' "$javac_tool" --release 8 -encoding UTF-8 -d "$native_classes" "$(native_path "$repo_dir/scripts/lib/android-capture-verifier.java")"
MSYS2_ARG_CONV_EXCL='*' "$java_tool" -Djava.awt.headless=true -cp "$native_classes" CaptureVerifier self-test
bash -n "$repo_dir/scripts/verify-android-capture-module.sh"
fake_tool="$test_dir/fake-adb"
cp -- "${BASH_SOURCE[0]}" "$fake_tool"
chmod u+x -- "$fake_tool"
export CAPTURE_TEST_FAKE_ADB=1 CAPTURE_TEST_JAVA="$java_tool" CAPTURE_TEST_CLASSES="$native_classes"
verifier_args=()
[[ -z $jdk_dir ]] || verifier_args=(--jdk "$jdk_dir")
lifecycle_count=0

# /** Executes the real Bash verifier against a synthetic transport only. @param name Fixed case. @param initial Initial toggle. @param outcome Expected success/failure. @returns No value. */
run_case() {
  local name=$1 initial=$2 outcome=$3 directory report_prefix actual_setting mode window dynamic status=0
  directory="$test_dir/$name"
  mkdir -- "$directory"
  printf '%s secure 4520 0\n' "$initial" > "$directory/state"
  export CAPTURE_TEST_STATE="$directory"
  bash "$repo_dir/scripts/verify-android-capture-module.sh" --adb "$fake_tool" --serial capture-fixture-only \
    --timeout 1 --output "$directory/output" "${verifier_args[@]}" > "$directory/stdout" 2> "$directory/stderr" || status=$?
  IFS=' ' read -r actual_setting mode window dynamic < "$directory/state"
  [[ $actual_setting == "$initial" ]] || { printf 'Synthetic lifecycle restoration failed: %s\n' "$name" >&2; exit 1; }
  report_prefix=$(< "$directory/output/verification-result.json")
  report_prefix=${report_prefix%%,\"stages\":*}
  [[ $report_prefix != *capture-fixture-only* ]] || { printf '%s\n' 'A serial leaked into the report.' >&2; exit 1; }
  if [[ $outcome == pass ]]; then
    [[ $status == 0 && $report_prefix == *'"passed":true'* && $report_prefix == *'"settingRestored":true'* \
      && $report_prefix == *'"observedDynamicTransition":true'* ]] || { printf 'Synthetic success case failed: %s\n' "$name" >&2; exit 1; }
  else
    [[ $status != 0 && $report_prefix == *'"passed":false'* ]] || { printf 'Synthetic failure case passed: %s\n' "$name" >&2; exit 1; }
    if [[ $initial != 1 ]]; then
      [[ $report_prefix == *'"settingRestored":true'* ]] || { printf 'Synthetic failure restoration unverified: %s\n' "$name" >&2; exit 1; }
    fi
  fi
  if [[ $name == foreground-loss ]]; then
    [[ ! -e $directory/output/02-same-window-on.png ]] || { printf '%s\n' 'PNG was saved after a failed foreground guard.' >&2; exit 1; }
  fi
  lifecycle_count=$((lifecycle_count + 1))
}

run_case absent-success null pass
run_case zero-success 0 pass
export CAPTURE_TEST_FAIL_CAPTURE=1
run_case screenshot-failure 0 fail
unset CAPTURE_TEST_FAIL_CAPTURE
export CAPTURE_TEST_LOSE_FOREGROUND=1
run_case foreground-loss null fail
unset CAPTURE_TEST_LOSE_FOREGROUND
export CAPTURE_TEST_TIMEOUT_CAPTURE=1
run_case screenshot-timeout 0 fail
unset CAPTURE_TEST_TIMEOUT_CAPTURE
run_case initially-enabled 1 fail
printf 'Bash verifier synthetic lifecycle tests: PASS (%s cases; no real ADB).\n' "$lifecycle_count"
printf 'Synthetic test artifacts: %s\n' "$test_dir"
