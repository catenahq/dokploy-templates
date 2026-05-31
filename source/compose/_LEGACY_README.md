# Client-app templates -- maintenance guide

Dokploy's "Templates" project is pre-seeded from this folder. Each
template is a compose file here + one entry in the catalog at
[`roles/infrastructure/vars/dokploy_template_catalog.yml`](../../../roles/infrastructure/vars/dokploy_template_catalog.yml).

The client-facing reference pages under `apps/docs/wiki/src/catalog/` are
**machine-generated** from the catalog -- don't hand-edit them.

## Files in play

| File | Purpose |
|---|---|
| `<id>.compose.yml` (this folder) | The docker-compose body. Shipped verbatim to Dokploy at seed time. |
| `roles/infrastructure/vars/dokploy_template_catalog.yml` | Catalog: metadata, env defaults, bilingual prose (EN + FR subkeys per entry). Sole source of truth. |
| `operator-tools/generate-template-docs.py` | Pure-Python generator that renders per-template client docs + the index. |
| `apps/docs/wiki/src/catalog/<id>.{md,fr.md}.j2` | Generated output. Re-rendered every run; don't edit directly. |
| `apps/docs/wiki/src/catalog/index.{md,fr.md}.j2` | Generated catalog index. Same rule. |
| `roles/infrastructure/tasks/dokploy_templates.yml` | Ansible seeder -- reads catalog, POSTs to Dokploy, uses the `en.compose_description` field as Dokploy's description text. |

## `vps.auth.*` label convention (also used by infra apps)

Both client templates here AND the infrastructure-app composes under
`ansible/roles/infrastructure/templates/{olivetin,gatus,homepage,healthchecks}.compose.yml.j2`
declare their auth posture via the same compose labels:

| Label | Values | Meaning |
|---|---|---|
| `vps.auth.mode` | `public` / `private` / `admin-only` | Whether (and how) the host is gated. Default if unset = `private`. |
| `vps.auth.groups` | comma-list of Keycloak groups | Group filter applied in front of the host. `private` defaults to `staff`; `admin-only` always pins `admin`. |
| `vps.auth.oidc` | `true` / `false` | App is OIDC-aware itself (handles its own auth). `false` for hosts that need oauth2-proxy in front. |

**Infra apps** (the ones in `oauth2_proxy_apps` /
`oauth2_proxy_public_oidc_apps`): each gated host runs its OWN
oauth2-proxy container in reverse-proxy mode (`Host(<x>) ->
oauth2-proxy-<slug>:4180 -> upstream`). Routes are written by
`roles/oauth2_proxy` directly from the unified list in its
`defaults/main.yml`; the labels declare the SAME posture inside the
compose so it travels with the file. A drift-guard test
([tests/unit/test_infra_compose_auth_labels.py](../../../tests/unit/test_infra_compose_auth_labels.py))
fails if a label is changed without the corresponding list move.

**Client apps** deployed via Dokploy: routes are written by
`dashboard-sync` from these labels
(see [tests/unit/test_dashboard_sync_gate_routes.py](../../../tests/unit/test_dashboard_sync_gate_routes.py)).
Until Phase 2 of the reverse-proxy migration ships, those routes
still chain through the legacy shared `oauth2-proxy-staff` /
`oauth2-proxy-admin` instances (kept alive by
`oauth2_proxy_keep_legacy_chain=true`). Phase 2 will provision a
per-app oauth2-proxy container for each gated client app so the
same clean-302 UX applies.

## Workflow: add or modify a template

1. **Edit the compose file** under `docs/operator/client-app-templates/`.
   Pin all images to full semver tags (`patch`-level managed-updates
   only touch full semver). Use `vps.auth.mode`, `vps.auth.oidc`,
   `vps.auth.groups`, `vps.auto-update` labels as needed -- see
   existing templates for conventions.

2. **Edit the catalog** at
   `roles/infrastructure/vars/dokploy_template_catalog.yml`. New
   entries need:
   - Structural fields: `id`, `app_name`, `upstream_url`, `sso_mode`
     (enum: `pre-wired | post-deploy-ui | jackson-curl | none | n/a`),
     `domain_host`, `domain_service`, `domain_port`, `compose_file`,
     `env_defaults` (list of `KEY=value` strings).
   - Bilingual prose under `en:` and `fr:` subkeys:
     `display_name`, `what_it_is`, `replaces` (list),
     `compose_description` (short -- ~3 lines, what + replaces + link
     to docs page), `setup_steps` (Markdown), `extra_notes` (optional).

3. **Regenerate docs:**

   ```bash
   uv run python3 operator-tools/generate-template-docs.py
   ```

   Check the diff. The drift guard in the test suite will fail
   otherwise.

4. **Push the catalog update to Dokploy:**

   The seeder is **strictly no-op** on any template that already
   exists in Dokploy -- it won't touch description, composeFile, env,
   or domains once the template has been seeded. This preserves
   client edits but means a plain `./catena site` does NOT push catalog
   updates to existing templates.

   To refresh an already-seeded template with the new catalog
   content, **delete the compose in Dokploy's UI** and re-run:

   ```bash
   ./catena site --tags infrastructure --limit <host>
   ```

   The next converge sees the template is missing from Dokploy and
   re-creates it from the catalog (auto-restore). No sentinel file
   editing needed -- the sentinel is advisory-only in the current
   design.

5. **Run tests:**

   ```bash
   uv run pytest tests/unit/test_dokploy_templates.py -v
   ```

   Catalog contract tests + the drift guard cover the common
   failure modes (missing fields, invalid `sso_mode`, operator-only
   vocabulary in `compose_description`, catalog/generated-docs drift).

## Workflow: opt a template into managed-key env auto-heal

The seeder is **strictly no-op** by default for any template that
already exists in Dokploy with a non-empty composeFile. That preserves
client edits but ALSO means the operator cannot push corrected env
values without using the rename trick (next section).

For env keys that are operator-controlled and deterministic (hostnames,
OIDC integration vars, anything that should track an upstream change),
opt them into auto-heal by adding an `env_managed_keys` list to the
catalog entry. Example:

```yaml
- id: nextcloud-s3-oidc
  app_name: nextcloud
  ...
  env_managed_keys:
    - NEXTCLOUD_HOSTNAME
    - OIDC_CLIENT_ID
    - OIDC_CLIENT_SECRET
    - OIDC_DISCOVERY_URL
  env_defaults:
    - NEXTCLOUD_HOSTNAME=nextcloud.{{ cloudflare_zone }}
    - NEXTCLOUD_ADMIN_PASSWORD={{ lookup('password', '/dev/null length=24 chars=ascii_letters,digits') }}
    - OIDC_CLIENT_ID={{ ... }}
    - ...
```

Behavior on next converge for a present template:

| Catalog has `env_managed_keys`? | Behavior on existing env |
|---|---|
| absent or empty | Strict no-op. Existing env preserved verbatim. (default) |
| non-empty | Listed keys force-reset to current catalog values; all other keys (including catalog defaults NOT listed AND client-added keys) preserved verbatim. composeFile ALWAYS untouched. |

### CRITICAL safety rule

**Do NOT add a catalog key whose value uses `lookup('password', ...)`
to `env_managed_keys`.** Jinja re-evaluates the lookup on every
converge -> fresh random value -> secret rotation on every run -> broken
deployment. Only deterministic, operator-controlled keys (hostnames,
URL bases, static config, OIDC IDs minted out-of-band by
dashboard-sync and stored in vault) are safe.

The contract is pinned by
`test_existing_catalog_entries_have_no_env_managed_keys_yet` in
`tests/unit/test_dokploy_template_env_merge.py` -- every catalog edit
that adds `env_managed_keys` requires a deliberate test update so the
review confirms each managed key is deterministic.

### Why this exists

Recommendation D from the pre-sales hardening review. Without it, a
client whose Dokploy compose has the right composeFile but wrong OIDC
env values has to be repaired via the rename trick -- which loses ALL
their other env edits. With env_managed_keys on the OIDC vars, the
operator's converge auto-heals just those keys; everything else the
client typed survives.

## Workflow: repair a broken template (without losing client edits)

The seeder is **strictly no-op** when a template's compose exists in
Dokploy with a non-empty composeFile (see "push the catalog update"
above). That means a converge will never overwrite client edits -- but
it also means a converge cannot **fix** a broken template either.

Scenario: a client edited their Nextcloud compose in the Dokploy UI,
broke one field (e.g. typo'd an env var, removed a load-bearing label),
and now their Nextcloud is down. They want it repaired but they ALSO
have other edits on that compose they don't want to lose (a custom
volume mount, a tweaked env value, etc.).

### Recommended recipe -- four steps in the Dokploy UI

1. **Stop the broken compose.** Click "Stop" in Dokploy. Frees
   container processes, network attachments, and any published ports.
   The Dokploy-managed Traefik labels still exist (they live in the
   compose definition stored in Postgres, not in the runtime) -- step 3
   takes care of those.

2. **Rename the compose's `name` field** in the Dokploy UI. Use a
   sentinel suffix with the date so multiple repair attempts don't
   collide:

   ```
   nextcloud  ->  nextcloud-broken-2026-04-26
   ```

   `appName` does NOT need to change. Dokploy generates container
   names as `<name>-<6-char-hash>-<service>-<index>` (e.g.
   `nextcloud-ehlkpl-db-1`); the per-compose hash disambiguates two
   composes that share an `appName`.

3. **Detach domains from the broken compose** (or rename their Host
   to a sentinel like `broken-nextcloud.example.com`). The catalog-
   fresh compose will try to bind the same Host on the next converge;
   Traefik surfaces "router conflict" if the broken compose still
   claims it.

4. **Run a converge:**

   ```bash
   ./catena site --tags infrastructure --limit <host>
   ```

   The seeder's existence check keys on `name`, so the lookup misses
   the renamed compose, finds no `nextcloud` in the Templates project,
   and recreates it from the catalog with default env + a fresh
   compose hash -- no host conflict, no container collision.

5. **Side-by-side diff in the Dokploy UI** between the renamed-broken
   compose and the new catalog-fresh one. Copy the good edits over
   (custom volume mounts, env values, anything the client wants to
   keep). Deploy the new compose.

6. **Delete the renamed-broken compose** when satisfied that the new
   one is healthy.

### Why this works (pinned by tests)

- The existence check at
  [`_dokploy_template_seed_one.yml`:51-60](../../../roles/infrastructure/tasks/_dokploy_template_seed_one.yml)
  matches by `name == _tmpl.app_name`. Renaming `name` triggers the
  recreate path. Locked in by `test_seed_one_existence_check_keys_on_name_field`.
- The compose.create body sets both `name` and `appName` from the
  catalog. Locked in by `test_seed_one_create_body_sets_both_name_and_app_name`.
- The "Templates" project description in the Dokploy UI documents the
  recipe to clients directly. Locked in by
  `test_templates_project_description_announces_client_ownership`.

### Unverified edge case

Whether Dokploy's `compose.create` endpoint enforces uniqueness on
`appName` per environment is empirically untested as of 2026-04-26. If
you hit a 409/422 on step 4, also rename the `appName` field in the
Dokploy UI (e.g. `nextcloud` -> `nextcloud-broken-2026-04-26`) and
re-run the converge. Update this doc + the file headers if you confirm
the constraint.

### When NOT to use the rename trick

- **Just want catalog defaults**, no client edits to preserve: simpler
  to delete the compose in Dokploy UI and let the next converge
  recreate it. See "push the catalog update to Dokploy" above.
- **All-client-edits-are-disposable**: same -- delete + recreate.
- **Operator wants to push a NEW catalog version of the compose to
  ALL clients**: not yet supported. Backlog item B (per-template
  force-reset CLI flag) is the planned automation. Until then, repeat
  the recipe per host.

## Workflow: delete a template

1. Delete its `docs/operator/client-app-templates/<id>.compose.yml`.
2. Remove the catalog entry.
3. Re-run the generator -- the per-template docs pages under
   `apps/docs/wiki/src/catalog/` should disappear on the next regen.

   Note: the generator only writes files; it doesn't delete stale
   output. Remove the old `apps/docs/wiki/src/catalog/<id>.md.j2` +
   `<id>.fr.md.j2` files by hand.
4. Update the `nav:` in [`apps/docs/wiki/src/mkdocs.yml.j2`](../../client/src/mkdocs.yml.j2)
   to drop the deleted entry.
5. Existing client deploys are untouched -- the seeder only acts on
   entries in the current catalog. A template removed from the
   catalog is never auto-restored, even if its Dokploy compose is
   deleted by the client. If the template was already seeded on a
   client's VPS and you want to tear it down, the client does that
   themselves in Dokploy's UI.

## Workflow: post-deploy plugin / config wiring

A template's compose body cannot drive in-app configuration that
requires app-level CLI calls (Nextcloud's `occ`, WordPress's `wp-cli`,
etc.). Dokploy can only do "container starts, env vars are present" --
anything beyond that is the operator's responsibility.

The pattern: a per-app Ansible task at
`roles/infrastructure/tasks/<app>_<feature>.yml`, included from
`main.yml` after the template seed, that runs idempotent CLI commands
inside the running container via `docker exec`. Skips cleanly when the
container is not deployed.

| Task | Triggered by | What it wires |
|---|---|---|
| `nextcloud_oidc.yml` | converge (Keycloak realm only) + **OliveTin button "Wire Nextcloud OIDC"** for the in-container `occ user_oidc:provider keycloak ...` step | Keycloak `nextcloud` realm client at converge; in-Nextcloud OIDC provider on demand via `/usr/local/bin/catena-wire-nextcloud-oidc` |
| `wordpress_plugins.yml` | `--tags wordpress_plugins` | `wp plugin install --activate` for the curated set + `wp option update` for cross-plugin wiring (Redis object cache, NPP FastCGI cache, Performance Lab modules, wp-mail-smtp) |

**Lifecycle policy.** Per-converge wiring is reserved for state that
belongs to the controller-managed half (Keycloak realm clients,
DNS, vault-derived env). Per-app *post-deploy* wiring (occ, wp-cli,
curl) belongs on the on-demand path -- an OliveTin button (preferred)
or a documented Dokploy Terminal one-liner. Reason: converge runs
only at initial install or full VPS repair. Operator should not
have to re-run a converge against a production VPS just to enable
OIDC on a freshly deployed Dokploy template. New per-app wirings
follow the OliveTin button shape used by `nextcloud_oidc.yml`.

### Atomicity contract (mirrors nextcloud_oidc.yml)

1. **Container detection.** Match the running container via
   `docker ps --format '{{.Names}}' | grep -E '<id>-[0-9a-z]{6,}-<service>-'`.
   Empty stdout -> debug-skip and end. Never assume a hardcoded container
   name; Dokploy's hash differs per deploy.
2. **HTTP/CLI readiness gate.** "Container exists in `docker ps`" is
   NOT readiness. Use a real probe -- `wp core is-installed`, `occ
   status`, `/health/ready`, etc. -- with `until: rc == 0`, retries 30,
   delay 2. The wp / NC entrypoints copy files first then start the app;
   the readiness probe ensures the app is past that.
3. **Idempotent mutation.** Every step gates on a `<cli> is-X` check
   first. `wp plugin is-installed <slug>` -> `wp plugin install <slug>`
   only if rc=1. Option updates use the get-combine-update pattern:
   read current value, merge with desired, write only on diff. Running
   the task twice in a row produces zero `changed=` on the second run.
4. **`no_log: true` for credential-bearing commands.** OIDC client
   secrets, SMTP passwords, etc. should never reach Ansible's stdout
   logs. Either pass via constants in `WORDPRESS_CONFIG_EXTRA` /
   compose env (Dokploy-injected) or use no_log.
5. **Skip cleanly when prerequisites are not met.** SMTP not
   configured? Plugin installed but unwired, debug message instead of
   error. The operator can always come back later, set the inventory
   var, and re-converge.

The full WordPress runbook (services, smoke tests, cache flush, how to
extend) lives in [`docs/operator/wordpress-stack.md`](../wordpress-stack.md).

## What the Dokploy "description" field shows

The `en.compose_description` (or `fr.` when the client has
`catena_default_language: fr`) is what Dokploy displays in the
compose's description column. Keep it to ~3 lines:

1. One-line pitch naming the app + what it replaces.
2. Blank line.
3. `Full setup guide: https://{{ vps_docs_hostname }}/templates/<id>/`.

Full walkthrough content belongs in `setup_steps` + `extra_notes`,
rendered to the per-template docs page.

## Regression tests

- `test_catalog_has_expected_ids` -- catalog contains all canonical templates.
- `test_catalog_entries_have_required_structural_fields` -- every entry has the required top-level + prose fields; `sso_mode` is a valid enum.
- `test_catalog_env_defaults_have_no_vault_dependencies` -- templates stay self-contained.
- `test_catalog_compose_descriptions_are_client_facing` -- no operator-only vocabulary, always includes the docs URL.
- `test_generated_template_docs_are_up_to_date` -- running the generator would produce no diff.
- `test_templates_task_does_not_mutate_shared_project_facts` -- the stray-SSO-stack regression guard (originally caught a duplicate Authentik project; same risk now applies to Keycloak).

---

<!-- Last reviewed: 2026-05-13 -->
