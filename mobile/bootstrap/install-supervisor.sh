#!/bin/bash
set -euo pipefail

# 一次性将已经解包的受信任发布目录迁移为 supervisor 管理的布局。
if [ "$#" -lt 4 ] || [ "$#" -gt 5 ]; then
    echo "Usage: $0 RELEASE_DIR ENVIRONMENT REVISION CONFIG_FILE [SECRETS_FILE]" >&2
    exit 2
fi

RELEASE_SOURCE="$(cd "$1" && pwd)"
ENVIRONMENT="$2"
REVISION="$3"
CONFIG_SOURCE="$(cd "$(dirname "$4")" && pwd)/$(basename "$4")"
SECRETS_SOURCE=""
if [ "$#" -eq 5 ]; then
    SECRETS_SOURCE="$(cd "$(dirname "$5")" && pwd)/$(basename "$5")"
fi

case "$ENVIRONMENT" in
    development|staging|production) ;;
    *) echo "Unsupported environment: $ENVIRONMENT" >&2; exit 2 ;;
esac

DEPLOYMENT_ROOT="${AUTOJS6_DEPLOYMENT_ROOT:-$HOME/.local/share/one-autojs6}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PACKAGE_VERSION="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!/^v\d+\.\d+\.\d+/.test(p.releaseVersion))process.exit(2);process.stdout.write(p.releaseVersion)' "$RELEASE_SOURCE/release-manifest.json")"
RELEASE_DIGEST="${AUTOJS6_BOOTSTRAP_RELEASE_DIGEST:-}"
if [ -z "$RELEASE_DIGEST" ] && [ -f "$RELEASE_SOURCE/.artifact-sha256" ]; then
    RELEASE_DIGEST="$(tr -d '[:space:]' < "$RELEASE_SOURCE/.artifact-sha256")"
fi
if ! printf '%s' "$RELEASE_DIGEST" | grep -Eq '^[0-9a-f]{64}$'; then
    echo "Set AUTOJS6_BOOTSTRAP_RELEASE_DIGEST to the verified archive SHA-256." >&2
    exit 2
fi
TARGET_RELEASE="$DEPLOYMENT_ROOT/releases/$PACKAGE_VERSION"

mkdir -p "$DEPLOYMENT_ROOT/bootstrap" "$DEPLOYMENT_ROOT/device" \
    "$DEPLOYMENT_ROOT/releases" \
    "$DEPLOYMENT_ROOT/environments/$ENVIRONMENT/revisions" \
    "$DEPLOYMENT_ROOT/secrets" "$DEPLOYMENT_ROOT/state/shared" \
    "$DEPLOYMENT_ROOT/state/$ENVIRONMENT" "$DEPLOYMENT_ROOT/logs/$ENVIRONMENT" \
    "$DEPLOYMENT_ROOT/run"

if [ -e "$TARGET_RELEASE" ]; then
    echo "Release already exists: $TARGET_RELEASE" >&2
    exit 1
fi
cp -a "$RELEASE_SOURCE" "$TARGET_RELEASE"
SUPERVISOR_TARGET="$DEPLOYMENT_ROOT/bootstrap/supervisor.mjs"
SUPERVISOR_TEMP="$SUPERVISOR_TARGET.$$.tmp"
cp "$SCRIPT_DIR/supervisor.mjs" "$SUPERVISOR_TEMP"
chmod 500 "$SUPERVISOR_TEMP"
mv -f "$SUPERVISOR_TEMP" "$SUPERVISOR_TARGET"
DAEMON_TARGET="$DEPLOYMENT_ROOT/bootstrap/node_daemon.sh"
DAEMON_TEMP="$DAEMON_TARGET.$$.tmp"
cp "$SCRIPT_DIR/../node_daemon.sh" "$DAEMON_TEMP"
chmod 500 "$DAEMON_TEMP"
mv -f "$DAEMON_TEMP" "$DAEMON_TARGET"
cp "$CONFIG_SOURCE" "$DEPLOYMENT_ROOT/environments/$ENVIRONMENT/revisions/$REVISION.json"
chmod 600 "$DEPLOYMENT_ROOT/environments/$ENVIRONMENT/revisions/$REVISION.json"
if [ -n "$SECRETS_SOURCE" ]; then
    cp "$SECRETS_SOURCE" "$DEPLOYMENT_ROOT/secrets/$ENVIRONMENT.env"
    chmod 600 "$DEPLOYMENT_ROOT/secrets/$ENVIRONMENT.env"
elif [ ! -e "$DEPLOYMENT_ROOT/secrets/$ENVIRONMENT.env" ]; then
    : > "$DEPLOYMENT_ROOT/secrets/$ENVIRONMENT.env"
    chmod 600 "$DEPLOYMENT_ROOT/secrets/$ENVIRONMENT.env"
fi
if [ ! -e "$DEPLOYMENT_ROOT/device/management.env" ]; then
    if [ -e "$SCRIPT_DIR/../.env" ]; then
        cp "$SCRIPT_DIR/../.env" "$DEPLOYMENT_ROOT/device/management.env"
        chmod 600 "$DEPLOYMENT_ROOT/device/management.env"
    else
        echo "management.env is missing; copy device management credentials before starting" >&2
        exit 1
    fi
fi

DEPLOYMENT_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
node - "$DEPLOYMENT_ROOT" "$TARGET_RELEASE" "$ENVIRONMENT" "$REVISION" "$DEPLOYMENT_ID" "$RELEASE_DIGEST" <<'NODE'
const fs = require("fs");
const path = require("path");
const [root, releaseDirectory, environment, revision, deploymentId, releaseDigest] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(releaseDirectory, "release-manifest.json"), "utf8"));
const descriptor = {
  formatVersion: 1,
  deploymentId,
  releaseVersion: manifest.releaseVersion,
  releaseDigest,
  releaseDirectory,
  entrypoint: manifest.entrypoint,
  environment,
  environmentRevision: Number(revision),
  environmentConfigPath: path.join(root, "environments", environment, "revisions", `${revision}.json`),
  secretPath: path.join(root, "secrets", `${environment}.env`),
  createdAt: Date.now(),
};
fs.writeFileSync(path.join(root, "active.json"), `${JSON.stringify(descriptor, null, 2)}\n`, { mode: 0o600 });
fs.writeFileSync(path.join(releaseDirectory, ".artifact-sha256"), `${releaseDigest}\n`, { mode: 0o600 });
const link = path.join(root, "current");
fs.rmSync(link, { force: true });
fs.symlinkSync(releaseDirectory, link, "dir");
NODE

echo "Supervisor installed at $DEPLOYMENT_ROOT"
echo "Legacy repository was not removed. Update the Magisk service entry to run $DEPLOYMENT_ROOT/bootstrap/node_daemon.sh."
