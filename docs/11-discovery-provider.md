# Discovery provider: OpenStreetMap via the Overpass API

**Status: implemented. Tested only with stubbed responses inside a real n8n 2.41.6 and 2.42.6 engine. Not tested against the live Overpass API**: outbound access to `overpass-api.de` is blocked in the build environment. Your first real discovery run is the live test (`09-setup-and-go-live.md` §5, Phase 3).

## Why this provider

| Requirement | OpenStreetMap / Overpass |
|---|---|
| Data supplied | Business name, website (`website` / `contact:website`), address tags (`addr:city`, `addr:state`), category tags (`office=…`, `amenity=…`, `craft=…`, `shop=…`), OSM object URL. WF02 **ignores** any email or phone tags; contact details come only from the business's own website. |
| Geography | Global. A campaign names a country (ISO code) and OSM administrative areas (cities, districts) in `regions`. |
| Industries | Any category with an OSM tag. `src/lib/categories.js` maps ~37 industries; a campaign can override with explicit `osm_tag_filters`. Online-only businesses (e-commerce) have no map presence: use manual import (WF01). |
| API key | **None.** |
| Cost / limits | Free. The public instance asks for fair use (its published guidance has been roughly < 10,000 queries and < 1 GB per day; check the current policy at overpass-api.de). WF02 runs `DISCOVERY_QUERIES_PER_RUN` (default 2) queries per run, 5 seconds apart, with an identifying User-Agent and a 90-second timeout. |
| Terms | OSM data is under the **Open Database License (ODbL)**: attribution "© OpenStreetMap contributors" (WF02 writes it into each discovered lead's `notes`). Keeping the Leads sheet internal avoids share-alike obligations for a public derivative database; take advice before publishing derived data. |
| Coverage | Uneven: good in many European cities, patchier elsewhere, and many small businesses are missing or have no website tag. **An empty result means "nothing tagged", never "no such businesses".** |

## How it works

1. `planDiscovery` builds one search per *(region × industry)* for the active campaign. Searches that have never run go first, then the oldest. A completed search is repeated only after `DISCOVERY_REFRESH_DAYS`, and a failed one is retried next run. Every search is logged in **Discovery_Log**.
2. The Overpass query selects businesses **with a website** in the named administrative area of the campaign country.
3. `normaliseDiscoveries`:
   - skips entries without a name or usable website, and profile pages (Facebook, Instagram, Yell, Justdial…);
   - deduplicates against Leads and within the batch, using `businessKey` (registrable domain; per-site on shared hosts such as `*.wixsite.com`, `sites.google.com/view/...`);
   - skips suppressed domains;
   - caps new leads at `max_discovered_per_run`;
   - appends `New Lead` rows with `discovery_status = DISCOVERED`.
4. Research of discovered leads happens on the **next** WF02 run (research works from the snapshot read at the start of each run).

## Configure

- **Settings:** `DISCOVERY_ENABLED = TRUE`, `DISCOVERY_QUERIES_PER_RUN`, `DISCOVERY_REFRESH_DAYS`.
- **Campaign row** (Niches): `discovery_provider = osm_overpass`, `country`, `regions` (e.g. `Pune` or `Reading; Leicester`), `industries` (e.g. `dentist; clinic`, or `all`), optional `osm_tag_filters`, `max_discovered_per_run`.
- **WF02 Config node:** `overpass_url`. The default is the main public instance; a mirror or your own Overpass server can be used instead.

## Test it safely

1. Set `DISCOVERY_QUERIES_PER_RUN = 1` and `max_discovered_per_run = 5`.
2. Run WF02 by hand.
3. Check the **Discovery_Log** row:
   - `OK` with `new_leads > 0` means it works;
   - `EMPTY` means the region name or tags found nothing. Try the region's exact OSM name, or another category;
   - `FAILED` means read `error`.
4. Open a few `discovery_source_url` links on openstreetmap.org to confirm the businesses are real.
5. No email is sent by WF02, ever.

## Replace or add a provider

A provider has two pure functions:
- `plan…` returns `{ query_key, request_url, … }` items;
- `normalise…(queries, responses, leadsRows, suppressionRows, niche, maxNew, now)` returns `{ newLeads, logRows }` in the same shapes.

Add the module under `src/lib/`, add an HTTP node in `buildWf02()` in `scripts/build.js`, give the campaign a new `discovery_provider` value, write unit tests, and extend `scripts/n8n-engine-test.js` with a stub. Search APIs that need keys (for example Brave Search or Google's Programmable Search) were **not** added. They would need API keys and an accepted terms review, and neither could be tested from here. Google Maps/Places was rejected because its terms restrict storing place data in your own database.
