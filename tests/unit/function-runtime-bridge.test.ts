import {
	Errors,
	toWebRequest,
} from "@astro-yandex-cloud/function-runtime-bridge";
import { describe, expect, it } from "vitest";

const options = {
	apiGateway: false,
	requestTargetParameter: "target",
};

describe("direct Function request targets", () => {
	it("preserves encoded application query bytes without decoding them as UTF-8", () => {
		const request = toWebRequest(
			{
				headers: { host: "function.example" },
				rawQueryString: "target=%2Fsearch%3Fq%3D%25E9",
			},
			undefined,
			options,
		);
		expect(request.url).toBe(
			"https://function.example/search?q=%E9",
		);
	});

	it.each([
		"target=%2F%252Fother.example%2Fsearch",
		"target=%2Fsearch%2F%25E9",
		"target=%ZZ",
	])(
		"rejects unsafe paths and malformed wrappers: %s",
		(rawQueryString) => {
			expect(() =>
				toWebRequest(
					{
						headers: { host: "function.example" },
						rawQueryString,
					},
					undefined,
					options,
				),
			).toThrow(Errors.FunctionRequestError);
		},
	);
});
