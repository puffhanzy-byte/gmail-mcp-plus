// Google Calendar over plain fetch, the way gmail.ts calls Gmail: the official
// SDK assumes Node and carries far more than a Worker should ship. Errors are
// raised as GmailApiError so the session's retry-and-refresh wrapper treats
// both Google APIs identically.

import { GmailApiError } from "./gmail";
import { readBoundedText } from "./utils";

const BASE = "https://www.googleapis.com/calendar/v3";
const CALENDAR_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 10_000_000;

// What an event description is worth in a tool result. Calendar descriptions
// carry whole agendas and video-call boilerplate; the event is not mail, so it
// gets its own, smaller budget.
export const EVENT_DESCRIPTION_LIMIT = 4_000;

export async function calendarFetch<T = unknown>(
	accessToken: string,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const resp = await fetch(`${BASE}${path}`, {
		...init,
		signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS),
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	if (!resp.ok) {
		const detail = await readBoundedText(resp.body);
		throw new GmailApiError(resp.status, detail);
	}
	if (resp.status === 204) return null as T;
	const reader = resp.body?.getReader();
	if (!reader) return null as T;
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new GmailApiError(
				413,
				`Calendar returned more than ${MAX_RESPONSE_BYTES} bytes for ${path}; narrow the time range or lower maxResults`,
			);
		}
		chunks.push(value);
	}
	if (total === 0) return null as T;
	const body = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		body.set(chunk, at);
		at += chunk.byteLength;
	}
	return JSON.parse(new TextDecoder().decode(body)) as T;
}

// The fields this server reads; Calendar returns many more.
export type CalendarEvent = {
	id?: string;
	status?: string;
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	hangoutLink?: string;
	recurringEventId?: string;
	recurrence?: string[];
	start?: { date?: string; dateTime?: string; timeZone?: string };
	end?: { date?: string; dateTime?: string; timeZone?: string };
	organizer?: { email?: string; displayName?: string; self?: boolean };
	attendees?: {
		email?: string;
		displayName?: string;
		responseStatus?: string;
		self?: boolean;
		optional?: boolean;
	}[];
};

// One moment of an event as a tool argument: an all-day event names a date,
// a timed one names a dateTime with an optional zone. Exactly one of the two.
export type EventTime = {
	date?: string | undefined;
	dateTime?: string | undefined;
	timeZone?: string | undefined;
};

export function eventTimeBody(
	moment: EventTime,
	what: string,
): { date: string } | { dateTime: string; timeZone?: string } {
	if (moment.date !== undefined && moment.dateTime !== undefined) {
		throw new Error(`${what} carries either date (all-day) or dateTime, never both`);
	}
	if (moment.date !== undefined) {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(moment.date)) {
			throw new Error(`${what}.date must be YYYY-MM-DD`);
		}
		return { date: moment.date };
	}
	if (moment.dateTime === undefined) {
		throw new Error(`${what} needs date (all-day) or dateTime (RFC3339)`);
	}
	// Calendar refuses a zoneless local time unless timeZone accompanies it;
	// checking here turns that into an error naming the argument.
	const zoned = /(?:Z|[+-]\d{2}:\d{2})$/.test(moment.dateTime);
	if (!zoned && !moment.timeZone) {
		throw new Error(
			`${what}.dateTime carries no offset; add one (e.g. 2026-08-12T10:00:00+02:00) or pass ${what}.timeZone`,
		);
	}
	return {
		dateTime: moment.dateTime,
		...(moment.timeZone ? { timeZone: moment.timeZone } : {}),
	};
}

function trimText(text: string | undefined, limit: number): string | undefined {
	if (text === undefined) return undefined;
	if (text.length <= limit) return text;
	return `${text.slice(0, limit)}\n[trimmed ${text.length - limit} characters]`;
}

export function summarizeEvent(e: CalendarEvent, descriptionLimit = 200) {
	return {
		id: e.id,
		status: e.status,
		summary: e.summary,
		start: e.start,
		end: e.end,
		...(e.location ? { location: e.location } : {}),
		...(e.description ? { description: trimText(e.description, descriptionLimit) } : {}),
		...(e.organizer?.email ? { organizer: e.organizer.email } : {}),
		...(e.attendees?.length
			? {
					attendees: e.attendees.map((a) => ({
						email: a.email,
						responseStatus: a.responseStatus,
						...(a.optional ? { optional: true } : {}),
						...(a.self ? { self: true } : {}),
					})),
				}
			: {}),
		...(e.recurrence ? { recurrence: e.recurrence } : {}),
		...(e.recurringEventId ? { recurringEventId: e.recurringEventId } : {}),
		...(e.hangoutLink ? { hangoutLink: e.hangoutLink } : {}),
		...(e.htmlLink ? { htmlLink: e.htmlLink } : {}),
	};
}
