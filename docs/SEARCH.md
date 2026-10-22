# Search

`GET /api/search` is the universal search behind the command palette: people, projects, crews, hackathons and posts in one ranked list. It runs on PostgreSQL (full-text
search and trigram similarity) behind a small interface (`src/lib/search`), so Meilisearch or Typesense can replace it without a route, a response or a test changing.

## The request

```
GET /api/search?q=grace&types=users,projects&limit=10&cursor=…
```

| parameter | |
|---|---|
| `q` | what to look for. 2 to 100 characters after it is tidied (accents, case, punctuation and extra spaces do not matter). Fewer than two letters or digits answers an empty list, not an error: the palette asks as the person types. |
| `types` | any of `users`, `projects`, `crews`, `hackathons`, `posts`, comma separated. Default: all five. |
| `limit` | 1 to 25, default 10. The limit is for the whole list, not per type. |
| `cursor` | `nextCursor` of the previous page. |

The answer is `{ query, types, results, nextCursor }`. `results` is one list in rank order; each item has a `type` and the fields of that type (docs/API.md has the
shapes). It is rate limited as a search route (60 a minute per person).

## What matches

For every type the search looks at the text a person would look for it by, three ways at once, and ranks by the best of them:

1. **Prefix.** Each word of the query matches the start of a word (`gra hop` finds *Grace Hopper*; the last word is matched as the person is still typing it). For people, the
   `username` also matches as a prefix on its own, and an exact username is always the first result.
2. **Full text.** PostgreSQL full-text search with the `simple` configuration (no stemming and no language assumptions, so it behaves the same in every language), over
   text with accents removed.
3. **Typos.** Trigram similarity (`pg_trgm`) against names, so `grase hoper` still finds *Grace Hopper*, and `kubernets` finds *Kubernetes Day*.

What each type searches:

| type | text | also |
|---|---|---|
| `users` | name, username, headline, builder role | the names of their skills (`rust` finds people who list Rust) |
| `projects` | name, short description, description, tech stack | |
| `crews` | name, description, what they are looking for | |
| `hackathons` | name, short description, organizer, city, country, technologies | |
| `posts` | title, body, stack tags | |

Score runs from 0 to about 1.2: an exact username is 1, a username prefix 0.92, a full-text match 0.45 to 0.85 by how well it matches, a trigram match up to 0.85 by
how alike the strings are. Posts add a little for recency (a 30 day half-life) and Props; people a little for XP. Ties break by id, so the order is stable.

## What it never returns

Search is the one place where text a person wrote is matched against what a stranger types, so it is held to the strictest rules on the platform:

- **Blocked and muted.** Anyone the caller has blocked or muted, or who has blocked them, is not in the results, and neither is anything they made.
- **Deleted, suspended, banned.** Deleted accounts, accounts under an active suspension or ban, and accounts closed for their age never appear.
- **Invisible mode.** A person with invisible mode on is not found as a person (their projects and posts follow the same visibility they have everywhere else).
- **High risk.** An account at a HIGH risk level (src/lib/integrity) is found only by its exact username, never by a word.
- **Private fields.** A passport field the person set to `CONNECTIONS` or `PRIVATE` (docs/PRIVACY.md) is not searched and not returned, so the search cannot be used to read it:
  searching for a word in a private headline does not find the person. Only `PUBLIC` fields count.
- **Content that is hidden or removed.** Posts a moderator hid or removed, or the author deleted, are not found. Posts follow `canView`: public posts, an author's own,
  `FOLLOWERS` posts only from people the caller follows, `CREW` posts only for members of that project or crew.
- **Private projects** are found only by their owner and members.
- **The romance mode.** No romance table is read. A person who is in the romance mode is found like anyone else, by their ordinary passport only; nothing about the mode,
  who they are interested in, their gender or their photos is searched, matched or returned.

Every one of these is in the SQL of the query itself, not applied to a page afterwards, so a page is never short and a cursor never skips.

## Paging

The cursor holds the last result's score, type and id; the next page is "everything that ranks after it" (keyset paging, not an offset), so a new post that arrives
between two pages does not shift the results.

## The interface

```ts
interface SearchProvider {
  readonly kind: 'postgres' | …
  search(query: SearchQuery, scope: SearchScope): Promise<SearchPage>
}
```

`SearchQuery` is what the person asked for (the tidied text, the types, the page). `SearchScope` is what the caller is allowed to see, worked out once by the service
(`src/lib/search/index.ts`) from the database: who is hidden from them, whom they follow, which projects and crews they belong to. A provider must apply the scope itself,
inside the query, and return a page; it may not return anything the scope does not allow and rely on the caller to filter it.

To move to Meilisearch or Typesense:

1. Write a provider that indexes the five types with the fields above plus the attributes the scope filters on (`authorId`, `visibility`, `projectId`, `teamId`,
   `isPublic`, `ownerId`, a per-field "public" copy of the passport fields), keeps them in step with the tables (the write paths already emit domain events, and a nightly job can reconcile), and
   turns `SearchScope` into a filter expression.
2. Set it with `setSearch()` in `src/lib/search/index.ts` (or add an environment switch beside `getSearch()`).
3. Run the same integration tests (`tests/integration/search.test.ts`): they test behaviour through the route, including every rule above.

Indexing lag is the cost of moving: a removed post must leave the index before it can stop being found, so the provider has to take deletes and moderation actions from the
event stream, not from a nightly job.

## Database

Migration `20261022000300_search` enables `pg_trgm` and `unaccent`, adds two immutable helper functions (`search_norm`, `search_vec`, `search_join`) so the same expression
is in every index and every query, and GIN indexes: one full-text index and one trigram index on the name column of each type. The indexes decide which rows could match;
the exact visibility rules are then applied to those rows only. `pg_trgm` and `unaccent` ship with PostgreSQL's contrib package, which every managed PostgreSQL has
(Supabase, Neon, RDS, Cloud SQL); creating the extension needs a role that may, which the migration role is.

## Limits

- 25 results a page, 100 characters of query, 8 words of it; 60 requests a minute.
- Typos are tolerated by trigram similarity of 0.3 or more on names; a one-letter query is not searched.
- Languages: matching is language-agnostic (no stemming). Chinese, Japanese and Thai are not segmented into words by the `simple` configuration, so they match whole runs of text
  and by trigram similarity only; a segmenting analyzer is one of the reasons to move to Meilisearch.
