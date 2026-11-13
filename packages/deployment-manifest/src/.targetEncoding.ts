import { Targets } from "@astro-yandex-cloud/targets";

// This table is a serialization convention, not part of the Targets model.
export const targetEncoding = [
	["object-storage", Targets.ObjectStorageTarget],
	[
		"object-storage-functions",
		Targets.ObjectStorageCloudFunctionsTarget,
	],
] as const;
