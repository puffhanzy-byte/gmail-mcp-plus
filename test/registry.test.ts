import { describe, expect, test } from "bun:test";
import {
	type AccountRecord,
	findAccount,
	getAccount,
	listAccounts,
	openRecord,
	putAccount,
	sealRecord,
} from "../src/registry";

const SECRET = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

function memoryKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
		list: async ({ prefix }: { prefix?: string; limit?: number }) => ({
			keys: [...store.keys()].filter((k) => k.startsWith(prefix ?? "")).map((name) => ({ name })),
			list_complete: true,
		}),
	} as unknown as KVNamespace;
}

const record: AccountRecord = {
	email: "work@example.com",
	name: "Work Account",
	alias: "work",
	addedAt: "2026-08-10T00:00:00.000Z",
	refreshToken: "refresh-token-1",
};

describe("sealing account records", () => {
	test("a sealed record opens back to itself", async () => {
		const sealed = await sealRecord(record, SECRET);
		expect(await openRecord(sealed, SECRET)).toEqual(record);
	});

	// The value in KV must say nothing readable: it holds a refresh token.
	test("the sealed form carries no plaintext", async () => {
		const sealed = await sealRecord(record, SECRET);
		expect(sealed).not.toContain("work@example.com");
		expect(sealed).not.toContain("refresh-token-1");
	});

	test("a wrong secret opens nothing", async () => {
		const sealed = await sealRecord(record, SECRET);
		expect(await openRecord(sealed, "another-secret")).toBeNull();
	});

	// A rotated secret or a truncated value is a record to rewrite at next
	// sign-in, not an exception that takes the tool down.
	test("a tampered or garbled value opens nothing", async () => {
		const sealed = await sealRecord(record, SECRET);
		const tampered = sealed.slice(0, -4) + (sealed.endsWith("AAAA") ? "BBBB" : "AAAA");
		expect(await openRecord(tampered, SECRET)).toBeNull();
		expect(await openRecord("not base64 at all!!", SECRET)).toBeNull();
	});

	test("two sealings of one record differ (fresh IV) yet both open", async () => {
		const a = await sealRecord(record, SECRET);
		const b = await sealRecord(record, SECRET);
		expect(a).not.toEqual(b);
		expect(await openRecord(a, SECRET)).toEqual(await openRecord(b, SECRET));
	});
});

describe("the registry in KV", () => {
	test("put, get and list round-trip", async () => {
		const kv = memoryKv();
		await putAccount(kv, SECRET, record);
		await putAccount(kv, SECRET, { email: "b@example.com", name: "B", addedAt: "2026-01-01" });
		expect(await getAccount(kv, SECRET, "work@example.com")).toEqual(record);
		// Addressing is case-insensitive, as addresses are.
		expect(await getAccount(kv, SECRET, "WORK@EXAMPLE.COM")).toEqual(record);
		const all = await listAccounts(kv, SECRET);
		expect(all.map((r) => r.email)).toEqual(["b@example.com", "work@example.com"]);
	});

	test("an account never stored is absent, not an error", async () => {
		expect(await getAccount(memoryKv(), SECRET, "nobody@example.com")).toBeNull();
	});

	// One unreadable record — sealed under a rotated secret — must not empty
	// the whole listing.
	test("listing skips records that will not open", async () => {
		const kv = memoryKv();
		await putAccount(kv, SECRET, record);
		await kv.put("accountData:broken@example.com", "garbage");
		const all = await listAccounts(kv, SECRET);
		expect(all.map((r) => r.email)).toEqual(["work@example.com"]);
	});
});

describe("naming an account", () => {
	const records: AccountRecord[] = [
		record,
		{ email: "personal@example.com", name: "P", alias: "Personal", addedAt: "2026-01-01" },
	];

	test("an address names its account", () => {
		expect(findAccount(records, "personal@example.com")?.alias).toBe("Personal");
	});

	test("an alias names its account, whatever the case", () => {
		expect(findAccount(records, "WORK")?.email).toBe("work@example.com");
		expect(findAccount(records, "personal")?.email).toBe("personal@example.com");
	});

	test("a name nothing answers to is null", () => {
		expect(findAccount(records, "nothing")).toBeNull();
		expect(findAccount(records, "")).toBeNull();
	});

	// An alias that spells another account's address must not shadow it.
	test("an address match wins over an alias match", () => {
		const shadowing: AccountRecord[] = [
			{ email: "a@example.com", name: "A", alias: "b@example.com", addedAt: "" },
			{ email: "b@example.com", name: "B", addedAt: "" },
		];
		expect(findAccount(shadowing, "b@example.com")?.email).toBe("b@example.com");
	});
});
