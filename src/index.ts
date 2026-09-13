interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * Written as a sentence rather than a sigil because it is going to be read by
 * whoever gets the error, and "our own service, not a third party" is the
 * single most useful thing to tell them — fetchWithTimeout's own comment
 * (fleet #1047) is about exactly this ambiguity, where blaming a healthy vendor
 * by name sent the next person waiting for an outage that did not exist.
 */
const INTERNAL_ORIGIN_MARKER = ' [pipeworx-hosted origin — our own service, not a third party]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * Mondo — condition-string resolver onto the Mondo Disease Ontology.
 *
 * Stateless, keyless. Calls two upstreams that are already live in the
 * catalog as separate packs (ebi-ols, mydisease) but does NOT chain through
 * them — it hits the same public APIs directly, per the design contract in
 * fleet task #1354:
 *   - EBI OLS4 (https://www.ebi.ac.uk/ols4/api) for full-text search over the
 *     Mondo Disease Ontology, with labels + exact/related synonyms.
 *   - MyDisease.info (https://mydisease.info/v1) for the resolved term's
 *     cross-ontology xrefs (OMIM, Orphanet, DOID, UMLS, MeSH) plus its
 *     ancestor/descendant id lists, used for hierarchy-aware matching and
 *     the `expand` (subtype) flag.
 *
 * The product IS the match_quality label: a caller building a registry
 * filter or a clinical-safety check needs to know whether a string was
 * confirmed identical to a Mondo term, or merely the closest full-text hit —
 * conflating those is worse than returning nothing. Never upgrade a fuzzy or
 * hierarchical match to "exact".
 */


const OLS_BASE = 'https://www.ebi.ac.uk/ols4/api';
const MD_BASE = 'https://mydisease.info/v1';
const UA = 'pipeworx-mcp-mondo/1.0 (+https://pipeworx.io)';

async function pwFetch(url: string | URL, upstream: string, init?: RequestInit): Promise<Response> {
  const headers = { 'User-Agent': UA, Accept: 'application/json', ...(init?.headers ?? {}) };
  return fetchWithTimeout(url, { ...init, headers }, upstream);
}

const MAX_CONDITIONS = 25;
const SEARCH_ROWS = 10;
const MAX_RELAX_TRIES = 5;

type MatchQuality = 'exact-label' | 'exact-synonym' | 'broader' | 'narrower' | 'fuzzy' | 'no-match';

interface OlsDoc {
  obo_id: string;
  iri: string;
  label: string;
  exact_synonyms?: string[];
  related_synonyms?: string[];
}

const tools: McpToolExport['tools'] = [
  {
    name: 'mondo_resolve_condition',
    description:
      'Resolve free-text condition/disease strings — e.g. a clinical trial registry\'s "conditions" field ("Carcinoma, Non-Small-Cell Lung"), or a drug label\'s Indications and Usage wording — onto the Mondo Disease Ontology (MONDO), via EBI OLS4 full-text search plus MyDisease.info cross-references. Accepts a batch (1-25) of condition strings. For each, returns the original wording verbatim, the best MONDO id + label, and a match_quality you can trust: "exact-label" (identical to the Mondo term\'s primary label), "exact-synonym" (identical to a listed exact synonym), "broader"/"narrower" (the string exactly names a parent or child term reached via the Mondo hierarchy, not the top full-text hit itself), or "fuzzy" (closest full-text match, not a confirmed exact term — treat with caution). Also carries xrefs (OMIM, Orphanet, DOID, UMLS, MeSH) for the matched id. A string with no plausible Mondo term returns match_quality "no-match" with the queries tried and the nearest candidates found, never a bare empty result. Set expand:true to also get the resolved term\'s descendant MONDO ids, for building a subtype-inclusive filter (e.g. "any subtype of non-small cell lung carcinoma").',
    inputSchema: {
      type: 'object',
      properties: {
        conditions: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: MAX_CONDITIONS,
          description: `1-${MAX_CONDITIONS} free-text condition/disease strings, e.g. ["Non-small Cell Lung Cancer", "type 2 diabetes mellitus"].`,
        },
        expand: {
          type: 'boolean',
          description: 'When true, also return the resolved term\'s descendant MONDO ids (all subtypes) for each result. Default false.',
        },
      },
      required: ['conditions'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'mondo_resolve_condition':
      return resolveConditions(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function resolveConditions(args: Record<string, unknown>): Promise<unknown> {
  const raw = args.conditions;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Required argument "conditions" is missing. Pass a non-empty array of strings, e.g. ["Non-small Cell Lung Cancer"].');
  }
  const conditions = raw.map((v) => String(v)).slice(0, MAX_CONDITIONS);
  const expand = args.expand === true;

  const results = await Promise.all(conditions.map((c) => resolveOne(c, expand)));
  return { results };
}

async function resolveOne(rawInput: string, expand: boolean): Promise<Record<string, unknown>> {
  const query = rawInput.trim();
  if (!query) {
    return { input: rawInput, resolved: null, match_quality: 'no-match', note: 'Empty condition string.' };
  }
  // Trial registries overwhelmingly write conditions in MeSH's inverted
  // "Specific, General" comma form ("Carcinoma, Non-Small-Cell Lung"). That's
  // a deterministic wording convention, not a guess — so once un-inverted,
  // a match against it is exact, not fuzzy. Both the literal and un-inverted
  // normalized forms count as "the query" for exact-match purposes.
  const normSet = new Set([normalize(query)]);
  const inverted = invertMeshComma(query);
  if (inverted) normSet.add(normalize(inverted));

  let docs = await olsSearch(query, SEARCH_ROWS);
  const tried = [query];
  let usedRelaxedQuery = false;

  // Registries stack a stage/status qualifier onto the FRONT of a disease
  // name ("Stage IV Melanoma", "Metastatic Breast Cancer", "Recurrent X") far
  // more often than the trailing-word relaxation below can catch — dropping
  // from the back never reaches a leading qualifier. This is a second,
  // independent strip from a fixed prefix list (deterministic, no fuzzy
  // guessing): if the remainder after stripping is an EXACT label/synonym
  // match, the input named a subtype/stage of that disease — that is exactly
  // "broader" semantics, so it is labeled broader, not fuzzy or no-match.
  // Checked before either the zero-hit relaxation ladder or the fuzzy
  // fallback below, since it applies whether the literal string got zero
  // hits ("Stage IV Melanoma") or some non-exact hits ("Metastatic Breast
  // Cancer" already surfaces "breast cancer" as its top hit, just not
  // exactly — the qualifier is the only reason it wasn't already exact).
  if (!findExactMatch(docs, normSet)) {
    const strip = stripLeadingQualifiers(query);
    if (strip) {
      tried.push(strip.stripped);
      const strippedDocs = await olsSearch(strip.stripped, SEARCH_ROWS);
      const strippedExact = findExactMatch(strippedDocs, new Set([normalize(strip.stripped)]));
      if (strippedExact) {
        const finalId = strippedExact.doc.obo_id;
        const finalRecord = await mdGetSafe(finalId, 'mondo');
        const out: Record<string, unknown> = {
          input: rawInput,
          resolved: { mondo_id: finalId, label: strippedExact.doc.label },
          match_quality: 'broader',
          xrefs: extractXrefs(finalRecord),
          note: `"${query}" names a subtype/stage of the matched disease — stripped leading qualifier(s) [${strip.removed.join(', ')}] to get an exact match on "${strip.stripped}".`,
        };
        if (expand) {
          const descendants: string[] = finalRecord?.mondo?.descendants ?? [];
          out.descendant_mondo_ids = descendants.slice(0, 500);
          if (descendants.length > 500) out.descendant_mondo_ids_truncated = true;
        }
        return out;
      }
    }
  }

  if (docs.length === 0) {
    // The literal string got zero hits. Retry with a bounded series of
    // relaxations — strip a parenthetical qualifier, un-invert a
    // "Specific, General" (MeSH-style) comma form, then progressively drop
    // trailing words — stopping at the first variant that returns anything.
    // This is what turns a bare empty result into "here's the nearest thing
    // we could find" instead of silence (docs/silent-zero-policy.md).
    for (const variant of relaxCandidates(query).slice(0, MAX_RELAX_TRIES)) {
      tried.push(variant);
      docs = await olsSearch(variant, SEARCH_ROWS);
      if (docs.length > 0) {
        usedRelaxedQuery = true;
        break;
      }
    }
  }

  if (docs.length === 0) {
    return {
      input: rawInput,
      resolved: null,
      match_quality: 'no-match',
      tried_queries: tried,
      nearest_candidates: [],
      note:
        `No Mondo term matched "${query}" via EBI OLS4 full-text search, even after relaxing it to ${tried.length - 1} shorter variant(s). ` +
        'This is a search miss, not necessarily an absent condition — try different wording or a broader phrase.',
    };
  }

  if (usedRelaxedQuery) {
    // We only found candidates by truncating/reshaping the caller's string,
    // so these are suggestions for a human/caller to confirm — never present
    // them as a resolution of what was actually asked.
    return {
      input: rawInput,
      resolved: null,
      match_quality: 'no-match',
      tried_queries: tried,
      nearest_candidates: docs.slice(0, 5).map((d) => ({ mondo_id: d.obo_id, label: d.label })),
      note:
        `"${query}" itself matched nothing in Mondo via EBI OLS4; relaxing it to "${tried[tried.length - 1]}" surfaced these nearest candidates. ` +
        'None of them is asserted as a match for the original string — review before using.',
    };
  }

  const exact = findExactMatch(docs, normSet);
  let resolvedDoc: OlsDoc = exact?.doc ?? docs[0];
  let matchQuality: MatchQuality = exact?.kind ?? 'fuzzy';
  let note: string | undefined;
  let anchorId = docs[0].obo_id;
  let anchorRecord: Record<string, any> | null = null;

  if (!exact) {
    // No direct exact hit among the search results. Fetch the top hit's
    // MyDisease record for its ancestor/descendant id sets, then check
    // whether any OTHER search result is (a) hierarchically related to it
    // AND (b) an exact text match — that's a "broader"/"narrower" resolution
    // found via the hierarchy rather than the flat full-text ranking.
    anchorRecord = await mdGetSafe(anchorId, 'mondo');
    const ancestorIds: Set<string> = new Set(anchorRecord?.mondo?.ancestors ?? []);
    const descendantIds: Set<string> = new Set(anchorRecord?.mondo?.descendants ?? []);

    let hierKind: 'broader' | 'narrower' | null = null;
    let hierDoc: OlsDoc | null = null;
    for (const d of docs) {
      if (d.obo_id === anchorId) continue;
      if (!isExactMatch(d, normSet)) continue;
      if (ancestorIds.has(d.obo_id)) {
        hierKind = 'broader';
        hierDoc = d;
        break;
      }
      if (descendantIds.has(d.obo_id)) {
        hierKind = 'narrower';
        hierDoc = d;
        break;
      }
    }

    if (hierKind && hierDoc) {
      resolvedDoc = hierDoc;
      matchQuality = hierKind;
      note = `"${query}" exactly matches ${hierKind === 'broader' ? 'an ancestor (broader) term' : 'a descendant (more specific) term'} relative to the top full-text hit "${docs[0].label}" (${anchorId}).`;
    } else {
      resolvedDoc = docs[0];
      matchQuality = 'fuzzy';
      note = `No exact label or synonym match; nearest full-text hit from EBI OLS4. Other candidates considered: ${docs
        .slice(1, 4)
        .map((d) => `${d.label} (${d.obo_id})`)
        .join(', ') || 'none'}.`;
    }
  }

  const finalId = resolvedDoc.obo_id;
  const finalRecord = finalId === anchorId && anchorRecord ? anchorRecord : await mdGetSafe(finalId, 'mondo');

  const out: Record<string, unknown> = {
    input: rawInput,
    resolved: { mondo_id: finalId, label: resolvedDoc.label },
    match_quality: matchQuality,
    xrefs: extractXrefs(finalRecord),
  };
  if (note) out.note = note;
  if (expand) {
    const descendants: string[] = finalRecord?.mondo?.descendants ?? [];
    out.descendant_mondo_ids = descendants.slice(0, 500);
    if (descendants.length > 500) out.descendant_mondo_ids_truncated = true;
  }
  return out;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// MeSH/registry strings sometimes wrap a qualifier in parentheses, use the
// inverted "Specific, General" comma form, or pile on staging/mutation detail
// a base ontology term never carries (e.g. "NSCLC Stage IV"). Generate a
// bounded, ordered list of relaxations — a zero-hit search works through
// these, stopping at the first one that returns anything — so a caller gets
// nearest candidates instead of silence, without us ever pretending a
// truncated guess is what they actually typed.
function relaxCandidates(q: string): string[] {
  const variants: string[] = [];
  const noParens = q.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParens && noParens !== q) variants.push(noParens);

  const base = noParens || q;
  if (base.includes(',')) {
    const parts = base.split(',').map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) variants.push(`${parts[1]} ${parts[0]}`.replace(/\s+/g, ' ').trim());
  }

  // Progressively drop trailing tokens (stage/grade/mutation qualifiers are
  // almost always at the end of these strings), down to a single word.
  const tokens = base.split(/\s+/).filter(Boolean);
  for (let n = tokens.length - 1; n >= 1; n--) {
    variants.push(tokens.slice(0, n).join(' '));
  }

  const seen = new Set<string>([normalize(q)]);
  return variants.filter((v) => {
    const n = normalize(v);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return true;
  });
}

// A fixed, ordered list of leading qualifiers a registry stacks onto a
// disease name — a stage marker ("Stage IV", "Stage IIIA") or one of a small
// set of status words. Deterministic prefix matching only, no fuzzy
// stripping: each pass removes at most one qualifier from the front, up to
// STRIP_MAX_PASSES times, so "Advanced Metastatic Melanoma" strips both.
const STAGE_QUALIFIER_RE = /^stage\s+(?:[0-4]|[ivx]+)[a-c]?\b/i;
const STATUS_QUALIFIER_RE =
  /^(metastatic|recurrent|advanced|refractory|unresectable|relapsed|relapsing|progressive|localized|localised)\b/i;
const STRIP_MAX_PASSES = 3;

function stripLeadingQualifiers(q: string): { stripped: string; removed: string[] } | null {
  let rest = q.trim();
  const removed: string[] = [];
  for (let i = 0; i < STRIP_MAX_PASSES; i++) {
    const m = rest.match(STAGE_QUALIFIER_RE) ?? rest.match(STATUS_QUALIFIER_RE);
    if (!m) break;
    removed.push(m[0].trim());
    rest = rest.slice(m[0].length).replace(/^[\s,:-]+/, '').trim();
  }
  if (removed.length === 0 || !rest) return null;
  return { stripped: rest, removed };
}

function isExactMatch(doc: OlsDoc, normSet: Set<string>): boolean {
  if (normSet.has(normalize(doc.label))) return true;
  return (doc.exact_synonyms ?? []).some((s) => normSet.has(normalize(s)));
}

function findExactMatch(docs: OlsDoc[], normSet: Set<string>): { doc: OlsDoc; kind: 'exact-label' | 'exact-synonym' } | null {
  for (const d of docs) {
    if (normSet.has(normalize(d.label))) return { doc: d, kind: 'exact-label' };
  }
  for (const d of docs) {
    if ((d.exact_synonyms ?? []).some((s) => normSet.has(normalize(s)))) return { doc: d, kind: 'exact-synonym' };
  }
  return null;
}

// "Carcinoma, Non-Small-Cell Lung" -> "Non-Small-Cell Lung Carcinoma". MeSH
// (and by inheritance ClinicalTrials.gov) files conditions as
// "Specific, General" — un-inverting is a fixed rewrite of a known
// convention, not a guess, so a match against the result is exact.
function invertMeshComma(q: string): string | null {
  if (!q.includes(',')) return null;
  const parts = q.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 2) return null;
  return `${parts[1]} ${parts[0]}`.replace(/\s+/g, ' ').trim();
}

async function olsSearch(query: string, rows: number): Promise<OlsDoc[]> {
  const params = new URLSearchParams({ q: query, ontology: 'mondo', rows: String(rows) });
  const res = await pwFetch(`${OLS_BASE}/search?${params}`, 'EBI OLS4');
  if (!res.ok) throw await httpError(res, 'EBI OLS4');
  const body = (await res.json()) as { response?: { docs?: OlsDoc[] } };
  return body?.response?.docs ?? [];
}

async function mdGetSafe(id: string, fields: string): Promise<Record<string, any> | null> {
  try {
    const params = new URLSearchParams({ fields });
    const res = await pwFetch(`${MD_BASE}/disease/${encodeURIComponent(id)}?${params}`, 'MyDisease.info');
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const body = await res.json();
    if (body === null || (typeof body === 'object' && (body as Record<string, unknown>).success === false)) return null;
    return body as Record<string, any>;
  } catch {
    // MyDisease enrichment failing must not blow up the resolution: the
    // OLS4 match (id, label, match_quality) still stands on its own.
    return null;
  }
}

function extractXrefs(record: Record<string, any> | null): Record<string, string[]> {
  const x = record?.mondo?.xrefs ?? {};
  const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : v != null ? [String(v)] : []);
  const omim = [...asArray(x.omim), ...asArray(x.omimps)];
  return {
    omim,
    orphanet: asArray(x.orphanet),
    doid: asArray(x.doid),
    umls: asArray(x.umls),
    mesh: asArray(x.mesh),
  };
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
