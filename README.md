# catenahq/dokploy-templates

Single source of truth for the Catena Dokploy template catalog: the
compose files + per-template metadata + build pipeline that emits
Dokploy-marketplace-compatible blueprints. Consumed by catenahq/ops
(via a vendored tarball, contracts-pattern) and by Dokploy itself
(via the BASE URL field pointing at this repo's raw GitHub URL).

## Layout

```
source/                  # canonical input, Jinja-templated
  catalog.yml            # per-template metadata (slugs, domains, env vars, prose)
  compose/<id>.compose.yml
  assets/<id>/logo.png

blueprints/              # generated; what Dokploy fetches via BASE URL
  <id>/
    docker-compose.yml   # rendered: Jinja stripped, vault refs replaced by sentinels
    template.toml        # var/config metadata in Dokploy's native schema
    logo.png

meta.json                # generated; top-level index Dokploy reads first

build/
  render.py              # source/ -> blueprints/ + meta.json
  serve.py               # local preview server

.github/workflows/
  build-and-verify.yml   # CI: run render.py, fail if outputs drift from source/
```

`source/` is human-edited. `blueprints/` and `meta.json` are committed
build artifacts; CI verifies they stay in sync with `source/` on every
PR.

## Two consumer paths

### 1. Dokploy marketplace (BASE URL)

In any Dokploy instance, paste the raw URL of this repo's main branch
into the BASE URL field of the Templates panel:

```
https://raw.githubusercontent.com/catenahq/dokploy-templates/main/
```

Pin a release tag to freeze the catalog:

```
https://raw.githubusercontent.com/catenahq/dokploy-templates/tags/v0.1.0/
```

Operator setup doc: catenahq/docs `operator/dokploy-marketplace-setup`.

### 2. ops/ Ansible API-seeding (vendored)

catenahq/ops consumes a tagged tarball of `source/` and seeds the
"Templates" Dokploy project on each managed VPS at converge time. The
seeding pipeline owns `env_managed_keys` drift-healing (operator state
re-injected on every converge); the marketplace UI path does not.

## The env_managed_keys sentinel convention

Operator-controlled env vars (OIDC client id/secret, TURN auth secret,
discovery URL, ...) cannot be expressed in Dokploy's native template
variable syntax. The build pipeline replaces them in the published
blueprints with sentinel placeholders:

```
OIDC_CLIENT_SECRET=__CATENA_OPERATOR_WIRED__
```

ops/ converge overwrites these post-deploy with real vault values.
Marketplace-deployed templates need an ops/ converge pass before they
are functional.

## How to add a template

1. Add an entry to `source/catalog.yml` (schema documented inline).
2. Add `source/compose/<id>.compose.yml`.
3. Add `source/assets/<id>/logo.png` (square, 512x512 PNG).
4. Run `uv run build/render.py`. Commit the regenerated
   `blueprints/<id>/` + updated `meta.json`.
5. Open a PR. CI runs `build-and-verify.yml`.
6. After merge, tag a `vX.Y.Z` release.

## How to bump

Patch: env-default change, prose tweak. Minor: new template, new
env_managed_key. Major: catalog schema change (breaks the ops/ loader).

Tag a release: `git tag -a vX.Y.Z -m "..." && git push --tags`.
catenahq/ops's `Bump @catenahq/dokploy-templates to latest` workflow opens
a vendored-tarball-bump PR on its next daily run.

## What does NOT live here

- Vault values, OIDC client secrets, any actual secret. Sentinels only.
- Operator-side wiring (which env_managed_keys overwrite which vault
  refs, how OIDC clients get minted). Lives in catenahq/ops.
- Client-facing documentation. Lives in catenahq/docs (generated from
  `source/catalog.yml` by ops/automation/operator-tools/generate-template-docs.py).
- Per-VPS state (installed templates, CVE queue, SBOM). Lives at
  `/var/lib/catena/` on each managed VPS.

## Repo split status

Seventh repo in the catenahq split, lifted out of catenahq/ops on
2026-05-16. Predecessor location:
`ops/automation/ansible/roles/infrastructure/vars/dokploy_template_catalog.yml`
+ `ops/internal_docs/operator/client-app-templates/`. Lift driven by
the need to expose the catalog through Dokploy's BASE URL field and
to ship the CVE-watcher template (catenahq/ops `BACKLOG_TECHNICAL.md` R2).
