import { writeFile } from "node:fs/promises";
import { URL } from "node:url";

import { JSONSchema } from "effect";

import { ManifestV1Schema } from "../src/manifest/schema.ts";

const schema = JSONSchema.make(ManifestV1Schema, {
  target: "jsonSchema2020-12",
});
// Effect annotates every Unknown with the same $id. Repeated nested IDs are
// ambiguous to JSON Schema consumers such as AJV, so remove those local IDs.
function removeUnknownIds(value) {
  if (Array.isArray(value)) {
    value.forEach(removeUnknownIds);
  } else if (value && typeof value === "object") {
    if (value.$id === "/schemas/unknown") delete value.$id;
    Object.values(value).forEach(removeUnknownIds);
  }
}
removeUnknownIds(schema);
schema.$id = "urn:astro-yandex-cloud:deployment-manifest:v1";
await writeFile(
  new URL("../src/deployment-manifest.schema.json", import.meta.url),
  `${JSON.stringify(schema, null, 2)}\n`,
);
