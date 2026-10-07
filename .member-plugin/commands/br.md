# Create Branch from Changes

Create a new git branch following the [Conventional Branch](https://conventional-branch.github.io/) specification.

## Arguments

- `$ARGUMENTS` - Task identifier (e.g., rs2-522, 312, PROJ-45)

## Instructions

1. Run `git diff --stat` and `git diff` to understand the current changes
2. Based on the changes, **determine the branch type**:
   - `feature` — new functionality, additions, enhancements
   - `bugfix` — fixing broken behavior, correcting errors
   - `hotfix` — urgent production fixes requiring immediate attention
   - `chore` — non-code tasks like documentation, dependencies, config
   - `release` — release preparation
3. Generate a short descriptive slug (2-4 words, lowercase kebab-case) summarizing what the changes do
4. Build the branch name as: `{type}/{identifier}-{slug}`
   - Use only lowercase letters, numbers, and hyphens in the slug
   - No consecutive hyphens, no leading/trailing hyphens
   - Examples: `feature/rs2-522-add-user-auth`, `bugfix/312-fix-null-response`, `hotfix/rs2-100-patch-payment-crash`
5. Create and checkout the new branch using `git checkout -b {branch-name}`
6. Report the created branch name
