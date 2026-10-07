import process from "node:process";

/** Shares local credentials and port placement between the service and test runner. */
export function localS3Environment() {
  const offset = process.env.S3_TEST_PORT_OFFSET ?? "0";
  if (!/^\d{1,5}$/.test(offset) || Number(offset) > 20000) {
    throw new Error("S3_TEST_PORT_OFFSET must be an integer between 0 and 20000.");
  }
  const portOffset = Number(offset);
  return {
    portOffset,
    endpoint: `http://127.0.0.1:${18333 + portOffset}`,
    accessKey: process.env.S3_TEST_ACCESS_KEY ?? "issue11-local",
    secretKey: process.env.S3_TEST_SECRET_KEY ?? "issue11-local-secret",
    readyBucket: process.env.S3_TEST_READY_BUCKET ?? "issue11-ready",
  };
}
