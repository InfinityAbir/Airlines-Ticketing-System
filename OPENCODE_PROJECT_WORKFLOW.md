# OPENCODE_PROJECT_WORKFLOW.md

# OpenCode Project Workflow

A reusable workflow for building projects with OpenCode and a single primary coding model such as Muse Spark 1.3.

The workflow is designed for projects that start with a PRD and a defined technology stack.

---

## 0. Project Principles

Follow these principles throughout the project:

- `doc/PRD.md` is the source of truth for requirements.
- `ARCHITECTURE.md` is the source of truth for architecture.
- `DESIGN.md` is the source of truth for UI/UX and system behavior.
- `CONVENTIONS.md` is the source of truth for coding practices.
- `DECISIONS.md` records important technical and architectural decisions.
- `FEEDBACK.md` records external feedback and its impact.
- `STATUS.md` is the source of truth for implementation progress.
- Do not invent requirements.
- Do not introduce unnecessary technologies.
- Preserve valid existing work.
- Do not rewrite working code unnecessarily.
- Do not work ahead on later phases.
- After every implementation phase, verify the result before moving forward.
- Keep documentation synchronized with the actual implementation.

## Development Tools

### Codebase MCP

Use the configured Codebase MCP server when it is available.

Use it to:
- Understand and navigate the existing codebase.
- Search for existing implementations, patterns, dependencies, and relationships.
- Inspect relevant code before making significant changes.
- Reuse existing functionality instead of duplicating it.
- Understand the impact of changes across the repository.

Do not assume an implementation is missing until the existing codebase has been inspected.

### Playwright

Use Playwright for end-to-end and browser-based verification when applicable.

Use it to:
- Test complete user workflows.
- Verify frontend/backend integration.
- Test authentication and authorization flows.
- Verify forms, navigation, and important user journeys.
- Reproduce and investigate browser-visible issues.
- Add or update E2E tests for important user-facing workflows where appropriate.

Do not require Playwright for changes that do not involve browser-facing behavior. Use the most appropriate testing level for the change.

A successful build or unit/integration test run does not replace E2E verification when a user-facing workflow is affected.

---

# 1. Analyze PRD and Create Project Documentation

### Prompt

```text
Read `doc/PRD.md` and `OPENCODE_PROJECT_WORKFLOW.md` carefully before doing anything else.

Use `doc/PRD.md` as the source of truth for requirements and follow this workflow file for the development process and tool usage.

Before writing any application code, inspect the existing repository and create the following 6 documentation files under `doc/`:

1. `doc/ARCHITECTURE.md`
2. `doc/DESIGN.md`
3. `doc/STATUS.md`
4. `doc/DECISIONS.md`
5. `doc/FEEDBACK.md`
6. `doc/CONVENTIONS.md`

Use `doc/PRD.md` as the source of truth for requirements.

ARCHITECTURE.md:
Define the system architecture, project structure, modules, layers, responsibilities, database approach, API boundaries, authentication/authorization, integrations, dependency direction, and important architectural rules based on the PRD and tech stack.

DESIGN.md:
Define the UI/UX structure, screens, navigation, user flows, component behavior, forms, validation, loading/error states, responsive behavior, and design principles.

STATUS.md:
Create a practical implementation roadmap divided into clear phases.

Each phase must:
- Have a clear objective.
- Contain small, logically grouped tasks.
- Have dependencies identified.
- Have clear completion criteria.
- Be ordered logically.
- Initially be marked as "Not Started".

Do not make phases unnecessarily large.

DECISIONS.md:
Record important architectural and technical decisions made during analysis, including the reasoning behind them.

Do not record trivial decisions.

FEEDBACK.md:
Create a structured place for future client, supervisor, tester, and user feedback.

Include sections for:
- Feedback
- Source
- Date
- Impact
- Status
- Related feature/phase

Keep it initially empty except for the defined structure.

CONVENTIONS.md:
Define coding standards, naming conventions, folder/file conventions, API conventions, database conventions, error handling, validation, testing practices, security practices, and rules specific to the selected tech stack.

Important rules:

- Do NOT create, overwrite, rename, or modify `doc/PRD.md`.
- Create only the six new documentation files under `doc/`.
- Do NOT write application code yet.
- Do NOT invent requirements.
- Do NOT introduce unnecessary technologies.
- Use the provided tech stack unless there is a strong technical reason to recommend a change.
- If something is ambiguous, document it under "Open Questions" instead of guessing.
- Inspect existing repository code before proposing structural changes.
- Preserve valid existing work.
- Do not recreate existing functionality unnecessarily.
- Keep all six documents consistent with PRD.md and the selected tech stack.
- Keep the documentation practical and implementation-oriented.
- Treat PRD.md as the source of truth for requirements.
- Treat ARCHITECTURE.md as the source of truth for architecture.
- Treat CONVENTIONS.md as the source of truth for coding practices.
- Treat STATUS.md as the source of truth for implementation progress.

At the end, summarize:
1. Major architectural decisions.
2. Project structure.
3. Implementation phases.
4. Open questions.
5. Any assumptions that require my approval.

Do not start implementation.

Wait for my approval.
```

---

# 2. Review the Documentation

After Step 1 finishes, use:

```text
Review PRD.md and all six documentation files together.

Check for:

- Contradictions.
- Missing requirements.
- Incorrect assumptions.
- Architectural problems.
- Missing edge cases.
- Incomplete business rules.
- Inconsistencies between architecture and tech stack.
- Inconsistencies between design and requirements.
- Incorrect dependencies between phases.
- Phases that are too large or poorly defined.
- Missing completion criteria.
- Security concerns.
- Database design concerns.
- API design concerns.
- Frontend/backend boundary problems.

If a problem is found, fix the documentation.

Do not write application code.

After the review, give me a concise report containing:

1. What was corrected.
2. Important architectural decisions.
3. Open questions.
4. Final implementation phases.
5. Anything that still requires my approval.

Do not start implementation.
```

---

# 3. Approve the Documentation

Review the documentation and the model's report.

If everything is acceptable, use:

```text
The documentation is approved.

Proceed with implementation starting from Phase 1 in STATUS.md.
```

---

# 4. Implement Phase 1

```text
Implement Phase 1 from STATUS.md.

Before coding:

1. Read PRD.md.
2. Read `doc/ARCHITECTURE.md`.
3. Read `doc/DESIGN.md`.
4. Read `doc/CONVENTIONS.md`.
5. Read `doc/STATUS.md`.
6. Read relevant entries in DECISIONS.md.
7. Inspect the current repository structure and existing implementation.
8. Use the configured Codebase MCP server to inspect relevant code and relationships when available.

Determine exactly what Phase 1 requires and what already exists.

Implementation rules:

- Follow the approved architecture.
- Follow the documented coding conventions.
- Preserve valid existing work.
- Do not unnecessarily rewrite existing code.
- Do not introduce new technologies unless absolutely necessary and justified.
- Do not implement later-phase features.
- Do not modify unrelated parts of the project.

Implement only Phase 1.

After implementation:

1. Build the project.
2. Run all available tests.
3. If the phase affects user-facing browser workflows, run or update the relevant Playwright E2E tests.
4. Fix errors caused by your implementation.
4. Verify that Phase 1 actually meets its completion criteria.
5. Update `doc/STATUS.md` with the actual progress.
6. Update `doc/DECISIONS.md` only if a meaningful technical or architectural decision was made.

Finally summarize:

- What was implemented.
- What was tested.
- Files/modules affected.
- Any remaining issues.
```

---

# 5. Verify Phase 1

```text
Perform a verification review of Phase 1.

Review the implementation against:

- `doc/PRD.md`
- ARCHITECTURE.md
- DESIGN.md
- CONVENTIONS.md
- STATUS.md
- Relevant DECISIONS.md entries

Check:

- Project structure.
- Architecture boundaries.
- Dependency direction.
- Domain/application/infrastructure separation.
- Database configuration.
- Authentication/authorization foundation.
- API structure.
- Frontend/backend boundaries.
- Configuration and environment handling.
- Error handling.
- Validation.
- Security.
- Build errors.
- Test failures.
- Dead code.
- Unnecessary dependencies.
- Violations of documented conventions.
- Differences between the implementation and approved documentation.
- Phase 1 completion criteria.

Do not add new features.

Fix only confirmed issues related to Phase 1.

After fixing:

1. Build the project again.
2. Run the available tests again.
3. If Phase 1 affects user-facing browser workflows, run the relevant Playwright E2E tests.
4. Verify Phase 1 is complete.
4. Update `doc/STATUS.md`.
5. Update `doc/DECISIONS.md` only if necessary.

Do not start Phase 2.

Finally, report:
- Issues found.
- Issues fixed.
- Tests performed.
- Remaining issues.
- Whether Phase 1 is ready to proceed.
```

---

# 6. Implement Phase 2 and Every Later Phase

For Phase 2 onward, reuse this exact prompt.

```text
Implement the next incomplete phase from STATUS.md.

Before coding:

1. Read PRD.md.
2. Read `doc/ARCHITECTURE.md`.
3. Read `doc/DESIGN.md`.
4. Read `doc/CONVENTIONS.md`.
5. Read `doc/STATUS.md`.
6. Read relevant DECISIONS.md entries.
7. Read relevant FEEDBACK.md entries.
8. Inspect the existing implementation.
9. Use the configured Codebase MCP server to inspect relevant code and relationships when available.

Determine exactly what the current phase requires and what is already implemented.

Implementation rules:

- Follow the approved architecture.
- Follow CONVENTIONS.md.
- Follow the requirements in PRD.md.
- Follow relevant decisions in DECISIONS.md.
- Respect the design in DESIGN.md.
- Consider relevant feedback in FEEDBACK.md.
- Preserve existing working functionality.
- Do not unnecessarily rewrite existing code.
- Do not introduce new technologies unless absolutely necessary and justified.
- Do not work ahead on later phases.
- Do not modify unrelated code.

Implement only the current phase.

After implementation:

1. Build the project.
2. Run available tests.
3. If the phase affects user-facing browser workflows, run or update the relevant Playwright E2E tests.
4. Fix errors caused by your changes.
4. Verify the phase completion criteria.
5. Update `doc/STATUS.md`.
6. Update `doc/DECISIONS.md` if a meaningful decision was made.

Finally summarize:

- What was implemented.
- What was tested.
- Files/modules affected.
- Remaining issues.
```

Then run Step 7.

---

# 7. Verify Every Phase

Use this after every implementation phase.

```text
Verify the current phase against:

- `doc/PRD.md`
- ARCHITECTURE.md
- DESIGN.md
- CONVENTIONS.md
- STATUS.md
- DECISIONS.md
- FEEDBACK.md

Check:

- Functional correctness.
- Business rules.
- Architecture.
- Dependency direction.
- Database changes.
- API behavior.
- Frontend/backend integration.
- Validation.
- Error handling.
- Security.
- Edge cases.
- Build errors.
- Test failures.
- Regression risks.
- Code quality.
- Unnecessary complexity.
- Unnecessary dependencies.
- Documentation consistency.
- Phase completion criteria.

Do not add new features.

Fix only issues related to the current phase.

After fixing:

1. Build again.
2. Run tests again.
3. If the current phase affects user-facing browser workflows, run the relevant Playwright E2E tests.
4. Confirm the current phase is complete.
4. Update `doc/STATUS.md`.
5. Update `doc/DECISIONS.md` if required.

Do not start the next phase.

Report:
- Problems found.
- Problems fixed.
- Tests performed.
- Remaining issues.
- Current phase status.
```

Then proceed to the next incomplete phase:

```text
Implement the next incomplete phase from STATUS.md.
```

Repeat:

**Implement → Verify → Update STATUS → Next Phase**

---

# 8. Handle New Client, Supervisor, Tester, or User Feedback

When new feedback arrives during development, do not immediately implement it.

Use:

```text
New project feedback has been received.

Review the feedback below:

[PASTE FEEDBACK]

Do not implement it immediately.

First:

1. Compare it with PRD.md.
2. Check whether it conflicts with existing requirements.
3. Check ARCHITECTURE.md.
4. Check DESIGN.md.
5. Check STATUS.md.
6. Check DECISIONS.md.
7. Determine which phase is affected.
8. Determine whether it is a new requirement, clarification, change, or bug.
9. Identify any architectural or database impact.

Update `doc/FEEDBACK.md` with the feedback and analysis.

If the feedback changes an approved requirement, explain exactly what documentation must change.

Do not implement anything yet.

Wait for my approval.
```

After approving the feedback:

```text
The feedback change is approved.

Update the necessary documentation first.

Then update the affected implementation phase in STATUS.md.

Do not implement the feature yet.

Show me what documentation changed and why.
```

Then implement the change through the normal:

**Implement → Verify**

cycle.

---

# 9. Final Project Review

When all planned phases are completed:

```text
All planned implementation phases are complete.

Perform a complete final review of the entire project.

Read:

- PRD.md
- ARCHITECTURE.md
- DESIGN.md
- STATUS.md
- DECISIONS.md
- FEEDBACK.md
- CONVENTIONS.md

Review the entire codebase against the documentation.

Check:

### Requirements
- Missing requirements.
- Incorrect functionality.
- Incomplete workflows.
- Business rule violations.
- Edge cases.

### Architecture
- Layer violations.
- Incorrect dependencies.
- Poor separation of concerns.
- Unnecessary coupling.
- Architecture drift.

### Backend
- API consistency.
- Business logic.
- Validation.
- Error handling.
- Authentication/authorization.
- Security.
- Database usage.
- Performance problems.

### Frontend
- User flows.
- API integration.
- Validation.
- Loading states.
- Error states.
- Responsive behavior.
- Inconsistent UI behavior.

### Database
- Relationships.
- Constraints.
- Indexes where appropriate.
- Data integrity.
- Migration consistency.

### Code quality
- Duplication.
- Dead code.
- Unnecessary dependencies.
- Inconsistent patterns.
- Poor naming.
- Unnecessary complexity.

### Testing
- Build errors.
- Test failures.
- Missing important tests.
- Integration problems.

Do not add new features.

Fix confirmed issues that are within the approved project scope.

Do not make large architectural changes without explaining them first.

After fixing:

1. Build the entire project.
2. Run all available tests.
3. Run relevant Playwright E2E tests for user-facing workflows.
4. Verify frontend and backend integration.
4. Update `doc/STATUS.md`.
5. Update `doc/DECISIONS.md` if necessary.

Finally provide:

1. Final implementation summary.
2. Requirements coverage.
3. Tests performed.
4. Issues fixed.
5. Remaining known issues.
6. Things that require manual testing.
7. Any technical debt that should be addressed later.
```

---

# 10. Generate the Final Manual Testing Checklist

After the final code review:

```text
Based on `doc/PRD.md`, `doc/DESIGN.md`, and the implemented application, create a manual testing checklist.

Organize it by:

- Authentication
- User roles/permissions
- Core workflows
- CRUD operations
- Validation
- Error handling
- Edge cases
- Frontend UX
- Responsive behavior
- API integration
- Database behavior
- Security
- Any project-specific requirements

For each test provide:

- Test ID
- Scenario
- Steps
- Expected result
- Priority

Do not modify the code.
```

Use this checklist for your own manual testing.

---

# Complete Workflow

```text
PRD.md + Tech Stack
        |
        v
Create 6 Documentation Files
        |
        v
Review Documentation
        |
        v
Approve Documentation
        |
        v
Implement Phase 1
        |
        v
Verify Phase 1
        |
        v
Implement Phase 2
        |
        v
Verify Phase 2
        |
        v
       ...
        |
        v
Implement Phase N
        |
        v
Verify Phase N
        |
        v
All Phases Complete
        |
        v
Final Code Review
        |
        v
Build + Tests
        |
        v
Manual Testing Checklist
        |
        v
     PROJECT DONE
```

---

# Core Development Loop

The most important part of this workflow is:

```text
Understand
    ↓
Plan
    ↓
Approve
    ↓
Implement
    ↓
Build
    ↓
Test
    ↓
Verify
    ↓
Update `doc/STATUS.md`
    ↓
Next Phase
```

Never skip the verification step for a major phase.

---

# Documentation Responsibilities

```text
PRD.md
    ↓
What should the system do?

ARCHITECTURE.md
    ↓
How should the system be structured?

DESIGN.md
    ↓
How should the system look and behave?

CONVENTIONS.md
    ↓
How should the code be written?

DECISIONS.md
    ↓
Why were important technical decisions made?

FEEDBACK.md
    ↓
What did users/stakeholders ask to change?

STATUS.md
    ↓
Where is the project now?
```

---

# Recommended Project Structure

```text
project-root/
│
├── doc/
│   ├── PRD.md
│   ├── ARCHITECTURE.md
│   ├── DESIGN.md
│   ├── STATUS.md
│   ├── DECISIONS.md
│   ├── FEEDBACK.md
│   └── CONVENTIONS.md
│
├── OPENCODE_PROJECT_WORKFLOW.md
│
├── backend/
│   └── ...
│
├── frontend/
│   └── ...
│
└── ...
```

---

# Final Rule

The coding agent should not rely only on conversation history.

The repository documentation should contain the important project knowledge.

The goal is to maintain a consistent project memory:

**PRD → Architecture → Design → Conventions → Decisions → Feedback → Status → Code**

This workflow can be reused for future projects by changing only the project's `doc/PRD.md`, technology stack, and repository-specific requirements.
