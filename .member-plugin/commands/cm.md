# Git Commit

Create a git commit with a message derived from the changes. Do NOT add Co-Authored-By lines.

## Concurrency (read first)

Several sessions may run `/cm` at the same time in the same checkout. The git index is
shared, so a plain `git add` in one session lands in another session's commit.

Two rules keep the sessions apart:

1. **Own an explicit path list.** Decide up front exactly which files THIS session is
   committing. Never commit "whatever is staged".
2. **Run every index/HEAD-touching git command through the queue**, which serializes
   sessions first-come-first-serve:

       ~/.claude/bin/git-queue <git command...>

   Read-only commands (`git status`, `git diff`, `git branch`) do not need the queue.

`--only` takes the WORKING TREE content of the named paths and disregards the index,
both for those paths and for every other path. That is what makes it safe: a peer's
staged work is left staged, and your own stale staging cannot ship instead of your
edits. Three cases it does not cover on its own:

- **A path list that includes a rename or a delete.** `git mv a b` stages the
  deletion of `a`. Committing `--only -- b` leaves `a` in HEAD and the staged
  deletion sitting in the index for a peer's next commit to sweep up. Name BOTH
  sides: `--only -- a b`.
- **A file that is partly yours and partly a peer's.** `--only` commits the file
  whole, so a peer's hunk in the same file rides along under your message. Shared
  files are the norm, not the exception (a routes file, a shared helper, a shared
  index). See "Partly-shared file" below.
- **Content, as opposed to paths.** `--only` reads the working tree at the moment
  the commit runs. If you moved a file and edited it afterwards, or edited it after
  a review step, the working tree is right and any earlier snapshot is not. Verify
  content after committing (step 10), not just paths.

### Partly-shared file

When `git diff -- <file>` shows hunks that are not yours, do not commit the file
whole and do not revert the peer's hunks. Commit your hunks through a private index,
which leaves both the peer's staged work and their working-tree edits untouched:

    git diff -- <file> > /tmp/mine.patch   # then delete every hunk that is not yours

    ~/.claude/bin/git-queue sh -c '
      export GIT_INDEX_FILE="$PWD/.git/cm-private-index"
      rm -f "$GIT_INDEX_FILE"
      git read-tree HEAD
      git apply --cached --recount /tmp/mine.patch
      git add -- <your other paths>
      git commit -m "{message}"
    '

    git restore --staged -- <file>   # index only; the working tree keeps every hunk

The `git restore --staged` at the end is housekeeping: the real index still holds the
pre-commit blob for that file, so `git status` shows it staged until you reset it to
the new HEAD. It touches no working-tree file, so it cannot disturb a peer.

Do NOT reach for `git restore --staged` to clear a peer's staged work out of your way.
With `--only` or a private index you never need to, and unstaging their work makes
their `git status` lie to them mid-task.

## Instructions

1. Run `git branch --show-current` to get the current branch name
2. Extract the ticket/issue number from the branch name and format it:
   - If the branch contains an `rs2-<number>` token anywhere (including behind a Conventional Branch `type/` prefix, e.g. `rs2-123-some-description`, `feature/rs2-123-...`, `bugfix/rs2-736-...`): format as `RS2-123` (uppercase, no brackets)
   - For other patterns, extract the number/id after the prefix and format with brackets:
     - `feature/123-...` -> `[#123]`
     - `bugfix/rwp-213-...` -> `[#RWP-213]` (uppercase the id)
     - `fix/abc-99-...` -> `[#ABC-99]`
   - If no number can be extracted, omit the prefix entirely
3. Build the path list for this commit:
   - Start from the files this session actually created or edited in this conversation.
   - Cross-check with `git status --porcelain` and `git diff --stat`.
   - If a changed file is not clearly this session's work, leave it out. Do not stage it,
     do not revert it, do not mention it in the message.
   - If a changed file is PARTLY this session's work, it does not belong on the plain
     path list: `--only` would commit a peer's hunks too. Route it through the
     "Partly-shared file" recipe above.
   - If the path list includes a file this session moved or deleted, put BOTH the old
     and the new path on the list.
   - After a resume or a compaction, "this conversation" may not be a reliable record.
     Compare file mtimes against this session's first tool call to decide ownership.
   - If the path list would be empty, ask the user which files to commit instead of
     falling back to everything.
4. Run `git diff -- <paths>` and `git diff --cached -- <paths>` to review exactly what
   those paths contain.
5. **RuboCop check (run before committing):**
   - Detect whether the project uses RuboCop: check for a `.rubocop.yml` (or `.rubocop_todo.yml`) at the project root, or a `rubocop` entry in the `Gemfile`.
   - If RuboCop is NOT configured, skip this step and proceed to the commit.
   - If RuboCop IS configured, run it on the `.rb` files in the path list only. Prefer the project's invocation convention (e.g. this repo runs tooling inside Docker: `docker compose exec app bundle exec rubocop <files>`; otherwise fall back to `bundle exec rubocop <files>`).
   - If RuboCop reports offenses, report them to the user and ask whether to fix them (e.g. with `-a`/`-A` auto-correct) before committing, or commit anyway. Do NOT auto-correct without confirmation. If RuboCop passes clean, continue.
6. Generate a concise commit message describing what the changes do
7. Format the final commit message as: `{ticket-prefix} {message}` (or just `{message}` if no ticket)
   - Example: `RS2-123 add user authentication`
   - Example: `[#456] fix login form validation`
   - Example: `update readme` (no ticket found)
8. Commit the path list, through the queue, in a single queue slot:

       # all paths already tracked:
       ~/.claude/bin/git-queue git commit --only -m "{message}" -- <paths>

       # any path is a NEW file: add and commit inside ONE slot, so a peer session
       # cannot commit in between and sweep up the newly staged file
       ~/.claude/bin/git-queue sh -c 'git add -- <new paths> && git commit --only -m "{message}" -- <paths>'

   `--only` commits the working-tree content of the named paths and ignores anything
   else another session has staged, leaving that staged work in place. Quote every path.
   `git commit --only` cannot name an untracked path, which is why new files need the
   `git add` first - never run that `git add` outside the queue.
9. Never run a bare `git add` (and never `git add -A` or `git add .`). Anything that
   writes the index or moves HEAD goes through `git-queue`.
10. Confirm the commit, at BOTH levels:
    - Paths: `git show --stat HEAD` contains only the intended paths. If it swept in a
      file that is not yours, tell the user - do not rewrite the commit.
    - Content: `git diff HEAD -- <paths>` must come back EMPTY. Anything it prints is
      work of yours that did not make it into the commit, which is what happens when a
      snapshot older than your last edit is what got committed. Right paths with wrong
      content passes the `--stat` check and fails this one.
11. Do NOT include Co-Authored-By lines
