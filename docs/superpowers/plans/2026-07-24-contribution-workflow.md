# Transcript Contribution Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe, documented workflow for proposing and applying transcript corrections while keeping JSON canonical and every derived artifact synchronized.

**Architecture:** A sync module reads canonical `json/tos-NNN.json` files and atomically regenerates Markdown, index, and SHA-256 manifest. A correction module selects one segment, enforces an expected-text guard, updates word-level data, rebuilds segment/full text, previews the diff, and writes only after confirmation. GitHub issue forms serve contributors who do not run the CLI.

**Tech Stack:** Node.js 22 ESM, built-in `node:test`, GitHub Actions and GitHub issue forms; no runtime dependencies.

## Global Constraints

- JSON is the only canonical editorial source.
- Markdown, `indice.json`, and `MANIFEST.sha256` are derived.
- Never invent timestamps after insertion or deletion.
- Same-word-count corrections preserve existing timestamps.
- Word-count or timestamp changes require explicit data and human review.
- All writes use staging and rollback.
- The repository remains free of audio, images, site artifacts, symlinks, and unapproved paths.

---

### Task 1: Deterministic derived-artifact synchronization

**Files:**
- Create: `scripts/sync.mjs`
- Create: `tests/sync.test.mjs`
- Modify: `package.json`
- Modify: `scripts/verify.mjs`

**Interfaces:**
- Produces: `syncTranscripts({ root, check?: boolean }): Promise<{ changed: string[], transcripts: number }>`
- Consumes: `assertTranscript()` and `renderMarkdown()` from `scripts/export.mjs`

- [ ] **Step 1: Write failing sync tests**

Test that sync regenerates Markdown, index, and manifest from fixture JSON;
that `check: true` reports drift without modifying files; and that a failed
validation leaves the old derived tree untouched.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/sync.test.mjs`

Expected: failure because `scripts/sync.mjs` does not exist.

- [ ] **Step 3: Implement staging and check mode**

Read sorted `json/tos-NNN.json`, validate each transcript, render derived
buffers, compare them to current files, and promote staged outputs only when
`check` is false. The CLI accepts `--check` and `--root`.

- [ ] **Step 4: Expose commands**

Add:

```json
"sync": "node scripts/sync.mjs",
"sync:check": "node scripts/sync.mjs --check"
```

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/sync.test.mjs && npm run sync:check`

Expected: all sync tests pass and drift count is zero.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/sync.mjs scripts/verify.mjs tests/sync.test.mjs
git commit -m "feat: add deterministic transcript sync"
```

### Task 2: Guarded correction engine and guided CLI

**Files:**
- Create: `scripts/correct.mjs`
- Create: `tests/correct.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `findSegment(transcript, selector)`
- Produces: `applyCorrection(transcript, correction)`
- Produces: CLI `npm run corrigir -- --episodio NNN`
- Consumes: `syncTranscripts({ root })`

- [ ] **Step 1: Write failing selection and correction tests**

Cover unique selection by segment ID, timestamp, and excerpt; ambiguity and
missing-match errors; expected-text mismatch; same-count replacement
preserving timestamps; word-count change rejection without explicit
`words[]`; explicit replacement validation; `segment.text` and `fullText`
reconstruction; and no write before confirmation.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/correct.test.mjs`

Expected: failure because `scripts/correct.mjs` does not exist.

- [ ] **Step 3: Implement pure correction functions**

`applyCorrection()` clones input, checks `expectedText`, tokenizes replacement
on whitespace for same-count edits, preserves timestamps, or requires an
explicit valid `words[]` array for count changes. It rebuilds:

```js
segment.text = segment.words.map(({ text }) => text).join(' ');
transcript.fullText = transcript.segments
  .map(({ text }) => text)
  .join('\n');
```

- [ ] **Step 4: Implement CLI**

Accept `--episodio`, one of `--segmento`, `--tempo`, or `--trecho`,
`--esperado`, `--texto`, optional `--palavras-json`, and `--sim`. Prompt for
missing values with `node:readline/promises`, show a before/after preview,
require explicit confirmation, atomically write the JSON, then run sync.

- [ ] **Step 5: Verify GREEN**

Run: `node --test tests/correct.test.mjs && npm test`

Expected: correction tests and full suite pass.

- [ ] **Step 6: Commit**

```bash
git add package.json scripts/correct.mjs tests/correct.test.mjs
git commit -m "feat: add guarded transcript correction tool"
```

### Task 3: Contributor documentation and GitHub forms

**Files:**
- Create: `CONTRIBUTING.md`
- Create: `.github/ISSUE_TEMPLATE/correcao-transcricao.yml`
- Create: `.github/ISSUE_TEMPLATE/config.yml`
- Create: `.github/pull_request_template.md`
- Modify: `README.md`

**Interfaces:**
- Documents: nontechnical issue flow and technical CLI/PR flow
- Links: README → CONTRIBUTING; issue form → canonical contribution data

- [ ] **Step 1: Write the contribution guide**

Include:

- correction categories: speech, proper names, citations, punctuation,
  timestamps, and speaker identification;
- evidence hierarchy: episode timestamp, cited primary source, book/article
  edition and page, and reliable external reference;
- exact CLI examples for same-count and explicit-word corrections;
- files contributors may and may not edit;
- PR checklist, small-scope rule, respectful language, and rights notice;
- examples of good and insufficient correction reports.

- [ ] **Step 2: Add issue and PR templates**

The issue form requires episode, timestamp, current excerpt, proposed text,
category, rationale/evidence, and a good-faith confirmation. The PR template
requires linked issue, changed episodes, evidence, word/timestamp review, and
successful `npm test`, `npm run sync:check`, and `npm run verify`.

- [ ] **Step 3: Update README**

Add a prominent contribution link and replace “byte-for-byte canonical copy”
with “original byte-for-byte import followed by versioned editorial
corrections.”

- [ ] **Step 4: Validate links and examples**

Run every documented command against a temporary clone/fixture and confirm
that all relative Markdown links resolve.

- [ ] **Step 5: Commit**

```bash
git add CONTRIBUTING.md README.md .github
git commit -m "docs: add transcript contribution guide"
```

### Task 4: Repository invariants, CI, and publication

**Files:**
- Modify: `scripts/export.mjs`
- Modify: `scripts/verify.mjs`
- Modify: `tests/verify.test.mjs`
- Modify: `.github/workflows/verify.yml`

**Interfaces:**
- Consumes: canonical JSON and `sync:check`
- Produces: CI gate for schema, transcript relationships, derivation, and repository allowlist

- [ ] **Step 1: Write failing invariant tests**

Add cases for duplicate/out-of-order segment IDs, decreasing word timestamps,
word times outside segment/duration, segment time outside duration,
word→segment mismatch, segment→fullText mismatch, and newly approved support
paths.

- [ ] **Step 2: Verify RED**

Run: `node --test tests/verify.test.mjs`

Expected: new invariant cases fail for the intended reason.

- [ ] **Step 3: Implement invariant and allowlist checks**

Share validation across export, sync, correction, and verify. Permit only the
new contribution documents, templates, scripts, tests, spec, and plan.

- [ ] **Step 4: Update CI**

Run in order:

```yaml
- run: npm run verify
- run: npm run sync:check
- run: npm ci
- run: npm test
```

- [ ] **Step 5: Run full verification**

Run:

```bash
npm run sync
npm run sync:check
npm run verify
npm test
git diff --check
```

Expected: 296 JSON, 296 Markdown, zero audio, zero drift, and all tests pass.

- [ ] **Step 6: Independent review**

Ask a subagent to review the guide, CLI safety, derived-artifact determinism,
invariants, and GitHub templates. Fix all Critical and Important findings.

- [ ] **Step 7: Commit and push**

```bash
git add .github CONTRIBUTING.md README.md docs package.json scripts tests
git commit -m "chore: enforce transcript contribution workflow"
git push
```

- [ ] **Step 8: Validate GitHub**

Wait for the Verificação workflow to succeed and confirm the published
CONTRIBUTING and issue form URLs return HTTP 200.
