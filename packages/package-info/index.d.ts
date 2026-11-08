export interface PackageInfo {
  readonly name: string;
  readonly version: string;
}

/** Reads the nearest package.json containing the module identified by its file URL. */
export declare function readPackageInfo(moduleUrl: string | URL): PackageInfo;
