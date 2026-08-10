// Unsubscribing by the headers a mailing list publishes rather than by the
// links in its body. RFC 2369 puts the channels in List-Unsubscribe as
// angle-bracketed URIs; RFC 8058 adds List-Unsubscribe-Post, which marks the
// https channel as answering a bare POST with no page, no login, and no
// confirmation click. Body links are deliberately not parsed: they are the
// sender's tracking territory, and a header a list publishes for machines is
// the one a machine should use.

export type MailtoTarget = {
	to: string;
	subject?: string;
	body?: string;
};

export type UnsubscribeInfo = {
	// True when List-Unsubscribe-Post declares one-click, making the https URL
	// safe to POST to without a browser.
	oneClick: boolean;
	httpsUrls: string[];
	mailto: MailtoTarget | null;
};

// The URIs of a List-Unsubscribe value, which comma-separates angle-bracketed
// entries. Commas inside a URI stay inside its brackets, so splitting on the
// brackets rather than the commas is what parses both.
function extractUris(header: string): string[] {
	const uris: string[] = [];
	const pattern = /<([^>]+)>/g;
	for (;;) {
		const match = pattern.exec(header);
		if (!match) break;
		const uri = match[1]?.trim();
		if (uri) uris.push(uri);
	}
	return uris;
}

// Whether an https URL is one this server should POST to. Plain http would
// send the recipient's address in clear; a URL with credentials in it is not
// an unsubscribe endpoint; an IP literal or localhost is nothing a mailing
// list publishes and everything an SSRF probe does.
export function safeHttpsUrl(raw: string): string | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "https:") return null;
	if (url.username || url.password) return null;
	const host = url.hostname.toLowerCase();
	if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
	// IPv4 and bracketed IPv6 literals.
	if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith("[") || host.includes(":")) return null;
	if (!host.includes(".")) return null;
	return url.href;
}

function parseMailto(raw: string): MailtoTarget | null {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.protocol !== "mailto:") return null;
	// URL leaves the address in pathname, percent-encoded.
	let to: string;
	try {
		to = decodeURIComponent(url.pathname).trim();
	} catch {
		to = url.pathname.trim();
	}
	if (!to.includes("@")) return null;
	// A crafted header must not smuggle line breaks into a message this server
	// then sends; the message builder would refuse them, but refusing here says
	// why.
	if (/[\r\n\0]/.test(to)) return null;
	const clean = (value: string | null): string | null => {
		if (value === null) return null;
		const stripped = value.replace(/[\r\n\0]+/g, " ").trim();
		return stripped || null;
	};
	const subject = clean(url.searchParams.get("subject"));
	const body = clean(url.searchParams.get("body"));
	return {
		to,
		...(subject !== null ? { subject } : {}),
		...(body !== null ? { body } : {}),
	};
}

// Whether List-Unsubscribe-Post declares RFC 8058 one-click. The RFC fixes the
// value; senders vary its case and quoting.
export function oneClickDeclared(postHeader: string | undefined): boolean {
	if (!postHeader) return false;
	return postHeader.replace(/["']/g, "").trim().toLowerCase() === "list-unsubscribe=one-click";
}

export function parseListUnsubscribe(
	header: string | undefined,
	postHeader: string | undefined,
): UnsubscribeInfo {
	const uris = header ? extractUris(header) : [];
	const httpsUrls: string[] = [];
	let mailto: MailtoTarget | null = null;
	for (const uri of uris) {
		const https = safeHttpsUrl(uri);
		if (https) {
			httpsUrls.push(https);
			continue;
		}
		if (!mailto) mailto = parseMailto(uri);
	}
	return {
		// One-click is only meaningful with an https channel to POST to.
		oneClick: oneClickDeclared(postHeader) && httpsUrls.length > 0,
		httpsUrls,
		mailto,
	};
}
