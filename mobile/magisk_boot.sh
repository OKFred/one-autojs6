#!/system/bin/sh
# Magisk boot script for one-autojs6 EMQX daemon

LOG_FILE="/sdcard/Download/emqx_boot.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] autojs6_emqx.sh triggered by Magisk" > "$LOG_FILE"

# 0. Initial delay
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sleeping for 15 seconds before proceeding..." >> "$LOG_FILE"
sleep 15

# 1. Wait for boot to complete (with a 3-minute timeout limit)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for system boot..." >> "$LOG_FILE"
BOOT_READY=0
for i in $(seq 1 90); do
    if [ "$(getprop sys.boot_completed)" = "1" ]; then
        BOOT_READY=1
        break
    fi
    sleep 2
done

if [ "$BOOT_READY" -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] System boot completed." >> "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: Boot wait timeout (3 mins), continuing anyway..." >> "$LOG_FILE"
fi

# 2. Wait for network (with a 90-second timeout limit)
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for network..." >> "$LOG_FILE"
NETWORK_READY=0
for i in $(seq 1 30); do
    if ping -c 1 -W 2 223.5.5.5 >/dev/null 2>&1; then
        NETWORK_READY=1
        break
    fi
    sleep 3
done

if [ "$NETWORK_READY" -eq 1 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Network is up. Starting Termux daemon..." >> "$LOG_FILE"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Warning: Network timeout (90s), but trying to start daemon anyway." >> "$LOG_FILE"
fi

# 3. Define the path for the daemon script
DAEMON_SCRIPT="/data/data/com.termux/files/home/workspace/one-autojs6/mobile/node_daemon.sh"

if [ ! -f "$DAEMON_SCRIPT" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Error: $DAEMON_SCRIPT not found!" >> "$LOG_FILE"
    exit 1
fi

# 4. Run the script as Termux user (u0_a256) with full Termux environment and required groups
su -G 3003 -G 9997 -G 1078 -G 3009 u0_a256 -c "export ANDROID_DATA='/data' ANDROID_ROOT='/system' HOME='/data/data/com.termux/files/home' PREFIX='/data/data/com.termux/files/usr' TMPDIR='/data/data/com.termux/files/usr/tmp' LD_PRELOAD='/data/data/com.termux/files/usr/lib/libtermux-exec-ld-preload.so' PATH='/data/data/com.termux/files/usr/bin:/data/data/com.termux/files/usr/bin/applets:\$PATH' TERM='xterm-256color'; bash $DAEMON_SCRIPT" >> "$LOG_FILE" 2>&1 &


echo "[$(date '+%Y-%m-%d %H:%M:%S')] Daemon started in background." >> "$LOG_FILE"
