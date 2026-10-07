import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import process from "node:process";
import { finished } from "node:stream/promises";

import { localS3Environment } from "./lib/s3-environment.mjs";

await runLocalS3Tests(process.argv[2]);

/** Reports runtime versions and preserves output through failures or interruption. */
async function runLocalS3Tests(binary) {
  const env = testEnvironment(binary);
  let activeCommand;
  let interrupted = 0;
  let log;
  let flushed;
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    await mkdir(".artifacts", { recursive: true });
    log = createWriteStream(".artifacts/local-s3.log");
    flushed = finished(log);
    for (const [command, args] of [
      [process.execPath, ["--version"]],
      ["pnpm", ["--version"]],
      ...(binary ? [[binary, ["version"]]] : []),
      ["pnpm", ["build"]],
      ["pnpm", ["exec", "vitest", "run", "--config", "vitest.s3.config.ts"]],
    ]) {
      if (interrupted) return;
      activeCommand = startCommand(command, args, env, log);
      const [code] = await activeCommand.closed;
      activeCommand = undefined;
      if (interrupted || code !== 0) {
        process.exitCode = interrupted || code || 1;
        return;
      }
    }
  } finally {
    log?.end();
    if (flushed) await flushed;
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    if (interrupted) process.exitCode = interrupted;
  }

  function stop(code) {
    interrupted = code;
    const child = activeCommand?.child;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
      return;
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
}

function testEnvironment(binary) {
  if (!binary) return process.env;
  const environment = localS3Environment();
  return {
    ...process.env,
    S3_TEST_ENDPOINT: environment.endpoint,
    S3_TEST_ACCESS_KEY: environment.accessKey,
    S3_TEST_SECRET_KEY: environment.secretKey,
    S3_TEST_READY_BUCKET: environment.readyBucket,
  };
}

function startCommand(binary, args, env, log) {
  const child = spawn(binary, args, {
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  for (const output of [child.stdout, child.stderr]) {
    output.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
  }
  return { child, closed };
}
