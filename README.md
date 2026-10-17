# ClaimReady

ClaimReady is an evidence-first insurance-claim preparation prototype. It turns a short voice note and two supporting documents (a policy plus a bill or discharge summary) into a reviewable packet. It does not submit a claim, make a coverage decision, or provide medical advice.

## What it does

- Keeps a clearly labeled sample case available without an API key.
- Transcribes a voice note with Saaras v4 and asynchronously extracts fixed fields from both documents with Sarvam Document AI.
- Shows source filename, page, and confidence for extracted fields when returned by the service.
- Uses deterministic checks for missing details and direct differences in patient name, admission date, and claimed amount; an LLM produces a constrained summary and editable first-person draft, not a coverage judgment.
- Supports a clarification round, optional spoken next steps, and JSON packet download.
- Calculates SHA-256 hashes for the submitted audio and documents and creates a short-lived integrity hash for the displayed packet.
- Keeps files and review data in request memory only; job IDs are carried in a signed, 15-minute token. The browser sends uploads to the app's worker, which sends them to Sarvam AI. No app database or file storage is used.

## Run checks

```sh
npm test
npm run build
npm run validate
```

`npm test` includes a mocked end-to-end live workflow. It does not call Sarvam or require a key.

## Required runtime secret

Set `SARVAM_API_KEY` as a secret in the hosting environment. Do not put the key in source code, the browser, or a committed file. Without it, the live endpoints return a configuration message and the sample case remains usable.

## Before a public launch

The current MVP has strict file-size/type limits and same-origin checks, but live processing is not protected by per-user authentication or a shared rate limiter. Add platform-level rate limiting or a bot challenge before exposing live endpoints publicly, and confirm the provider's data-retention terms and your privacy notice for the intended documents. Use synthetic or sanitized documents while testing.

## Live flow

1. `POST /api/claim/start` validates and hashes the files, transcribes the voice note, and starts two extraction jobs.
2. `POST /api/claim/status` checks the asynchronous jobs using the signed session token.
3. `POST /api/claim/analyze` fetches results, preserves evidence annotations, compares selected fields deterministically, and requests schema-constrained explanatory text.
4. `POST /api/claim/speak` optionally narrates the next steps in the selected language.

The app intentionally avoids coverage eligibility, fraud, and medical determinations. Missing fields and differences are prompts for a person to verify against the original documents.
