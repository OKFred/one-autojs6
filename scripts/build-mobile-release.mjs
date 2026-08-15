import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const mobileRoot = path.join(repositoryRoot, "mobile");
const outputDirectory = path.resolve(
  process.env.AUTOJS6_RELEASE_OUTPUT ||
    path.join(repositoryRoot, ".tmp", "releases"),
);
const packageJson = JSON.parse(
  fs.readFileSync(path.join(mobileRoot, "package.json"), "utf8"),
);
const releaseVersion = process.env.GITHUB_REF_NAME || process.argv[2] || "";

if (
  !/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(
    releaseVersion,
  )
) {
  throw new Error("Release version must be supplied as a vX.Y.Z tag");
}
if (`v${packageJson.version}` !== releaseVersion) {
  throw new Error(
    `Git tag ${releaseVersion} does not match mobile/package.json v${packageJson.version}`,
  );
}

/** 计算单个文件的 SHA-256。 */
function sha256(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

/** 跨平台运行 pnpm；Windows 的 .cmd shim 需要通过 cmd.exe。 */
function runPnpm(args, options) {
  if (process.platform === "win32") {
    execFileSync(
      process.env.ComSpec || "cmd.exe",
      ["/d", "/s", "/c", "pnpm", ...args],
      options,
    );
    return;
  }
  execFileSync("pnpm", args, options);
}

/** 运行工作区已安装的跨平台命令，避免触发包管理器依赖重写。 */
function runWorkspaceBinary(packageRoot, command, args) {
  const executable = path.join(
    packageRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${command}.CMD` : command,
  );
  execFileSync(executable, args, {
    cwd: packageRoot,
    stdio: "inherit",
  });
}

/** 递归收集普通文件。 */
function listFiles(directory, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory())
      result.push(...listFiles(absolutePath, relativePath));
    else if (entry.isFile()) result.push(relativePath);
  }
  return result.sort();
}

/** 收集 Windows bsdtar 需要显式加入的普通文件和依赖链接。 */
function listArchiveEntries(directory, prefix = "") {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = path.posix.join(prefix, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(...listArchiveEntries(absolutePath, relativePath));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      result.push(relativePath);
    }
  }
  return result.sort();
}

runWorkspaceBinary(mobileRoot, "tsc", []);

const temporaryRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "one-autojs6-release-"),
);
const releaseRoot = path.join(temporaryRoot, "root");
fs.mkdirSync(releaseRoot, { recursive: true });
try {
  const preparedNodeModules =
    process.env.AUTOJS6_RELEASE_PRODUCTION_NODE_MODULES;
  if (preparedNodeModules) {
    const resolvedNodeModules = path.resolve(preparedNodeModules);
    if (!fs.statSync(resolvedNodeModules).isDirectory()) {
      throw new Error(
        "Prepared production node_modules path is not a directory",
      );
    }
    fs.cpSync(resolvedNodeModules, path.join(releaseRoot, "node_modules"), {
      recursive: true,
      dereference: true,
    });
    fs.rmSync(path.join(releaseRoot, "node_modules", ".package-lock.json"), {
      force: true,
    });
  } else {
    runPnpm(
      [
        "--filter",
        "one-autojs6-mobile",
        "deploy",
        "--prod",
        "--legacy",
        releaseRoot,
      ],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
  }
  fs.writeFileSync(
    path.join(releaseRoot, "package.json"),
    `${JSON.stringify(
      {
        name: packageJson.name,
        version: packageJson.version,
        type: packageJson.type,
        main: "dist/client.js",
        dependencies: packageJson.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  for (const removable of [
    "src",
    "test",
    "bootstrap",
    "logs",
    "state",
    ".env",
    ".env.example",
    "autojs6-config.json",
    "autojs6-config.example.json",
    "README.md",
    "node_daemon.sh",
    "magisk_boot.sh",
    "tsconfig.json",
  ]) {
    fs.rmSync(path.join(releaseRoot, removable), {
      recursive: true,
      force: true,
    });
  }
  for (const developmentPackage of ["typescript", "tsx", "@types/node"]) {
    fs.rmSync(path.join(releaseRoot, "node_modules", developmentPackage), {
      recursive: true,
      force: true,
    });
  }
  for (const deployMetadata of [
    "node_modules/.bin",
    "node_modules/.modules.yaml",
    "node_modules/.pnpm/node_modules/.bin",
  ]) {
    fs.rmSync(path.join(releaseRoot, deployMetadata), {
      recursive: true,
      force: true,
    });
  }
  fs.cpSync(path.join(mobileRoot, "dist"), path.join(releaseRoot, "dist"), {
    recursive: true,
  });
  fs.cpSync(
    path.join(mobileRoot, "task-scripts"),
    path.join(releaseRoot, "task-scripts"),
    { recursive: true },
  );
  const forbidden = listFiles(releaseRoot).filter(
    (filePath) =>
      /^(\.env|logs|state|test|src)(\/|$)/.test(filePath) ||
      (!filePath.startsWith("node_modules/") && filePath.endsWith(".ts")),
  );
  for (const developmentPackage of ["typescript", "tsx", "@types/node"]) {
    if (
      fs.existsSync(path.join(releaseRoot, "node_modules", developmentPackage))
    ) {
      forbidden.push(`node_modules/${developmentPackage}`);
    }
  }
  if (forbidden.length > 0) {
    throw new Error(
      `Release contains forbidden files: ${forbidden.join(", ")}`,
    );
  }
  const gitCommit =
    process.env.GITHUB_SHA ||
    execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  const files = Object.fromEntries(
    listFiles(releaseRoot).map((filePath) => [
      filePath,
      sha256(path.join(releaseRoot, filePath)),
    ]),
  );
  const manifest = {
    formatVersion: 1,
    releaseVersion,
    packageVersion: packageJson.version,
    gitCommit,
    protocolVersion: 2,
    deploymentProtocolVersion: 1,
    minimumSupervisorVersion: "1.0.0",
    entrypoint: "dist/client.js",
    files,
  };
  fs.writeFileSync(
    path.join(releaseRoot, "release-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  const archivePath = path.join(outputDirectory, `${releaseVersion}.tar.gz`);
  if (process.platform === "win32") {
    const fileListPath = path.join(temporaryRoot, "archive-files.txt");
    fs.writeFileSync(
      fileListPath,
      `${listArchiveEntries(releaseRoot).join("\n")}\n`,
    );
    execFileSync(
      "tar",
      ["-czf", archivePath, "-C", releaseRoot, "-T", fileListPath],
      { stdio: "inherit" },
    );
  } else {
    execFileSync(
      "tar",
      [
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "-czf",
        archivePath,
        "-C",
        releaseRoot,
        ".",
      ],
      { stdio: "inherit" },
    );
  }
  const archiveSha256 = sha256(archivePath);
  const metadata = {
    releaseVersion,
    artifactPath: archivePath,
    artifactSha256: archiveSha256,
    artifactSize: fs.statSync(archivePath).size,
    manifest,
  };
  const metadataPath = path.join(
    outputDirectory,
    `${releaseVersion}.metadata.json`,
  );
  fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  process.stdout.write(`${metadataPath}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
