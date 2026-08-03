# OpenCode Go usage broadcaster

## What ships

This safe MVP ships fixture-backed quota evaluation, D1 deduplication, PushPlus
topic delivery, signed callbacks, 30-minute monitoring, and a 09:07 Beijing
summary. The default fixture source is deliberately visible in every generated
message with the `【测试数据】` prefix.

## What does not ship

This MVP does **not** ship browser automation, GitHub password storage, GitHub
OAuth refresh automation, OpenCode Cookie scraping, or calls to the unstable
SolidStart `/_server` protocol. The `opencode-console` source fails closed
before any network function is invoked.

## Prerequisites

You need Node.js 22 or newer, a Cloudflare account, Wrangler login, a PushPlus
account, and a public HTTPS Worker hostname for callbacks. PushPlus delivery is
through a PushPlus service account and a private topic; it is not a bot account
that speaks inside an ordinary personal WeChat group.

## Local install

```powershell
npm ci
Copy-Item .dev.vars.example .dev.vars
npm run check
```

The checked-in example values are unusable test values. Keep `.dev.vars` local
and do not commit real values.

## Release credential scan

Run both checks before release. A clean `rg` scan emits no output and exits 1;
the PowerShell guard below turns that expected no-match exit into success and
fails if a match or scan error occurs. The single file exclusion is intentional:
`docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md`
contains this implementation's literal scanner text and reviewed unusable
`do-not-use` samples. Do not replace it with a broad documentation exclusion.

```powershell
$credentialPattern = '(' + 'g' + 'hp_|github' + '_pat_|\bsk-[A-Za-z0-9]|Cookie' + ':|Set-Cookie' + ':)'
$scanOutput = & rg -n --hidden --glob "!node_modules/**" --glob "!.git/**" --glob "!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md" $credentialPattern .
if ($LASTEXITCODE -ne 1 -or $scanOutput) {
  $scanOutput
  throw "Credential scan expected no matches (rg exit 1)."
}
exit 0
```

```powershell
$scanOutput = & rg -n --hidden --glob "!node_modules/**" --glob "!.git/**" --glob "!.dev.vars.example" --glob "!docs/superpowers/plans/2026-08-03-opencode-go-usage-broadcaster-mvp.md" "(PUSHPLUS_TOKEN|PUSHPLUS_TOPIC|PUSHPLUS_CALLBACK_SECRET|OPENCODE_AUTH_COOKIE)[[:space:]]*=" .
if ($LASTEXITCODE -ne 1 -or $scanOutput) {
  $scanOutput
  throw "Credential assignment scan expected no matches (rg exit 1)."
}
exit 0
```

## Fixture demo

Warning: this manual trigger performs a real PushPlus request when real
PushPlus Secrets are present. First intentionally select the private test topic;
then start the Worker:

```powershell
npm run dev
```

Trigger a half-hour event from a second terminal:

```powershell
curl.exe --get --data-urlencode "cron=*/30 * * * *" --data-urlencode "format=json" "http://localhost:8787/cdn-cgi/handler/scheduled"
```

## D1 operator steps

Do not run these during implementation. Create and migrate the production D1
database only when you are ready to operate it:

```powershell
npx wrangler d1 create opencode-go-usage --binding DB --update-config
npx wrangler d1 migrations apply opencode-go-usage --remote
```

After creation, verify that `--update-config` replaced only the all-zero
`database_id` in `wrangler.jsonc`. If the installed Wrangler leaves it unchanged,
paste the returned ID into that field only.

## Secrets

Do not set real values during implementation. Set these interactively only in
the intended Cloudflare environment:

```powershell
npx wrangler secret put PUSHPLUS_TOKEN
npx wrangler secret put PUSHPLUS_TOPIC
npx wrangler secret put PUSHPLUS_CALLBACK_SECRET
npx wrangler secret put PUSHPLUS_CALLBACK_BASE_URL
```

Generate the callback secret locally:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Do not pass Secret values on the command line, add them to configuration, or
place them in source, fixtures, D1, logs, or version control.

## PushPlus private group

Create a private normal topic and copy its topic code into the Secret. Issue a
short-lived, limited QR code; let the 2–5 intended members subscribe; then
revoke the QR code and send one fixture test message. Do not publish the QR code.

## Deploy

Run `npm run deploy` only after the D1 ID, all Secrets, callback base URL, and a
fixture clearly marked as test data have been set. Do not enable real console
collection as part of this safe MVP.

## Credential rotation

Increment `OPENCODE_AUTH_GENERATION` only when authorized credentials are
deliberately replaced. In this safe MVP, that only releases the auth fault gate
for an injected/test source; it does not enable console access.

## Real collector follow-up

The real collector needs either a supported endpoint or written authorization,
plus a sanitized fixture. Track the [official OpenCode source](https://github.com/anomalyco/opencode),
[issue 16017](https://github.com/anomalyco/opencode/issues/16017), and the
unmerged [PR 16513](https://github.com/anomalyco/opencode/pull/16513) before
revisiting it.

## Message semantics

Threshold jumps are coalesced: if a window rises from 49% to 76%, 50% and 75%
are reserved but only the 75% notification is reported. Expiry is per event:
daily summaries expire at the next Shanghai midnight; threshold and startup
events expire at the earliest relevant quota reset or after 24 hours, whichever
comes first; and fault/recovery events expire after 24 hours. PushPlus delivery
has at most three attempts. Fixture-originated messages
always display the visible `【测试数据】` prefix.
