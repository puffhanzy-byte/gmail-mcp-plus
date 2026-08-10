// Which optional capabilities this deployment runs with. Each one changes what
// a stolen grant could do, so each is a deployment decision rather than a tool
// argument: filters need a settings scope, calendar needs calendar scopes, and
// cross-account search lets one connection read every connected mailbox.

export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export const PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile";
// gmail.settings.basic reaches filters, vacation responders and IMAP settings.
// It deliberately excludes gmail.settings.sharing, which is where forwarding
// addresses and delegates live — the classic mailbox-exfiltration backdoors.
export const SETTINGS_SCOPE = "https://www.googleapis.com/auth/gmail.settings.basic";
// Events on every calendar the account can reach, without the ACL, settings,
// or calendar-deletion rights the full calendar scope would carry.
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";
// The list of calendars alone; naming one is how every event call is addressed.
export const CALENDAR_LIST_SCOPE = "https://www.googleapis.com/auth/calendar.calendarlist.readonly";

export type Features = {
	filters: boolean;
	calendar: boolean;
	crossAccount: boolean;
};

export type FeatureEnv = {
	ENABLE_FILTERS?: string;
	ENABLE_CALENDAR?: string;
	ENABLE_CROSS_ACCOUNT?: string;
	ALLOWED_EMAILS?: string;
};

// A flag is on unless it plainly says otherwise. The vars ship as "true" in
// wrangler.jsonc, so an absent one means a deployment predating the flag —
// which should behave like the shipped default rather than silently losing
// tools.
export function flagEnabled(raw: string | undefined): boolean {
	const value = (raw ?? "").trim().toLowerCase();
	return !["false", "0", "off", "no"].includes(value);
}

export function resolveFeatures(env: FeatureEnv): Features {
	// A deployment that admits any Google account ("*") is a public relay, and
	// cross-account search on a relay would let any stranger read every mailbox
	// that ever connected. No flag setting overrides that.
	const publicRelay = (env.ALLOWED_EMAILS ?? "").trim() === "*";
	return {
		filters: flagEnabled(env.ENABLE_FILTERS),
		calendar: flagEnabled(env.ENABLE_CALENDAR),
		crossAccount: flagEnabled(env.ENABLE_CROSS_ACCOUNT) && !publicRelay,
	};
}

// What sign-in asks Google for. Scopes follow the deployment's features:
// asking for a settings or calendar permission a deployment will never use
// would widen every grant for nothing.
export function googleScopes(features: Features): string {
	const scopes = [GMAIL_SCOPE, EMAIL_SCOPE, PROFILE_SCOPE];
	if (features.filters) scopes.push(SETTINGS_SCOPE);
	if (features.calendar) scopes.push(CALENDAR_EVENTS_SCOPE, CALENDAR_LIST_SCOPE);
	return scopes.join(" ");
}

// Whether a grant carries a scope. Grants issued before this server tracked
// scopes carry none at all; those are given the benefit of the doubt and the
// Google API answers for them.
export function scopeGranted(granted: string | undefined, scope: string): boolean {
	if (granted === undefined || granted.trim() === "") return true;
	return granted.split(/\s+/).includes(scope);
}
