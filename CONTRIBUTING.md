# Contributing to LocalShare

Thanks for your interest in contributing to LocalShare! This document explains how to set up a development environment, the standards we hold contributions to, and how to report problems.

## Clone and Run in Dev Mode

Requirements: Node.js >= 18 and npm >= 9.

```bash
git clone https://github.com/localshare/localshare.git
cd localshare
npm install
npm run dev
```

`npm run dev` starts the server under [nodemon](https://nodemon.io), which restarts it whenever a source file changes. The server is available at http://localhost:3000 by default.

To run the server once without the file watcher:

```bash
npm start
```

## Code Style

- We use **Prettier** for formatting and **ESLint** for linting. Run both before opening a pull request:

  ```bash
  npm run lint
  npm run format
  ```

- The project is **ESM only**: `"type": "module"` is set in `package.json`. Write native ES modules (`import` / `export`); never use `require()`.
- **Node.js >= 18** is required (see the `engines` field in `package.json`).
- Match the surrounding style. When you touch a file, keep its existing conventions.

## Running the Tests

The test suite runs on [Vitest](https://vitest.dev):

```bash
npm test               # run the whole suite once
npm run test:watch     # rerun tests on file changes
npm run test:coverage  # run with a coverage report
```

Coverage thresholds are enforced in `vitest.config.js`; CI fails the build if they are not met:

- Statements: >= 80%
- Lines: >= 80%
- Functions: >= 80%
- Branches: >= 75%

## Branch Naming

Use one of these prefixes on every branch:

| Prefix   | Use for                            |
| -------- | ---------------------------------- |
| `feat/`  | new features                       |
| `fix/`   | bug fixes                          |
| `docs/`  | documentation-only changes         |
| `chore/` | maintenance, tooling, dependencies |

Example: `feat/qr-code-shorturl`.

## Pull Request Expectations

- **Describe what changed and why.** Every PR needs a clear description of the change and the motivation behind it.
- **A test for each bug fix.** Add a regression test that fails before the fix and passes after it. New features should come with tests too.
- **Update docs when behavior changes.** If you change user-visible behavior, update `README.md`, `docs/`, and `CHANGELOG.md` in the same PR.
- **Green CI.** `npm run lint` and `npm test` must pass locally and in CI before the PR can be merged.
- Keep PRs focused. Send unrelated changes as separate pull requests.

## Issue Triage Labels

- `bug`: something is broken or behaves unexpectedly. Use the bug report template and include environment details, steps to reproduce, and logs.
- `enhancement`: a feature request or an improvement to existing behavior.
- `documentation`: gaps, errors, or improvements in documentation.
- `good first issue`: small, well-scoped tasks that are a good starting point for first-time contributors.
- `help wanted`: maintainers are actively looking for community help on this issue.
- `question`: questions and discussion that do not (yet) describe a bug or a request.
- `security`: an issue with security implications. Even when labeled `security`, do not post exploit details publicly; follow the process below instead.

## Reporting a Security Vulnerability

**Never open a public issue for a security vulnerability.**

1. Email **security@localshare.dev** first, or use [GitHub Security Advisories](https://github.com/localshare/localshare/security/advisories/new) to report the issue privately.
2. Include the affected version, reproduction steps, and the potential impact.
3. Give us a reasonable time to investigate and release a fix before any public disclosure.

We will acknowledge your report, keep you updated on the fix, and credit you in the changelog if you want to be named.

## Questions

For general questions about using or developing LocalShare, open a `question` issue or start a discussion. For anything conduct-related, see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
