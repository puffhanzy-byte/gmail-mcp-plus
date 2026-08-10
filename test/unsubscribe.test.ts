import { describe, expect, test } from "bun:test";
import { oneClickDeclared, parseListUnsubscribe, safeHttpsUrl } from "../src/unsubscribe";

describe("the URIs of List-Unsubscribe", () => {
	test("reads mailto and https channels side by side", () => {
		const info = parseListUnsubscribe(
			"<mailto:leave@list.example>, <https://list.example/unsub?u=42>",
			undefined,
		);
		expect(info.mailto).toEqual({ to: "leave@list.example" });
		expect(info.httpsUrls).toEqual(["https://list.example/unsub?u=42"]);
		expect(info.oneClick).toBe(false);
	});

	// RFC 2369 comma-separates entries, and commas appear inside URLs too; the
	// angle brackets, not the commas, are what delimits.
	test("a comma inside a URL stays inside it", () => {
		const info = parseListUnsubscribe("<https://l.example/u?ids=1,2,3>, <mailto:x@l.example>", "");
		expect(info.httpsUrls).toEqual(["https://l.example/u?ids=1,2,3"]);
		expect(info.mailto?.to).toBe("x@l.example");
	});

	test("a mailto carries its subject and body, cleaned of line breaks", () => {
		const info = parseListUnsubscribe(
			"<mailto:leave@list.example?subject=unsubscribe%20me&body=please%0D%0Astop>",
			undefined,
		);
		expect(info.mailto).toEqual({
			to: "leave@list.example",
			subject: "unsubscribe me",
			body: "please stop",
		});
	});

	// A crafted header must not hand the send tools an address that smuggles
	// its own header lines.
	test("a mailto whose address carries a line break is refused", () => {
		const info = parseListUnsubscribe("<mailto:evil%0D%0ABcc:victim@x.example@list.example>", "");
		expect(info.mailto).toBeNull();
	});

	test("no header, no channels", () => {
		expect(parseListUnsubscribe(undefined, undefined)).toEqual({
			oneClick: false,
			httpsUrls: [],
			mailto: null,
		});
		expect(parseListUnsubscribe("no brackets here", "")).toEqual({
			oneClick: false,
			httpsUrls: [],
			mailto: null,
		});
	});
});

describe("which https URLs are worth a POST", () => {
	test("plain https with a real hostname passes", () => {
		expect(safeHttpsUrl("https://list.example/unsub")).toBe("https://list.example/unsub");
	});

	// http would send the address in clear; credentials, IP literals and
	// localhost are what probes carry, not what lists publish.
	test("everything else is screened out", () => {
		expect(safeHttpsUrl("http://list.example/unsub")).toBeNull();
		expect(safeHttpsUrl("https://user:pw@list.example/unsub")).toBeNull();
		expect(safeHttpsUrl("https://10.0.0.1/unsub")).toBeNull();
		expect(safeHttpsUrl("https://[::1]/unsub")).toBeNull();
		expect(safeHttpsUrl("https://localhost/unsub")).toBeNull();
		expect(safeHttpsUrl("https://internal/unsub")).toBeNull();
		expect(safeHttpsUrl("not a url")).toBeNull();
	});
});

describe("one-click", () => {
	test("the RFC 8058 value is recognized in the case senders use", () => {
		expect(oneClickDeclared("List-Unsubscribe=One-Click")).toBe(true);
		expect(oneClickDeclared("list-unsubscribe=one-click")).toBe(true);
		expect(oneClickDeclared('"List-Unsubscribe=One-Click"')).toBe(true);
		expect(oneClickDeclared("something else")).toBe(false);
		expect(oneClickDeclared(undefined)).toBe(false);
	});

	// One-click without an https channel is a declaration about nothing.
	test("one-click needs an https channel to mean anything", () => {
		const info = parseListUnsubscribe("<mailto:leave@l.example>", "List-Unsubscribe=One-Click");
		expect(info.oneClick).toBe(false);
		const withHttps = parseListUnsubscribe("<https://l.example/u>", "List-Unsubscribe=One-Click");
		expect(withHttps.oneClick).toBe(true);
	});
});
