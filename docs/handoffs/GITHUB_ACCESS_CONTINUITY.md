# GitHub Access Continuity

**Document type:** Non-sensitive credential guidance
**Purpose:** Explain how to authenticate to GitHub for push operations WITHOUT exposing any secrets.
**Date:** 2026-10-17

---

## 1. Target Repository

- **Repository:** `mayakilzy/The-Balance`
- **Primary branch:** `main`
- **Remote URL:** `https://github.com/mayakilzy/The-Balance.git`
- **Push targets:** `main` branch (and feature branches if needed)

---

## 2. Approved Authentication Method

### Method: Personal Access Token (PAT) via HTTPS

The repository uses HTTPS with a Personal Access Token for authentication. The PAT is **NOT stored in the repository, in documentation, or in any committed file**.

### Where the PAT Lives
- The PAT is stored in a **local credential file** at a path known to the development environment.
- The path is **NOT documented in any committed file** to prevent indirect discovery.
- The PAT file has restrictive permissions (`0600`) and is **gitignored**.

### How to Push (Without Exposing the Token)
```bash
# Option A: Use the credential file (preferred — token never appears in command history)
PAT=$(cat <path-to-credential-file>)
git push "https://x-access-token:${PAT}@github.com/mayakilzy/The-Balance.git" main

# Option B: Configure git credential helper (more secure — avoids shell variable)
git config --global credential.helper store
# Then push normally — git will prompt for credentials the first time
git push origin main
```

**IMPORTANT:** Option A may leave the PAT in shell history. Use `history -d` or a subshell to avoid this, or prefer Option B.

---

## 3. How to Verify Push is Available (Without Exposing the Token)

To check whether the current environment can push to GitHub **without** revealing the token:

```bash
# Test 1: Check if credential file exists (do NOT print its contents)
test -f <path-to-credential-file> && echo "Credential file exists" || echo "Credential file MISSING"

# Test 2: Check git remote configuration
git remote -v
# Should show: origin  https://github.com/mayakilzy/The-Balance.git

# Test 3: Dry-run push (does not actually push, tests auth)
# If this succeeds, push is available. If it fails with auth error, credentials are missing/expired.
git push --dry-run origin main 2>&1 | head -5
```

**Do NOT print the PAT value to verify it.** Use the dry-run push instead.

---

## 4. Steps to Re-authorize When Access is Lost

If the credential file is missing or the PAT has expired:

### Step 1: Check if the credential file exists
```bash
test -f <path-to-credential-file> && echo "EXISTS" || echo "MISSING"
```

### Step 2: If missing, the founder must provide a new PAT
- The founder generates a PAT at: `https://github.com/settings/tokens`
- Required scopes: `repo` (full control of private repositories), `workflow` (update GitHub Action workflows)
- The PAT is provided to the development environment via a secure channel (NOT committed to git)
- **Do NOT extract the PAT from old sources** (e.g., `GeneralGH.zip`) — request a fresh PAT from the founder

### Step 3: Store the PAT securely
```bash
mkdir -p <credential-directory>
chmod 700 <credential-directory>
# Store the PAT (provided by founder) in the credential file
echo "<PAT_VALUE>" > <path-to-credential-file>
chmod 0600 <path-to-credential-file>
```

### Step 4: Verify push works
```bash
git push --dry-run origin main
```

### Step 5: After the session, delete the PAT file
```bash
rm -f <path-to-credential-file>
```

---

## 5. Secret Leakage Prevention Rules

These rules are **binding**. Violating them is a critical security incident.

1. **Never** put the PAT, API key, or password in any committed file (`.md`, `.txt`, `.env`, source code, config).
2. **Never** print the PAT value in terminal output, test results, or reports.
3. **Never** create a copy of the PAT inside the git repository, even if the repo is private.
4. **Never** put the PAT directly in a Git remote URL that might be saved in terminal history:
   ```bash
   # FORBIDDEN — never embed credentials in URLs:
   git remote set-url origin https://x-access-token:<TOKEN>@github.com/...
   ```
5. **Use** Git Credential Manager or a secret storage tool if available in the environment.
6. **If credentials already exist** in a secure local store, verify they can be used without extracting or displaying the value.
7. **Never** create additional files containing an exposed copy of the token.
8. **Never** transfer the credential file as part of a handoff package or chat attachment.
9. **If the new session does not share the credential store** with the current session, clearly state that reconnecting to GitHub may require new authorization from the owner.
10. **Never** extract the token from `GeneralGH.zip` or any old source, and do not re-store it in a new format just to prepare the handoff. Use the existing authorization if safe; otherwise request reconnection.

---

## 6. Handling Authentication Errors

### Error: `fatal: could not read Username for 'https://github.com'`
**Cause:** No credential file or PAT not provided.
**Fix:** Follow Step 1-3 in §4 above.

### Error: `remote: Invalid username or token`
**Cause:** PAT expired or revoked.
**Fix:** Founder must generate a new PAT (Step 2 in §4).

### Error: `remote: error: GH013: Repository rule violations found` (Push Protection)
**Cause:** GitHub Push Protection detected a secret in the commit (e.g., a fake Stripe key pattern in test data).
**Fix:**
1. Read the error output — it identifies which file and line contains the detected secret.
2. Replace the realistic-looking secret value with a clearly fake pattern (e.g., `FAKE_TEST_KEY_NOT_REAL_12345`).
3. Amend the commit: `git commit --amend --no-edit`
4. Push again.

### Error: `! [remote rejected] main -> main (pre-receive hook declined)`
**Cause:** Branch protection rules or required status checks failing.
**Fix:** Check repository settings → Branches → Branch protection rules. Ensure CI passes before pushing to `main`.

---

## 7. Session Continuity Notes

### Current Session State
- The PAT may or may not persist between development sessions.
- If a credential file exists in the environment's secure credential store (path known to the environment, not documented in committed files), the PAT is available.
- If no credential file exists, the PAT must be re-provisioned by the founder.

### New Chat First Steps for GitHub Access
1. Check if the credential file exists (without printing its value).
2. If it exists, verify push with `git push --dry-run`.
3. If it does not exist, inform the founder that GitHub re-authorization is needed.
4. **Do NOT** attempt to extract the PAT from old sources or commit it to the repository.

### Honest Disclosure
**If the new session cannot share the credential store with the current session, the new session must explicitly state:**
> "GitHub push access is not available in this session. The founder must provide a new PAT via a secure channel before code can be pushed."

---

## 8. What NOT to Do

- ❌ Do NOT commit `.env` files with real secrets
- ❌ Do NOT put the PAT in `README.md`, `RUNBOOK.md`, or any documentation
- ❌ Do NOT put the PAT in shell scripts that are committed to git
- ❌ Do NOT use `echo $PAT` in any command that might be logged
- ❌ Do NOT store the PAT in a file path that is documented in a committed file
- ❌ Do NOT transfer the PAT via chat attachments or handoff packages
- ❌ Do NOT use the PAT in CI workflow files (use GitHub Secrets instead)

---

## 9. CI Authentication (Separate from Local Push)

GitHub Actions workflows authenticate using the automatically-provided `GITHUB_TOKEN` — NOT a PAT. No configuration needed for CI.

For local development, the PAT is only needed for `git push`. Cloning, pulling, and reading public repositories does NOT require a PAT.

---

*This document contains no secrets. It describes the process of authentication without exposing credentials. If you find a secret in this document, it is a critical error — report it immediately.*
