declare module "npm-pick-manifest" {
  export default function pickManifest<Manifest extends { version: string }>(
    packument: {
      name: string;
      "dist-tags"?: Record<string, string>;
      versions: Record<string, Manifest>;
    },
    wanted: string,
    options?: { defaultTag?: string },
  ): Manifest;
}
