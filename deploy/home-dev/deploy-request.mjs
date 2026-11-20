import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const DEPLOY_REQUEST = "/var/lib/sentrybox-deploy/deploy-request.json";
const DEPLOY_UNIT = "sentrybox-deploy.service";
const EXPECTED_REPOSITORY = "pbuchman/sentrybox";
const EXPECTED_WORKFLOW = "Release SentryBox Image";
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

export function startFixedDeploy(requestPath = DEPLOY_REQUEST) {
  return new Promise((resolveDeploy, rejectDeploy) => {
    const child = spawn(
      "/usr/bin/systemctl",
      ["--wait", "start", DEPLOY_UNIT],
      {
        cwd: "/",
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
        env: {
          PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        },
      },
    );
    child.once("error", rejectDeploy);
    child.once("exit", (code, signal) => {
      if (code === 0 && !existsSync(requestPath)) {
        resolveDeploy();
      } else {
        rejectDeploy(
          new Error(
            `fixed deployment unit failed (${code === null ? signal : String(code)})`,
          ),
        );
      }
    });
  });
}

export function writeDeployRequest(headSha, requestPath = DEPLOY_REQUEST) {
  if (!SHA_PATTERN.test(headSha))
    throw new TypeError("deployment SHA is invalid");
  const file = openSync(requestPath, "wx", 0o600);
  try {
    writeFileSync(
      file,
      `${JSON.stringify({
        version: 1,
        repository: EXPECTED_REPOSITORY,
        workflow: EXPECTED_WORKFLOW,
        headSha,
      })}\n`,
    );
    fsyncSync(file);
  } catch (error) {
    closeSync(file);
    removeDeployRequest(requestPath);
    throw error;
  }
  closeSync(file);
}

export function removeDeployRequest(requestPath = DEPLOY_REQUEST) {
  try {
    unlinkSync(requestPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
