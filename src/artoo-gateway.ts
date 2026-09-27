import {
  b64urlEncode,
  buildRfc822,
  extractBody,
  extractHtmlBody,
  forwardHeaderBlock,
  forwardHtmlBlock,
  forwardSubject,
  gmailFetch,
  headerValue,
  parseAddresses,
  quoteHtml,
  quotePlain,
  replyRecipients,
  replySubject,
  sanitizeReferences,
  summarizeMessage,
  truncate,
  type GmailMessage,
} from "./gmail";
import { listAccounts } from "./registry";
import { refreshGoogleToken } from "./utils";

const ROUTE = "/artoo";
const MAX_BODY = 50_000;
const MAX_RESULTS = 10;
const MAX_THREAD_MESSAGES = 10;
const MAX_THREAD_BODY = 30_000;
const MAX_REQUEST_BYTES = 1_000_000;

type Env = {
  OAUTH_KV: KVNamespace;
  COOKIE_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  ARTOO_GATEWAY_SECRET: string;
};

type GatewayRequest =
  | { operation: "search"; query: string; maxResults?: number; pageToken?: string }
  | { operation: "read"; messageId: string }
  | { operation: "thread"; threadId: string; includeBodies?: boolean; maxMessages?: number }
  | {
      operation: "send";
      to: string;
      subject: string;
      body: string;
      htmlBody?: string;
      cc?: string;
      bcc?: string;
    }
  | { operation: "reply"; messageId: string; body: string; htmlBody?: string }
  | {
      operation: "forward";
      messageId: string;
      to: string;
      body?: string;
      htmlBody?: string;
    }
  | {
      operation: "drafts";
      action?: "list" | "create" | "send" | "delete";
      draftId?: string;
      to?: string;
      subject?: string;
      body?: string;
      htmlBody?: string;
    };

type MessageList = {
  messages?: { id?: string; threadId?: string }[];
  resultSizeEstimate?: number;
  nextPageToken?: string;
};

type DraftList = { drafts?: { id?: string }[] };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function unauthorized(): Response {
  return json({ ok: false, error: "unauthorized" }, 401);
}

function safeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = aa.length ^ bb.length;
  const length = Math.max(aa.length, bb.length);
  for (let i = 0; i < length; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

async function readJson(request: Request): Promise<GatewayRequest> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_REQUEST_BYTES) throw new Error("request body too large");
  const body = await request.text();
  if (body.length > MAX_REQUEST_BYTES) throw new Error("request body too large");
  return JSON.parse(body) as GatewayRequest;
}

function validateText(value: unknown, name: string, max = MAX_BODY): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  if (value.length > max) throw new Error(`${name} is too long`);
  return value;
}

async function account(env: Env) {
  const accounts = await listAccounts(env.OAUTH_KV, env.COOKIE_ENCRYPTION_KEY);
  if (accounts.length !== 1) {
    throw new Error(
      accounts.length === 0
        ? "no Gmail account is connected to Gmail MCP Plus"
        : "Artoo gateway requires exactly one connected Gmail account; refusing to guess between accounts",
    );
  }
  return accounts[0];
}

async function token(env: Env, refreshToken: string): Promise<string> {
  const refreshed = await refreshGoogleToken({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  return refreshed.access_token;
}

async function message(env: Env, accessToken: string, id: string): Promise<GmailMessage> {
  validateText(id, "messageId", 500);
  return gmailFetch<GmailMessage>(
    accessToken,
    `/messages/${encodeURIComponent(id)}?format=full`,
    {},
    750_000,
  );
}

function messageView(m: GmailMessage, includeBody: boolean) {
  const result: Record<string, unknown> = summarizeMessage(m);
  if (includeBody) {
    result.body = truncate(extractBody(m.payload) || "", MAX_BODY);
    result.htmlBody = truncate(extractHtmlBody(m.payload) || "", MAX_BODY);
  }
  return result;
}

async function search(env: Env, accessToken: string, request: Extract<GatewayRequest, { operation: "search" }>) {
  const query = validateText(request.query, "query", 2_000);
  const maxResults = Math.min(Math.max(request.maxResults ?? 5, 1), MAX_RESULTS);
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  if (request.pageToken) params.set("pageToken", request.pageToken);
  const list = await gmailFetch<MessageList>(
    accessToken,
    `/messages?includeSpamTrash=true&${params.toString()}`,
    {},
    100_000,
  );
  const ids = (list.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  const results = await Promise.all(
    ids.map(async (id) => {
      const item = await gmailFetch<GmailMessage>(
        accessToken,
        `/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Subject&metadataHeaders=Date`,
        {},
        50_000,
      );
      return summarizeMessage(item);
    }),
  );
  return { ok: true, resultSizeEstimate: list.resultSizeEstimate, nextPageToken: list.nextPageToken, messages: results };
}

async function send(env: Env, accessToken: string, request: Extract<GatewayRequest, { operation: "send" }>) {
  const to = validateText(request.to, "to", 8_000);
  const subject = validateText(request.subject, "subject", 2_000);
  const body = validateText(request.body, "body");
  const raw = buildRfc822({
    to,
    cc: request.cc,
    bcc: request.bcc,
    subject,
    body,
    htmlBody: request.htmlBody,
  });
  const result = await gmailFetch<GmailMessage>(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: b64urlEncode(raw) }),
  });
  return { ok: true, message: summarizeMessage(result) };
}

async function reply(env: Env, accessToken: string, request: Extract<GatewayRequest, { operation: "reply" }>, self: string) {
  const original = await message(env, accessToken, request.messageId);
  const from = parseAddresses(headerValue(original, "From"));
  const to = parseAddresses(headerValue(original, "To"));
  const cc = parseAddresses(headerValue(original, "Cc"));
  const replyTo = parseAddresses(headerValue(original, "Reply-To"));
  const recipients = replyRecipients({ self: [self], from, to, cc, replyTo });
  const originalBody = truncate(extractBody(original.payload) || "", MAX_BODY);
  const originalHtml = truncate(extractHtmlBody(original.payload) || "", MAX_BODY);
  const quotedPlain = quotePlain(headerValue(original, "From"), headerValue(original, "Date"), originalBody);
  const quotedHtml = quoteHtml(headerValue(original, "From"), headerValue(original, "Date"), originalHtml || originalBody);
  const raw = buildRfc822({
    to: recipients.to.join(", "),
    cc: recipients.cc.length ? recipients.cc.join(", ") : undefined,
    subject: replySubject(headerValue(original, "Subject")),
    body: `${validateText(request.body, "body")}\n\n${quotedPlain}`,
    htmlBody: request.htmlBody ? `${request.htmlBody}<br>\n${quotedHtml}` : undefined,
    inReplyTo: headerValue(original, "Message-ID"),
    references: sanitizeReferences(headerValue(original, "References"), headerValue(original, "Message-ID")),
  });
  const result = await gmailFetch<GmailMessage>(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: b64urlEncode(raw), threadId: original.threadId }),
  });
  return { ok: true, message: summarizeMessage(result) };
}

async function forward(env: Env, accessToken: string, request: Extract<GatewayRequest, { operation: "forward" }>) {
  const original = await message(env, accessToken, request.messageId);
  const originalBody = truncate(extractBody(original.payload) || "", MAX_BODY);
  const originalHtml = truncate(extractHtmlBody(original.payload) || "", MAX_BODY);
  const fields = {
    from: headerValue(original, "From"),
    date: headerValue(original, "Date"),
    subject: headerValue(original, "Subject"),
    to: headerValue(original, "To"),
    cc: headerValue(original, "Cc"),
  };
  const prefix = request.body?.trim() ?? "";
  const plain = [prefix, forwardHeaderBlock(fields), originalBody].filter(Boolean).join("\n\n");
  const html = request.htmlBody
    ? `${request.htmlBody}<br>\n${forwardHtmlBlock({ ...fields, body: originalHtml || originalBody })}`
    : undefined;
  const raw = buildRfc822({
    to: validateText(request.to, "to", 8_000),
    subject: forwardSubject(fields.subject),
    body: plain,
    htmlBody: html,
  });
  const result = await gmailFetch<GmailMessage>(accessToken, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: b64urlEncode(raw) }),
  });
  return { ok: true, message: summarizeMessage(result) };
}

async function drafts(env: Env, accessToken: string, request: Extract<GatewayRequest, { operation: "drafts" }>) {
  const action = request.action ?? "list";
  if (action === "list") {
    const list = await gmailFetch<DraftList>(accessToken, "/drafts?maxResults=10", {}, 100_000);
    const ids = (list.drafts ?? []).map((d) => d.id).filter((id): id is string => Boolean(id));
    const items = await Promise.all(
      ids.map((id) => gmailFetch<Record<string, unknown>>(
        accessToken,
        `/drafts/${encodeURIComponent(id)}`,
        {},
        100_000,
      )),
    );
    return { ok: true, drafts: items };
  }

  if (action === "delete") {
    const id = validateText(request.draftId, "draftId", 500);
    await gmailFetch(accessToken, `/drafts/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { ok: true };
  }

  if (action === "send") {
    const id = validateText(request.draftId, "draftId", 500);
    const result = await gmailFetch<GmailMessage>(
      accessToken,
      `/drafts/${encodeURIComponent(id)}/send`,
      {
        method: "POST",
        body: JSON.stringify({ id }),
      },
    );
    return { ok: true, message: summarizeMessage(result) };
  }

  const to = validateText(request.to, "to", 8_000);
  const subject = validateText(request.subject, "subject", 2_000);
  const body = validateText(request.body, "body");
  const raw = buildRfc822({ to, subject, body, htmlBody: request.htmlBody });

  if (action === "create") {
    const result = await gmailFetch<Record<string, unknown>>(accessToken, "/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw: b64urlEncode(raw) } }),
    });
    return { ok: true, draft: result };
  }

  throw new Error("unsupported drafts action");
}

export async function artooGateway(request: Request, env: Env): Promise<Response> {
  if (new URL(request.url).pathname !== ROUTE) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
  }

  const auth = request.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ") || !safeEqual(auth.slice(7), env.ARTOO_GATEWAY_SECRET)) {
    return unauthorized();
  }

  try {
    const input = await readJson(request);
    const current = await account(env);
    if (!current.refreshToken) throw new Error("connected Gmail account has no refresh token in the registry");
    const accessToken = await token(env, current.refreshToken);

    switch (input.operation) {
      case "search":
        return json(await search(env, accessToken, input));
      case "read": {
        const item = await message(env, accessToken, input.messageId);
        return json({ ok: true, message: messageView(item, true) });
      }
      case "thread": {
        const threadId = validateText(input.threadId, "threadId", 500);
        const includeBodies = input.includeBodies ?? true;
        const maxMessages = Math.min(Math.max(input.maxMessages ?? 10, 1), MAX_THREAD_MESSAGES);
        const thread = await gmailFetch<{ messages?: GmailMessage[] }>(
          accessToken,
          `/threads/${encodeURIComponent(threadId)}?format=full`,
          {},
          1_000_000,
        );
        let budget = MAX_THREAD_BODY;
        const messages = (thread.messages ?? []).slice(0, maxMessages).map((m) => {
          if (!includeBodies) return messageView(m, false);
          const body = truncate(extractBody(m.payload) || "", Math.max(0, Math.min(MAX_BODY, budget)));
          budget = Math.max(0, budget - body.length);
          return { ...summarizeMessage(m), body };
        });
        return json({ ok: true, threadId, messages });
      }
      case "send":
        return json(await send(env, accessToken, input));
      case "reply":
        return json(await reply(env, accessToken, input, current.email));
      case "forward":
        return json(await forward(env, accessToken, input));
      case "drafts":
        return json(await drafts(env, accessToken, input));
      default:
        return json({ ok: false, error: "unsupported operation" }, 400);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return json({ ok: false, error: message }, 502);
  }
}
