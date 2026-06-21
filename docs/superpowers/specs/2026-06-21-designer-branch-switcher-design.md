# Designer Branch Switcher Design

## Goal

Build a designer-facing project branch switcher above Chat. It should make branches feel like project workspaces with automatic cloud save, while keeping Git details in the background unless something needs attention.

## Mental Model

The switcher presents one unified branch tree for the current project. Local and remote Git refs are merged by branch name and displayed as one item. Local or remote state is shown as status metadata, not as the primary structure.

The project base branch is shown with its real repository name, such as `main` or `master`. New design work starts from that base branch.

## Switcher

The closed switcher shows:

```text
ProjectName: design/feature-name    [cloud state]
```

The project name comes from the workspace or repository display name. The branch path is the active branch. The cloud state appears on the right side of the control.

Cloud states:

- Synced: show a cloud icon.
- Syncing: show a spinner or animated cloud-sync state.
- Problem: show a warning cloud state.
- Local-only branch: highlight as needing cloud save.
- Remote-only branch: lower opacity, available to open.

## Dropdown Tree

The dropdown shows branches as a path tree:

```text
ProjectName
  master
  design
    landing-page
    checkout-flow
  experiment
```

Branches under slash-separated paths become nested tree rows. Synced branches look normal. Remote-only branches look available but less present. Local-only branches are visually highlighted because they need cloud save.

Selecting a remote-only branch creates/checks out the local tracking branch before switching.

## New Branch Flow

The dropdown includes a new branch button.

The creation UI defaults to a muted `design/` prefix plus an editable branch name input:

```text
design/ [landing-page]
```

The designer edits only the friendly branch name by default. The `design/` prefix can be removed with a small `x` on the prefix pill. When removed, an inline warning appears:

```text
This will create a top-level branch. Design branches are easier to find under design/.
```

The UI provides a small action to restore `design/`.

Creating a branch:

1. Cloud-save current work if needed.
2. Update the real default branch.
3. Create the new branch from the default branch.
4. Switch to the new branch.

Duplicating an existing branch is out of scope for the first implementation.

## Automatic Cloud Save

The system should feel automatic when everything is healthy.

Autosync runs quietly every few minutes when Git-visible changes exist. It stages tracked changes and untracked files that are not ignored by Git, creates an automatic checkpoint commit, and pushes it to the remote branch. Ignored files, dependency folders, caches, build output, secrets, and local configuration excluded by Git stay excluded.

Checkpoint commit messages are automatic and not shown to the designer.

Branch switching waits for cloud save:

1. If the current branch is already synced, switch immediately.
2. If sync is in progress, wait for it.
3. If changes are unsynced, start sync and wait.
4. Switch only after the push succeeds.

## Sync Failure Recovery

When cloud save cannot complete, show a solution-oriented recovery surface. Avoid Git terminology as the primary language.

Recovery actions:

- Retry safely: pull/rebase remote changes and retry push.
- Ask agent to fix: copy or send a prompt containing branch name, repo path, command output, changed files, and failure state.
- Save locally and switch anyway: leave the previous branch marked local-only or needs cloud save.
- Advanced override: hidden behind an Advanced affordance with warning text because it can replace remote history.

If retry safely fails, keep the recovery surface open and update it with the new failure details. The Ask agent option remains available.

## Error Handling

The switcher should handle:

- No Git repository.
- No remote configured.
- Default branch cannot be detected.
- Dirty working tree with ignored files.
- Commit failure.
- Push failure.
- Remote has new commits.
- Rebase or retry failure.
- Network timeout.
- Branch already exists.
- Branch checked out in another worktree.

Failures should not silently disappear. The control should show a problem state and the recovery surface should explain the next available actions in plain language.

## Implementation Direction

Start with the visible switcher and branch tree. Reuse VS Code workbench UI primitives where possible. Keep Git operations behind a small service boundary so autosync, branch listing, branch creation, and branch switching can be tested separately.

Use the current placeholder location above Chat as the host. Replace the placeholder text with a real button-like switcher. The dropdown should be scoped to the Chat side panel and should not affect Explorer or other technical panes.

Use VS Code's existing Git extension behavior where practical. Avoid adding broad dependencies for icons in the first pass; if Lucide cloud icons are required visually, add a narrow local icon implementation instead of pulling in a full icon library.

## Testing

Add focused tests for:

- Merging local and remote refs into one tree.
- Status assignment for synced, remote-only, and local-only branches.
- New branch name construction with and without `design/`.
- Switch flow waits for successful sync.
- Failed sync opens recovery state.
- Retry failure preserves error details.

Manual verification should include launching Code OSS from source, opening Chat, checking the switcher position, opening the dropdown, and selecting/creating branches in a test repository.
