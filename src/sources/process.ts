import { spawn } from "node:child_process";
import { KnittoError } from "../errors.js";

export async function run(
  command: string,
  args: string[],
  options: { cwd?: string } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      reject(
        new KnittoError(`Unable to run ${command}`, "SOURCE", {
          cause: error,
        }),
      );
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8").trim());
        return;
      }
      reject(
        new KnittoError(
          `${command} failed with exit code ${code}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
          "SOURCE",
        ),
      );
    });
  });
}
