import { describe, expect, test } from "bun:test";
import {
	CALENDAR_EVENTS_SCOPE,
	CALENDAR_LIST_SCOPE,
	EMAIL_SCOPE,
	flagEnabled,
	GMAIL_SCOPE,
	googleScopes,
	resolveFeatures,
	SETTINGS_SCOPE,
	scopeGranted,
} from "../src/features";

describe("feature flags", () => {
	// The vars ship as "true"; an absent one is a deployment predating the flag,
	// which must behave like the shipped default rather than silently lose tools.
	test("a flag is on unless it plainly says otherwise", () => {
		expect(flagEnabled(undefined)).toBe(true);
		expect(flagEnabled("")).toBe(true);
		expect(flagEnabled("true")).toBe(true);
		expect(flagEnabled("TRUE")).toBe(true);
		expect(flagEnabled("false")).toBe(false);
		expect(flagEnabled("False")).toBe(false);
		expect(flagEnabled("0")).toBe(false);
		expect(flagEnabled("off")).toBe(false);
		expect(flagEnabled("no")).toBe(false);
	});

	test("each flag drives its own feature", () => {
		const features = resolveFeatures({
			ENABLE_FILTERS: "false",
			ENABLE_CALENDAR: "true",
			ENABLE_CROSS_ACCOUNT: "true",
			ALLOWED_EMAILS: "me@example.com",
		});
		expect(features).toEqual({ filters: false, calendar: true, crossAccount: true });
	});

	// A deployment that admits any Google account is a public relay; letting one
	// stranger search every connected mailbox is not a flag away from sane.
	test("cross-account is forced off on a public relay", () => {
		const features = resolveFeatures({ ENABLE_CROSS_ACCOUNT: "true", ALLOWED_EMAILS: "*" });
		expect(features.crossAccount).toBe(false);
		// A domain wildcard is a chosen group, not the public; the flag decides.
		expect(
			resolveFeatures({ ENABLE_CROSS_ACCOUNT: "true", ALLOWED_EMAILS: "*@corp.example" })
				.crossAccount,
		).toBe(true);
	});
});

describe("the scopes sign-in asks for", () => {
	test("base scopes are always requested", () => {
		const scopes = googleScopes({ filters: false, calendar: false, crossAccount: true });
		expect(scopes).toContain(GMAIL_SCOPE);
		expect(scopes).toContain(EMAIL_SCOPE);
		expect(scopes).not.toContain(SETTINGS_SCOPE);
		expect(scopes).not.toContain(CALENDAR_EVENTS_SCOPE);
	});

	test("features bring exactly their own scopes", () => {
		const scopes = googleScopes({ filters: true, calendar: true, crossAccount: false });
		expect(scopes).toContain(SETTINGS_SCOPE);
		expect(scopes).toContain(CALENDAR_EVENTS_SCOPE);
		expect(scopes).toContain(CALENDAR_LIST_SCOPE);
		// Cross-account reuses the mail scope; it must not widen consent.
		expect(scopes.split(" ")).toHaveLength(6);
	});
});

describe("what a grant is known to carry", () => {
	test("a recorded grant answers from its list", () => {
		expect(scopeGranted(`${GMAIL_SCOPE} ${SETTINGS_SCOPE}`, SETTINGS_SCOPE)).toBe(true);
		expect(scopeGranted(GMAIL_SCOPE, SETTINGS_SCOPE)).toBe(false);
	});

	// Grants issued before scopes were recorded carry none; refusing them all
	// would break every session made before the upgrade.
	test("a grant with no record is given the benefit of the doubt", () => {
		expect(scopeGranted(undefined, SETTINGS_SCOPE)).toBe(true);
		expect(scopeGranted("", SETTINGS_SCOPE)).toBe(true);
	});
});
