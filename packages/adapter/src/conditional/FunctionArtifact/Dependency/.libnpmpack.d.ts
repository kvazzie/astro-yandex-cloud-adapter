declare module "libnpmpack" {
	export default function pack(
		spec: string,
		options: { ignoreScripts: true },
	): Promise<Buffer>;
}
