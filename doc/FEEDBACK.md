# FEEDBACK.md — External Feedback Log

> Structured intake for client, supervisor, tester, and user feedback. Initially empty by design (workflow Step 1). Do not implement feedback on arrival — follow workflow Step 8: compare against PRD, assess architecture/design/status impact, classify (new requirement / clarification / change / bug), record here, and wait for approval.

## Intake Process

1. Append one row per feedback item in §2 with Source, Date (UTC), and Related feature/phase.
2. Fill Impact after analysis (docs + phases + contracts/pages affected).
3. Set Status and only move to `Approved` on explicit owner approval.
4. Approved changes update the affected doc(s) first, then the corresponding STATUS.md phase — never code-first.

Status values: `Received | Under review | Accepted (pending docs) | Approved | Implemented | Rejected (with reason) | Deferred`.

## 1. Feedback Register

| # | Feedback | Source | Date (UTC) | Impact | Status | Related feature / phase |
|---|---|---|---|---|---|---|
| — | _No feedback recorded yet._ | — | — | — | — | — |

## 2. Detailed Entries

### FB-000 — (template, delete when real feedback arrives)

- Feedback: _Verbatim or paraphrased request._
- Source: _Client / Supervisor / Tester / User + name or group._
- Date: _YYYY-MM-DD._
- Classification: _New requirement / Clarification / Change / Bug._
- PRD comparison: _Conflicts with / clarifies / extends FR-__?_
- Architecture impact: _Contracts, data, dependency changes?_
- Design impact: _Pages, flows, copy changes?_
- Status impact: _Which STATUS.md phase is affected? New tasks needed?_
- Decision: _Accepted / Rejected (reason) / Deferred + approver + date._
- Follow-up: _Doc updates + implementation phase reference._

## 3. Feedback by Origin (summaries)

### Client

_No entries yet._

### Supervisor

_No entries yet._

### Tester

_No entries yet._

### User / Evaluator

_No entries yet._

## 4. Rejected / Deferred Log

| # | Reason for rejection/deferral | Decided by + date |
|---|---|---|
| — | — | — |
