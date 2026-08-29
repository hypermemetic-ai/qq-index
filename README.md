# qq-index

`@hypermemetic-ai/qq-index` keeps a repository’s orientation at the place
people and tools already look: root `README.md`. The same bounded document is
visible on GitHub, included as npm package documentation, and returned by
`loadIndex`. There is no separate wiki or page graph.

## Start here

- [`src/plugin.mjs`](src/plugin.mjs) is the Cordis entry point. It provides the
  bounded loader service as `qq-index`, so hosts discover the package without
  coupling consumers to it.
- [`src/index.mjs`](src/index.mjs) is the public synchronous boundary. It loads
  a README up to 10,000 Unicode code points and validates relative Markdown
  links without allowing links to escape the repository.
- [`src/harvest.mjs`](src/harvest.mjs) creates the model’s deterministic evidence
  packet from tracked paths, normalized package metadata, fixed-window change
  heat, and relative-import fan-in.
- [`prompts/writer.md`](prompts/writer.md) constrains the model to that packet and
  to one output file. The model cannot browse source or create secondary docs.
- [`src/refresh.mjs`](src/refresh.mjs) owns isolation, validation, commit, and
  fast-forward publication. It rejects every model change except `README.md`.

## Data flow

1. The outer program clones a clean `main` checkout under a per-repository lock.
2. [`harvestRepository`](src/harvest.mjs) records `git ls-files`, `package.json`,
   path heat over a fixed commit window, and module fan-in in stable order.
3. [`src/model-pass.mjs`](src/model-pass.mjs) appends that packet to the frozen
   writer contract and launches the headless model through
   [`config/writer.patch.yml`](config/writer.patch.yml).
4. [`src/writer-boot.mjs`](src/writer-boot.mjs) mounts qq-workflows’ Mini Docs
   adapter on every headless agent and supplies the minimal `qq-core` surface it
   requires. Mini Docs owns wrapped bash and completion interception.
5. The outer program verifies the README-only diff, validates local links,
   commits as `qqp-bot`, checks that live `main` has not moved, and publishes by
   fast-forward.

The packet is intentionally source-free. Package metadata supports package and
command claims; paths, heat, and fan-in support routing and prioritization.
Names alone are not treated as proof of runtime semantics.

## Public API

```js
import {
  INDEX_MAX_CHARS,
  loadIndex,
  validateIndex,
} from "@hypermemetic-ai/qq-index";

const orientation = loadIndex(repositoryRoot); // "" when README.md is absent
validateIndex(repositoryRoot);                 // true or throws
```

Cordis hosts load the package as a plugin, and consumers resolve the `qq-index`
service through the host. It exposes a frozen `{ loadIndex, validateIndex }`
service.

`validateIndex` ignores external URLs and in-document fragments. Every relative
link and image must resolve to a regular file under the repository root;
encoded traversal, absolute paths, missing files, directories, and escaping
symlinks fail validation.

## Run and verify

```bash
npm test
bin/qq-index-refresh --repo /path/to/repository
```

With no `--repo`, the CLI reads the bounded registry in
[`config/repositories`](config/repositories) and refreshes at concurrency three.
The packaged oneshot and schedule are
[`systemd/user/qq-index.service`](systemd/user/qq-index.service) and
[`systemd/user/qq-index.timer`](systemd/user/qq-index.timer). The checkout folder
remains `qq-wiki`, so the service’s working directory deliberately retains that
physical path even though the product and executable are `qq-index`.

## Change map

- Loader limits or link policy: start with
  [`src/index.mjs`](src/index.mjs) and [`tests/index.mjs`](tests/index.mjs).
- Packet shape, path ranking, or import resolution: start with
  [`src/harvest.mjs`](src/harvest.mjs) and
  [`tests/harvest.mjs`](tests/harvest.mjs).
- Model, Mini Docs, or DSH overlay behavior: read
  [`src/model-pass.mjs`](src/model-pass.mjs),
  [`src/writer-boot.mjs`](src/writer-boot.mjs), and
  [`tests/writer-boot.mjs`](tests/writer-boot.mjs) together.
- Locking, source-change detection, Git boundaries, or publication: start with
  [`src/refresh.mjs`](src/refresh.mjs) and
  [`tests/refresh.mjs`](tests/refresh.mjs).
- Registry selection and bounded parallelism live in
  [`src/cli.mjs`](src/cli.mjs).
