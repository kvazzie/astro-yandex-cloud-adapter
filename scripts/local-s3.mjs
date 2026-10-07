import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import { localS3Environment } from "./lib/s3-environment.mjs";

await runSeaweedFS(process.argv[2]);

/** Runs the local service until shutdown, then removes its temporary data. */
async function runSeaweedFS(binary) {
  if (!binary) throw new Error("Pass the path to the weed executable.");
  const environment = localS3Environment();
  let dataDirectory;
  let log;
  let child;
  let closed;
  let interrupted = 0;
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    dataDirectory = await mkdtemp(join(tmpdir(), "astro-yandex-s3-"));
    await mkdir(".devenv", { recursive: true });
    const logPath = resolve(".devenv/s3.log");
    log = await open(logPath, "w");
    process.stdout.write(`SeaweedFS data: ${dataDirectory}; log: ${logPath}\n`);
    if (interrupted) return;

    child = spawn(
      binary,
      serviceArguments(dataDirectory, environment.portOffset),
      {
        env: {
          ...process.env,
          AWS_ACCESS_KEY_ID: environment.accessKey,
          AWS_SECRET_ACCESS_KEY: environment.secretKey,
          S3_BUCKET: environment.readyBucket,
        },
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    closed = once(child, "close");
    const [code] = await closed;
    process.exitCode = interrupted || (code ?? 1);
  } finally {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await closed.catch(() => {});
    }
    if (log) await log.close();
    if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    if (interrupted) process.exitCode = interrupted;
  }

  function stop(code) {
    interrupted = code;
    child?.kill("SIGTERM");
  }
}

function serviceArguments(dataDirectory, offset) {
  return [
    "mini",
    `-dir=${dataDirectory}`,
    "-ip=127.0.0.1",
    "-ip.bind=127.0.0.1",
    `-master.port=${19333 + offset}`,
    `-volume.port=${19340 + offset}`,
    `-filer.port=${18888 + offset}`,
    `-s3.port=${18333 + offset}`,
    `-admin.port=${23646 + offset}`,
    "-webdav=false",
    "-admin.ui=false",
    "-s3.port.iceberg=0",
    "-s3.port.lance=0",
    "-master.telemetry=false",
    "-volume.max=5",
    "-s3.autoCreateBucket=false",
  ];
}
