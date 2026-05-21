# catenahq/templates -- Dokploy template catalog

This repo holds the Catena Dokploy template catalog. See README.md for
layout, consumer model, and BASE URL setup.

## Edit rules

- `source/` is canonical. `blueprints/` and `meta.json` are generated.
  Never hand-edit a file under `blueprints/` -- the change will be
  overwritten on the next `render.py` run, and CI will reject the PR.
- Every change is a deliberate version bump. Tag a `vX.Y.Z` release
  on every merge to main; catenahq/ops pulls via that tag.
- No emojis or em-dashes in any artifact. Plain hyphens + straight
  quotes only. `npm run check:unicode` enforces.
- Bilingual prose (the `en` / `fr` blocks per catalog entry): both
  required, no EN-only or FR-only templates.
- No secrets, ever. Sentinel placeholders (`__CATENA_OPERATOR_WIRED__`)
  for env vars that ops/ converge owns. Random per-deploy values use
  Dokploy's native helpers (`${password:len}`, `${uuid}`).

## The render contract

`build/render.py` transforms `source/catalog.yml` + `source/sizing-data.yml`
+ `source/compose/` to `blueprints/` + `meta.json`. `sizing-data.yml`
is validated for catalog parity (every catalog id must have a
matching sizing entry with a positive int `peak_ram_mb`; orphan
sizing entries fail the build too) but is NOT emitted to
`blueprints/` -- it is consumed downstream by ops/ (bench scheduler
+ generate-sizing-doc.py), not by Dokploy itself.

- Jinja constructs in compose files are stripped or replaced:
  - `{{ vault_* }}` -> sentinel (`__CATENA_OPERATOR_WIRED__`) for keys
    listed in the catalog's `env_managed_keys`, OR Dokploy native
    helper (`${password:32}` etc.) for non-managed secrets.
  - `{{ cloudflare_zone }}` / `{{ keycloak_hostname }}` -> Dokploy
    `${domain}` placeholder.
  - `lookup('password', ...)` -> Dokploy `${password:N}` helper.
- Per-template `meta.json` entries assembled from catalog metadata.
- Template `template.toml` files emitted from catalog env_defaults +
  domain_host + extra_domains.

The render must be idempotent: running `render.py` twice produces
byte-identical outputs. CI verifies this with `git diff --exit-code`
after running render.

## Add a new template

Checklist:

1. `source/catalog.yml` entry with all required fields (id, app_name,
   upstream_url, sso_mode, domain_host, domain_port, env_defaults,
   en, fr).
2. Matching `source/sizing-data.yml` entry (same id). `peak_ram_mb`
   is required (positive int); other RAM/CPU/disk fields nullable
   until a real measurement run lands. Render.py validates parity
   and fails the build on a missing or orphan id.
3. `source/compose/<id>.compose.yml` (existing Jinja-templated form
   is fine -- render strips it).
4. `source/assets/<id>/logo.png` (512x512 PNG, max 100KB).
5. `uv run build/render.py` locally. Commit the regenerated
   `blueprints/<id>/` and the updated `meta.json`.
6. Open a PR. CI must pass `build-and-verify.yml` (idempotent render)
   and `check:unicode`.
7. After merge, `git tag -a vX.Y.Z -m "..." && git push --tags`.

## When to bump the catalog schema

The schema (catalog.yml entry shape) is a contract with the ops/
loader and with `generate-template-docs.py`. Breaking changes need
coordinated PRs:

1. Land the new shape in templates/ behind a version bump (major).
2. Update ops/'s catalog loader in the same merge window.
3. Update `generate-template-docs.py` in catenahq/ops.
4. Bump the vendored tarball in catenahq/ops via the bump workflow.

## What does NOT live here

- Operator-side wiring (vault key names, OIDC client minting flow,
  env_managed_keys re-injection logic). All in catenahq/ops.
- Per-VPS runtime state. All under `/var/lib/catena/` on each VPS.
- Docs site copy. catenahq/docs generates the per-template pages
  from `source/catalog.yml` via a sibling-write generator.
