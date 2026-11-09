# Reverb (self-hosted)

One app for music journalists and radio staff, with three optional programs you switch on at first login (and can change later in Settings):

| Program | What it does |
|---|---|
| **Reverb Press** | Bands, tour dates (month calendar plus list), PR agencies and contacts, press request tracker (photo passes, accreditation, review/interview requests, guestlist, follow-up reminders) |
| **Reverb Archive** | Gigs and festivals you've attended or plan to attend: setlists, support acts, rating and review, links, photos, spend |
| **Reverb Radio** | Song database and a playlist builder per show, with run-sheet printing and CSV / M3U export |

Artists are one shared record across all three. It runs as one small container with its own accounts and an SQLite database, so there is nothing to sign up for and no external database.

## Quick start (Portainer)

1. Create a **private** GitHub repository called `reverb` and upload every file in this folder (see "Uploading to GitHub" below). The included workflow builds the image automatically (`ghcr.io/jackb1990/reverb:latest`).
2. Wait for the green tick under the repo's **Actions** tab (about two minutes).
3. Make the package pullable: GitHub profile → **Packages** → `reverb` → **Package settings** → **Change visibility** → Public. (Or keep it private and add your GitHub login under Portainer → Registries.)
4. In Portainer: **Stacks → Add stack → Web editor**, paste the contents of `docker-compose.yml`, **Deploy the stack**.
5. Open `http://<your-truenas-ip>:8090`, choose **Create account**, then pick your programs.

## Uploading to GitHub (web uploader)

1. **+ → New repository** → name `reverb` → Private → Create.
2. **uploading an existing file**, then drag in everything inside this folder (select the contents, not the folder itself): `server.js`, `Dockerfile`, `docker-compose.yml`, `README.md`, the `public` folder and the `.github` folder.
3. If `.github/workflows/docker-publish.yml` didn't upload (hidden folders are sometimes skipped), use **Add file → Create new file**, type `.github/workflows/docker-publish.yml` as the name and paste the file's contents.
4. **Commit changes**.

## Settings

Set these under `environment:` in the compose file.

| Variable | Default | What it does |
|---|---|---|
| `ALLOW_SIGNUP` | `true` | Set to `false` to stop anyone creating new accounts |
| `COOKIE_SECURE` | `false` | Set to `true` only when you serve the app over HTTPS |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy so rate limiting sees real IPs |
| `SETLISTFM_API_KEY` | (empty) | Setlist.fm key for the "fill setlist" button (or paste it in Settings) |
| `BANDSINTOWN_APP_ID` | (empty) | Bandsintown app ID for "Find new tour dates" (or paste it in Settings) |
| `TZ` | (UTC) | Container time zone, e.g. `Europe/London` |

## Accounts

Each user has their own username, password and library. If someone forgets a password, open the container's console in Portainer (Containers → reverb → Console, shell `/bin/sh`) and run:

```sh
node server.js list-users
node server.js reset-password <username> <new-password>
node server.js delete-user <username>
```

## Importing from AccrediHub

Settings → Data → **Import AccrediHub data…** and choose your `accredihub-export.json`. Existing data is kept, artists with the same name are merged, and importing twice is safe. Keep the export file out of the GitHub repo.

## Your data

Everything lives in one SQLite file inside the `reverb-data` volume (`/data/reverb.db`). Updating or redeploying the stack does not touch it.

- **Update to a newer version:** upload the changed files to GitHub, wait for the build, then Portainer → Stacks → reverb → **Pull and redeploy** (tick *Re-pull image*).
- **Back up:** Settings → *Download backup (JSON)*, or stop the stack and copy the volume / snapshot it in TrueNAS.

## Running without Docker

Needs Node.js 22.13 or newer. There are no dependencies to install.

```sh
node server.js          # http://localhost:8080, data in ./data
```

## What's in the repo

| File | Purpose |
|---|---|
| `server.js` | Web server, accounts, per-user storage, Setlist.fm / Bandsintown lookups |
| `public/index.html` | The app |
| `public/login.html` | Sign-in / create account page |
| `Dockerfile` | Builds the image |
| `docker-compose.yml` | The file you paste into Portainer |
| `.github/workflows/docker-publish.yml` | Builds and publishes the image on every push |
