# @pipeworx/mondo

Resolves free-text condition/disease strings — clinical trial registry
"conditions" fields, drug-label indication wording, anything a caller typed
by hand — onto the Mondo Disease Ontology (MONDO), with a match-quality label
the caller can trust and cross-ontology xrefs for the matched term.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1573+ live data sources.

## Tools

- `mondo_resolve_condition(conditions, expand?)` — batch-resolves 1-25
  free-text condition strings. For each, returns the original wording
  verbatim, the best MONDO id + label, and `match_quality`:
  - `exact-label` — identical (case/punctuation-insensitive) to the term's
    primary Mondo label.
  - `exact-synonym` — identical to one of the term's listed exact synonyms.
  - `broader` / `narrower` — the string exactly names a parent or child term
    reached via the Mondo hierarchy, not the top full-text hit itself. This
    includes a fixed-prefix strip of a LEADING stage/status qualifier a
    registry stacks onto the front of a disease name — "Stage IV Melanoma",
    "Metastatic Breast Cancer", "Recurrent X" — when the remainder after
    stripping is an exact label/synonym match, the response is `broader`
    (the input names a subtype/stage of the matched disease) with a note
    listing what was stripped.
  - `fuzzy` — the closest full-text match from EBI OLS4, not a confirmed
    exact term. Never presented as exact.
  - `no-match` — nothing plausible found. The response says what queries
    were tried (including relaxed variants — stripped parentheticals,
    un-inverted "Specific, General" MeSH form, progressively truncated
    trailing qualifiers like "Stage IV") and lists nearest candidates when
    the relaxation surfaced any. Never a bare empty result
    (`docs/silent-zero-policy.md`).

  Every non-`no-match` result also carries `xrefs` (OMIM, Orphanet, DOID,
  UMLS, MeSH) for the resolved id, pulled from the MyDisease.info record.
  Pass `expand: true` to also get `descendant_mondo_ids` — every subtype
  under the resolved term, capped at 500 — for building a subtype-inclusive
  registry filter (e.g. "any subtype of non-small cell lung carcinoma").

  **The match_quality label is the product.** A fuzzy or hierarchical match
  is never upgraded to "exact" — a caller doing a clinical-safety check or
  building a registry filter needs to know the difference.

No second tool: term detail, hierarchy walking (ancestors/children) and raw
Mondo search already live in the `ebi-ols` pack — this pack only adds the
resolution + match-quality layer on top, so it doesn't duplicate that surface.

## Auth

Keyless. Both upstreams are public, unauthenticated APIs.

## Data sources

- <https://www.ebi.ac.uk/ols4/api/search> (EBI Ontology Lookup Service,
  restricted to `ontology=mondo`) — full-text search over Mondo terms, with
  primary labels and exact/related synonyms. Same upstream the `ebi-ols`
  pack proxies; called directly here rather than chained through that pack.
- <https://mydisease.info/v1/disease/{id}> (MyDisease.info, BioThings) —
  per-term Mondo record: cross-ontology xrefs (`mondo.xrefs.omim` /
  `.omimps`, `.orphanet`, `.doid`, `.umls`, `.mesh`) and the full transitive
  `mondo.ancestors` / `mondo.descendants` id lists, used both for the
  broader/narrower hierarchy check and the `expand` flag. Same upstream the
  `mydisease` pack proxies; called directly here rather than chained through
  that pack.

Matching notes for the next person:

- Normalization is case-insensitive and treats any run of non-alphanumeric
  characters (hyphens, commas, punctuation) as a single space, so
  "Non-small Cell Lung Cancer" and "non small cell lung cancer" compare
  equal. It does **not** do stemming or synonym expansion beyond what OLS4
  already returns as `exact_synonyms` — a string that isn't in that list
  will not register as exact even if a human would consider it a paraphrase.
- MeSH's inverted "Specific, General" comma form ("Carcinoma, Non-Small-Cell
  Lung") is the dominant condition shape in trial registries, so it's
  un-inverted ("Non-Small-Cell Lung Carcinoma") and checked for an exact
  match alongside the literal string before falling back to fuzzy — a fixed
  rewrite of a known convention counts as exact, not a guess.
- The leading-qualifier strip (`STAGE_QUALIFIER_RE` / `STATUS_QUALIFIER_RE`
  in `src/index.ts`) is a small, fixed, ordered list — a stage marker
  ("Stage IV", "Stage IIIA") or one of `metastatic` / `recurrent` /
  `advanced` / `refractory` / `unresectable` / `relapsed` / `relapsing` /
  `progressive` / `localized` / `localised` — checked BEFORE the trailing-
  word relaxation ladder, since it applies whether the literal string got
  zero hits ("Stage IV Melanoma") or some non-exact hits ("Metastatic Breast
  Cancer" already surfaces "breast cancer" as its top full-text hit, just
  not exactly). Deterministic prefix matching only, up to 3 passes, so a
  stacked "Advanced Metastatic Melanoma" strips both words.
- OLS4's `exact=true` search param did **not** reliably restrict results to
  exact matches when tested live (2026-09) — exactness is instead determined
  client-side by comparing normalized query text against each candidate's
  label and exact synonyms.
- The `omim` xref sometimes appears as `omimps` (OMIM phenotypic series)
  instead of `omim` in the MyDisease record; both are merged into the
  returned `omim` array.
- Every OLS4/MyDisease fetch is bounded via `fetchWithTimeout`; a MyDisease
  enrichment failure degrades to empty xrefs rather than failing the whole
  resolution (the OLS4 match still stands on its own).

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "mondo": {
      "url": "https://gateway.pipeworx.io/mondo/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/mondo/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1573+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/mondo_resolve_condition \
  -H 'Content-Type: application/json' \
  -d '{"conditions":["Carcinoma, Non-Small-Cell Lung","NSCLC Stage IV","type 2 diabetes mellitus","Carcinoid Tumors","Ehlers-Danlos syndrome"]}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/mondo_resolve_condition`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "mondo": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-mondo"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-mondo
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Mondo data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
