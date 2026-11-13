/** A malformed direct invocation that must not reach application code. */
export class FunctionRequestError extends Error {
	constructor(
		readonly status: 400 | 403,
		message: string,
	) {
		super(message);
		this.name = "FunctionRequestError";
	}
}
