import { readFile } from "node:fs/promises";
import process from "node:process";

await showLocalS3Log();

async function showLocalS3Log() {
  try {
    process.stdout.write(await readFile(".artifacts/local-s3.log", "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}
