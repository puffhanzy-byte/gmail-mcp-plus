// The account registry: one sealed KV record per connected Google account,
// written at sign-in. It exists for two features. Aliases give an account a
// name worth saying ("work" rather than the address), and cross-account search
// needs a way to reach every connected mailbox from one session — which is
// exactly the boundary the per-session grant model refuses to cross, so the
// refresh token is only stored here when the deployment turns that feature on.
//
// Records are sealed with AES-256-GCM under a key derived from
// COOKIE_ENCRYPTION_KEY, so a KV listing shows who is connected to the
// operator (who already knows) and nothing else to anyone else.

export type AccountRecord = {
	email: string;
	name: string;
	alias?: string;
	addedAt: string;
	// Present only when the deployment runs with cross-account search on.
	refreshToken?: string;
};

export const REGISTRY_PREFIX = "accountData:";

// The registry never holds more than MAX_ACCOUNTS records, and that cap tops
// out well under a KV page.
const LIST_LIMIT = 1000;

function keyFor(email: string): string {
	return `${REGISTRY_PREFIX}${email.trim().toLowerCase()}`;
}

// One AES key for the registry, derived rather than reused: the cookie secret
// also signs approval cookies, and HKDF with its own info string keeps the two
// uses from ever producing related material.
async function registryKey(secret: string): Promise<CryptoKey> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		"HKDF",
		false,
		["deriveKey"],
	);
	return crypto.subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: new TextEncoder().encode("gmail-mcp-registry-v1"),
			info: new TextEncoder().encode("account-registry"),
		},
		material,
		{ name: "AES-GCM", length: 256 },
		false,
		["encrypt", "decrypt"],
	);
}

function toB64(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(out);
}

function fromB64(text: string): Uint8Array {
	const raw = atob(text);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

export async function sealRecord(record: AccountRecord, secret: string): Promise<string> {
	const key = await registryKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const sealed = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv },
		key,
		new TextEncoder().encode(JSON.stringify(record)),
	);
	const body = new Uint8Array(iv.length + sealed.byteLength);
	body.set(iv, 0);
	body.set(new Uint8Array(sealed), iv.length);
	return toB64(body);
}

// A record that will not open — a rotated secret, a truncated value — is
// reported as absent rather than thrown: the caller's next sign-in rewrites
// it, which is also the only fix.
export async function openRecord(sealed: string, secret: string): Promise<AccountRecord | null> {
	try {
		const bytes = fromB64(sealed);
		const key = await registryKey(secret);
		const opened = await crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: bytes.subarray(0, 12) },
			key,
			bytes.subarray(12),
		);
		const parsed = JSON.parse(new TextDecoder().decode(opened)) as AccountRecord;
		if (typeof parsed.email !== "string" || !parsed.email) return null;
		return parsed;
	} catch {
		return null;
	}
}

export async function getAccount(
	kv: KVNamespace,
	secret: string,
	email: string,
): Promise<AccountRecord | null> {
	const sealed = await kv.get(keyFor(email));
	if (!sealed) return null;
	return openRecord(sealed, secret);
}

export async function putAccount(
	kv: KVNamespace,
	secret: string,
	record: AccountRecord,
): Promise<void> {
	await kv.put(keyFor(record.email), await sealRecord(record, secret));
}

export async function listAccounts(kv: KVNamespace, secret: string): Promise<AccountRecord[]> {
	const listing = await kv.list({ prefix: REGISTRY_PREFIX, limit: LIST_LIMIT });
	const records: AccountRecord[] = [];
	for (const entry of listing.keys) {
		const sealed = await kv.get(entry.name);
		if (!sealed) continue;
		const record = await openRecord(sealed, secret);
		if (record) records.push(record);
	}
	records.sort((a, b) => a.email.localeCompare(b.email));
	return records;
}

// Which record an alias or address names. Aliases are matched
// case-insensitively, addresses canonically; an alias that collides with
// another account's address is a configuration the operator chose.
export function findAccount(records: AccountRecord[], nameOrEmail: string): AccountRecord | null {
	const wanted = nameOrEmail.trim().toLowerCase();
	if (!wanted) return null;
	return (
		records.find((r) => r.email.toLowerCase() === wanted) ??
		records.find((r) => (r.alias ?? "").trim().toLowerCase() === wanted) ??
		null
	);
}
