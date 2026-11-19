# apple-release

Archive Expo apps, upload to App Store Connect, set TestFlight groups and release notes, push store metadata.
Everything per app comes from its `app.json` plus an `appstore/` folder. A new project is one line in `apps.txt`
(local) or one caller workflow (GitHub Actions).

## One-time setup
1. App Store Connect > Users and Access > Integrations > App Store Connect API > create a key with the **Admin** role
   (Admin lets Xcode manage signing certificates in the cloud, which is what CI uses). Download the `.p8` once.
2. On the Mac, create `~/.config/apple-release/env`:
   ```
   ASC_KEY_ID=XXXXXXXXXX
   ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
   ASC_KEY_PATH=/Users/ryancanfield/.config/apple-release/AuthKey_XXXXXXXXXX.p8
   ```
3. `asc.mjs init <app-dir>` creates `<app-dir>/appstore/`. With credentials it prefills metadata from App Store Connect.
   Fill in the TODO values. Fields that are empty or start with TODO are never pushed.

## Local
    apple-release.sh --all                      archive, upload, TestFlight, tag
    apple-release.sh <app-dir> --metadata       also push store metadata and attach the build
    apple-release.sh <app-dir> --no-asc         archive and upload only
    asc.mjs status <app-dir>                    builds, versions, groups
    asc.mjs metadata <app-dir> --dry-run        show what would change

## appstore/ folder (per app)
- `testflight.json`: groups. `internal` groups get every build automatically; external groups get each build added,
  are submitted for Beta App Review, and can have a public link. Testers are added by email (internal testers must
  already be App Store Connect users).
- `release-notes.txt`: the TestFlight "What to test" text. Delete its content to generate notes from the git commits
  touching the app since the last `apple-*` tag.
- `app.json`: category, copyright, App Review contact details.
- `metadata/<locale>.json`: name, subtitle, privacy URL, description, keywords, promo text, support and marketing URLs,
  what's new (not accepted on a first release).

## GitHub Actions
1. Create the repo `canfie1d/apple-release` with this folder's contents. If it is private, set it to allow access
   from your other repositories (Settings > Actions > General > Access) and add a `TOOL_REPO_TOKEN` secret.
2. In each app repo add secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (`base64 -i AuthKey_X.p8 | pbcopy`).
3. Copy `templates/apple-release.caller.yml` to `.github/workflows/apple-release.yml` and set `app-dir`.
   Already added to Financial Advisor and Personal Chef.
Runs: manual (Actions tab) or weekly (Mondays 08:00 Pacific, skipped when the app folder has no changes since the last tag).

## Not covered
Screenshots, age rating answers, and submitting the version for review.
