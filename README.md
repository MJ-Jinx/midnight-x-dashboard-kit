# Midnight on X: KPI dashboard kit

Your own self-updating KPI dashboard for Midnight-related posts on X, hosted free on GitHub Pages.

- **Every day it reads your posts** from the X API, picks out the Midnight-related ones and updates the page by itself.
- **KPIs against your targets:** Midnight posts, impressions, engagement rate, followers, share of voice and mentions, plus an optional focus area (a region or topic) with its own share of your posts.
- **Trends, top posts, posting days, content mix and series**, with a searchable list of all your posts.
- **Builders:** showcase people you have helped get started, with their links and a picture of their website.
- **Events held:** record your meetups, workshops and talks. The dashboard adds up attendance, turnout, newcomers and cities.
- **Articles and code:** connect your GitHub, dev.to, Medium and Substack names, and your Midnight articles, pull requests and projects show up next to your X numbers.
- **Plan and report:** quarterly targets, a content calendar and a summary you can copy into a report.
- **Private by default:** visitors get a view-only page. Your targets, link clicks, X API spend and event costs stay in a private repository that only you can open.

Setup takes about 30 minutes, all in your browser. You don't need to install anything.

![The dashboard](share.jpg)

---

## What you need

| | |
|---|---|
| A **GitHub account** | Free. [Sign up](https://github.com/signup) if you don't have one. |
| Your **X account** | The account whose posts you want to track. |
| An **X developer account with credit** | The X API is pay-per-use, with no free tier. A few dollars covers setup and the first month (see [Costs](#costs)). |

---

## How it works

You make two repositories on GitHub:

| | Who can see it | What's in it |
|---|---|---|
| Your **private copy**, for example `midnight-dashboard-private` | Only you | Everything: the daily job, your settings and targets, all the numbers, and your event costs and notes. |
| Your **public site**, for example `midnight-dashboard` | Anyone | Only the page and the numbers visitors may see. Your private copy updates it by itself. |

Visitors open the site and get a view-only page. On your own browser, **Owner sign-in** shows everything and lets you add builders and events.

Free GitHub accounts can only publish public repositories as websites. That's why the site lives in a repository of its own.

---

## Set up in 7 steps

### 1. Make your private copy

1. At the top of this page, click **Use this template** → **Create a new repository**.
2. **Owner:** you. **Repository name:** anything, for example `midnight-dashboard-private`.
3. Choose **Private**.
4. Click **Create repository**.

### 2. Make your public site

1. At the top right of GitHub, click **+** → **New repository**.
2. **Repository name:** the name you want in your dashboard's address, for example `midnight-dashboard`. Your dashboard will be at **`https://<your-github-name>.github.io/midnight-dashboard/`**.
3. Choose **Public**, and tick **Add a README file**. Pages needs at least one file to start.
4. Click **Create repository**.
5. In this new repository: **Settings** → **Pages**. Under *Build and deployment*, **Source:** *Deploy from a branch*. **Branch:** `main`, folder `/ (root)`. Click **Save**.

You won't edit this repository yourself. Your private copy fills it in and replaces the README.

### 3. Get your X API keys

Sign in to the [X Developer Console](https://console.x.com) **with the X account you want to track**. This matters: X charges the low "own posts" rate only when the app's owner reads their own posts.

1. **Billing:** buy a small amount of credit (for example $5) and **set a monthly spending limit** (for example $10).
2. **Create a Project, then an App inside it.** An app that isn't inside a Project gets error 403.
3. App permissions: **Read** is enough.
4. In the app's **Keys and tokens**:
   - copy the **API Key** and **API Key Secret**;
   - generate an **Access Token** and **Access Token Secret** for your account and copy them.

You now have four keys. Keep them private: don't paste them into any file, chat or post.

### 4. Add the four keys to your private copy

In your **private copy**: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. Do this four times. Type the name exactly as shown in **Name**, and paste the key in **Secret**:

| Name | Secret |
|---|---|
| `X_API_KEY` | API Key |
| `X_API_SECRET` | API Key Secret |
| `X_ACCESS_TOKEN` | Access Token |
| `X_ACCESS_TOKEN_SECRET` | Access Token Secret |

GitHub stores the keys encrypted, and only your private copy's workflows can use them.

### 5. Let your private copy update the site

Your private copy needs a GitHub key that can update your public site.

1. Open [this link to make a GitHub key](https://github.com/settings/personal-access-tokens/new?name=Dashboard+publishing&description=Lets+my+private+dashboard+copy+update+its+public+site.&expires_in=366&contents=write). Its name, expiry and permission are filled in for you.
2. Under **Repository access**, choose **Only select repositories** and pick your **public site** from step 2. Not the private copy.
3. Check that **Permissions** shows **Contents: Read and write**.
4. Click **Generate token** and copy the key. It starts with `github_pat_`.
5. In your **private copy**: **Settings** → **Secrets and variables** → **Actions** → **New repository secret**. **Name:** `PUBLISH_TOKEN`. **Secret:** paste the key. Click **Add secret**.

The key can only change your public site, and it lasts a year. When it expires, the site stops updating and GitHub shows what to do (see [Troubleshooting](#troubleshooting)).

### 6. Run the setup

1. In your **private copy**, open the **Actions** tab. If GitHub asks, click **I understand my workflows, go ahead and enable them**.
2. Click **Set up the dashboard** in the list on the left, then **Run workflow** (on the right).
3. Fill in the form:

   | Field | What to put |
   |---|---|
   | **Public site repository** | The name of your public site from step 2, for example `midnight-dashboard`. |
   | **Your role** | Shown under the title, for example `Nightforce Leader`. |
   | **Focus area** *(optional)* | A region or topic you want to track, for example `Nigeria`, `Lagos`, `DeFi` or `Education`. Leave it empty to skip. |
   | **Focus words** *(optional)* | Words that mark a post as being about your focus area, comma-separated: cities, hashtags, a flag emoji. The focus area's own name and hashtag are always included. |
   | **Time zone** | Yours, for example `Africa/Lagos`, `Europe/London` or `Asia/Singapore` ([full list](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones)). |
   | **First fetch** | `backfill` reads your whole reachable timeline (about $3, once). `daily` reads the last 7 days only. |

4. Click **Run workflow**.

The setup takes about a minute. It checks your public site and the key from step 5, publishes the page, and starts the first fetch from X. The fetch takes 1 to 5 minutes. Then open your dashboard's address: the demo banner is gone and your own numbers are there.

If something isn't right, for example a misspelt site name or a key that can't update the site, the run ends with a red ✗ and says what to fix. Fix it and run the setup again.

### 7. Sign in as the owner

Open your dashboard and click **Owner sign-in** at the bottom of the page. Follow the three steps in the box. It takes about 2 minutes and makes a second GitHub key, this time for your **private copy**. The key is kept only in your browser.

Once you're signed in, you see your targets, link clicks, X API spend and event costs, and the **Add a builder**, **Add an event** and **Connected accounts** buttons.

Why two keys? The publishing key from step 5 lives in GitHub and can only update the site. The owner key lives in your browser and can only open your private copy.

**That's it.** From now on the dashboard refreshes itself every day at 04:15 UTC, and the site follows a minute later.

---

## After setup

**Refresh button.** The **Refresh** button at the top of the page reloads the latest saved numbers. Signed in, its *Fetch new data from X* link starts a fetch on GitHub right away (click **Run workflow** twice). The page notices the new data by itself.

**Targets and calendar** live in `plan.json` in your private copy. Signed in, the page footer has an **Edit plan.json** link that opens it in GitHub's editor.
- `null` means no target.
- Rates are fractions: `0.03` means 3%.
- `eventsHeld` and `eventAttendees` are the event targets: the number of events and the number of people at them.
- `articles` and `pullRequests` are the targets for Articles and code.
- Add a quarter by copying one, for example `"2027-Q1": { "label": "Q1 2027", "targets": { … } }`.
- `focus` is a list of short lines shown in the report.
- `calendar` entries look like `{ "date": "2027-01-15", "title": "…", "type": "post", "pillar": 2, "status": "idea" }`.

**Builders.** Click **Add a builder** in the Builders section. Each builder is added with one click, and a picture of their website appears on their card a minute or two later.

**Events.** Click **Add an event** in the Events held section.
- **On the public page:** the name, date, type (meetup, workshop, hackathon, talk, X Space…), format (in person, online or hybrid), venue or platform, city and country; how many registered, attended, were new to Midnight and were developers; a line on what happened; and a link (event page, recap post or photos).
- **Only you see:** the cost, a feedback score out of 5, co-hosts or partners, and notes.
- Leave out any number you don't know. To add the attendance after the event, click the event, then **Edit**.

The section adds up events held, people at events, turnout (attended ÷ registered), the share new to Midnight, developers and cities. For you it also shows cost per attendee and the average feedback score. Events also appear in **Plan & report** and in the copied summary, without costs, scores or notes.

**Articles and code.** Click **Connected accounts** in the Articles and code section and type your name on each site you use. No passwords: the dashboard reads only what is public, keeps what is about Midnight (the same keyword lists as your X posts), and checks again every day at 04:30 UTC. Your first results appear a minute or two after you save.

| Site | What shows up |
|---|---|
| **GitHub** | Your pull requests and issues in Midnight repositories (`midnightntwrk` and `LFDT-Minokawa`, set under `githubOrgs` in `sources.json`), and your own public repositories about Midnight, with their stars. Private repositories are never listed. |
| **dev.to** | All your articles about Midnight, with reactions and comments. |
| **Medium** | Your latest posts about Midnight. Medium's public feed lists only your last 10 posts, so the history starts on the day you connect. Medium shares no claps or views. |
| **Substack** | Your latest posts about Midnight, from your publication's name (`name`, `name.substack.com` or your own domain). The feed lists your last 20 posts, and Substack shares no likes or opens. |

- **dev.to page views (optional):** on dev.to, open **Settings** → **Extensions** and generate a key under *DEV Community API Keys* at the bottom. Save it in your private copy as a secret named `DEVTO_API_KEY` (as in step 4). Page views then show to you only.
- **Something that isn't about Midnight showed up?** Signed in, a weak match is marked **Needs review**. To leave an item out, add its ID (hover over the mark to see it) to `midnight.overrides.exclude` in `config.json`.
- **Targets:** `articles` and `pullRequests` in `plan.json`.

**On another browser or device,** use **Owner sign-in** again. **Sign out** at the bottom of the page removes the key from that browser.

**What counts as Midnight-related.** This is decided by the keyword lists in `config.json` (under `midnight`).
- After editing them, go to **Actions** → **Refresh X data** → **Run workflow**, and choose mode **reclassify**. It's free and re-tags every stored post.
- Posts that only match weak signals (a bare "midnight") are kept but marked **Needs review**.
- To force a post in or out, add its ID to `midnight.overrides.include` or `exclude`.

**Content series.** If you post a recurring series, add it to `series` in `config.json`, then run **reclassify**:

```json
"series": [
  { "id": "daily-fact", "label": "Daily Fact", "phrases": ["daily fact #"] }
]
```

The Series section then compares the series with your other posts.

**Change your focus area, role or time zone.** Run **Set up the dashboard** again with new answers, and fill in **Public site repository** again. Your data, targets, builders and events are kept.

**Older history (optional).** The X API reaches only your ~3,200 most recent posts. To go further back you need [Node.js](https://nodejs.org) on your computer and a copy of your private repository on it.
1. Request your archive on x.com: *Settings* → *Your account* → *Download an archive of your data*. Unzip it **outside** the repository folder.
2. Run `node scripts/import-archive.mjs "<path to the archive>/data"` in the repository folder, then commit and push the `data` folder.
3. Run **Refresh X data** with mode **verify-archive**. It checks each older Midnight post is still on X, keeps it with its current numbers, and drops it if you deleted it. This costs $0.005 per post still on X.

---

## Costs

From the [X API pricing page](https://docs.x.com/x-api/getting-started/pricing) (November 2026):

| Read | Price |
|---|---|
| Your own posts and mentions | $0.001 per post |
| Your profile (follower count) | $0.01 per call |
| The same post again within one UTC day | free |

| Job | Typical cost |
|---|---|
| First backfill (your ~3,200 most recent posts) | about $3, once |
| Daily refresh (last 7 days; last 29 days on Sundays) plus mentions | about $0.10 to $0.20 a day for an active account, roughly $2 to $6 a month |
| Older-archive check (optional) | $0.005 per older Midnight post still on X |

Each run records what it cost, and the page footer shows you this month's estimated total.

GitHub is free for this. Private repositories get 2,000 free Actions minutes a month, and the dashboard uses about 100 to 150 of them (GitHub counts each run as at least one minute). Reading GitHub, dev.to, Medium and Substack costs nothing. Pages is free for the public site.

---

## Privacy and safety

**On your public site** (anyone can see and download these):
- the page itself, `config.json` (keyword lists, your role, focus area and repository names) and `builders.json`;
- the full text and public numbers (impressions, likes, replies, reposts, quotes, bookmarks) of your Midnight-related posts. Other posts are reduced to their ID, date and type, which are used for share of voice;
- daily follower counts and daily mention counts. Nobody else's posts are republished;
- your events, without their cost, feedback score, partners and notes;
- your connected account names, and the Midnight articles, pull requests, issues and repositories found on them (titles, links, a short summary, and public numbers such as reactions and stars).

**Only in your private copy:**
- `plan.json` (targets, focus notes, content calendar);
- link clicks and profile clicks;
- X API spend and run details;
- event costs, feedback scores, partners and notes;
- dev.to page views, and notes on sites that didn't answer;
- the scripts and workflows.

These files are never copied to the site, so visitors can't see or download them.

Also keep in mind:
- **Keep partner names, contacts and anything confidential** out of `config.json`, `builders.json` and the public event fields. Put them in an event's *Co-hosts or partners* and *Notes* instead.
- **Posts you delete on X** drop out of the data on the next refresh that covers their date: 7 days back daily, 29 days back on Sundays. Older versions of the files still hold them in each repository's history.
- **Your keys:** the X keys, the publishing key and the optional dev.to key live only in your private copy's encrypted secrets. Your owner key lives only in your browser. None of them is ever written into a file.
- **Collaborators:** anyone you add to your private copy can see everything in it.
- **Builders:** only list people who are happy to be shown publicly.

---

## Simpler setup: one public repository

If you'd rather have a single repository:
- in step 1, choose **Public**;
- skip steps 2 and 5;
- turn on Pages in that repository: **Settings** → **Pages** → `main`, `/ (root)`;
- leave **Public site repository** empty in step 6.

Everything works the same, with one difference: all its files are public. The page still hides your targets, link clicks, spend and event costs from visitors, but anyone can open those files in the repository.

**To go private later:**
1. Rename the repository, for example by adding `-private`, and make it **Private** (**Settings** → **General**).
2. Do step 2 using the **old name**, so your address stays the same.
3. Do step 5, then run the setup again with **Public site repository** filled in.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| The page shows **404** | Pages isn't on in your **public site** (step 2), or the first publish hasn't finished. Wait 2 minutes and reload. |
| The page shows only a README | The first publish hasn't run yet. In your private copy, open **Actions** → **Publish the public site** and read the latest run. |
| The page still says **Demo data** | The first fetch hasn't finished or didn't run. Open **Actions** → **Refresh X data** and read the latest run. If none ran, run it with mode **backfill**. |
| Setup says **"This copy is private, so the site needs its own public repository"** | Do step 2, then fill in **Public site repository** when you run the setup. |
| Setup says **"Can't find a public repository called …"** | Check the spelling, and that the site repository is **Public**. |
| A run says **"The PUBLISH_TOKEN secret isn't set"** | Do step 5. |
| A run says **"GitHub doesn't accept PUBLISH_TOKEN"** | The key has expired, was deleted, or wasn't copied whole. Make a new one (step 5). Then in your private copy: **Settings** → **Secrets and variables** → **Actions** → `PUBLISH_TOKEN` → **Update**. |
| A run says **"PUBLISH_TOKEN can't update …"** | The key must have **Only select repositories** → your **public site**, and **Contents: Read and write**. Make a new one (step 5) and update the secret. |
| A run says **"X API secrets are not set yet"** | Check all four secret names in step 4. They must match exactly. |
| A run says **"This copy isn't set up yet"** | Run **Set up the dashboard** first (step 6). |
| X error **401** | The four keys aren't from the same app, or the access token is older than a permission change. Regenerate the Access Token and Secret, then update both secrets. |
| X error **402** | Out of credit, or the spending limit was reached. Top up in the X console. |
| X error **403** | The app isn't inside a Project, or lacks Read permission. |
| **"Permission denied to github-actions[bot]"** | In your private copy: **Settings** → **Actions** → **General** → *Workflow permissions* → **Read and write permissions** → **Save**. Then run it again. |
| The banner says the data is **days old** | Open **Actions** in your private copy and read the failed run. GitHub pauses scheduled jobs in repositories with no activity for 60 days, but the daily data commits count as activity. |
| **Owner sign-in** says the key can't change the repository | Make a new key with **Only select repositories** → your **private copy**, and **Contents: Read and write**. |
| No **Add a builder**, **Add an event** or **Plan & report** | You're seeing the visitors' view. Use **Owner sign-in** at the bottom of the page. |
| Articles and code says a site **didn't answer** | The site was busy or blocked the daily check, so the last numbers were kept. It tries again the next day. If it keeps happening, open **Actions** → **Refresh articles and code** in your private copy and read the run. |
| An article or pull request is missing | Only items about Midnight are kept: check that its title, tags or text mention Midnight (or a Midnight term like Compact). Medium and Substack only show posts from after you connected. GitHub counts pull requests only in the organisations under `githubOrgs` in `sources.json`. |
| A new builder or event isn't on the public site yet | The site updates a minute or two after each change. Reload then. If it still isn't there, check **Actions** → **Publish the public site** in your private copy. |

---

## Getting updates

Your copy doesn't change when this kit improves. To pick up a new version (about 5 minutes, all in the browser):

1. On this kit's page, click **Code** → **Download ZIP**, and unzip it.
2. In your **private copy**, click **Add file** → **Upload files**. From the unzipped folder, drag in `index.html` and the folders `assets`, `scripts` and `.github`.
   - Upload nothing else. Your `config.json`, `plan.json`, `builders.json`, `events.json`, `sources.json` and `data` folder hold your own settings and numbers, and the kit's versions are empty.
   - On a Mac, press **Cmd + Shift + .** in Finder to see the `.github` folder.
3. Click **Commit changes**.
4. Run **Set up the dashboard** again with the same answers as before, and choose **First fetch:** `none` so nothing is charged. This puts your name, address and focus area back into the page. Your data, targets, builders and events are kept.

The public site updates itself a minute later. New sections start empty and fill in as you use them.

---

Community tool, not an official Midnight Network or Midnight Foundation publication. Midnight and the Midnight logo are trademarks of their owners.

Licensed under the MIT License (see [LICENSE](LICENSE)), except the Midnight logo and the few third-party files listed there.
