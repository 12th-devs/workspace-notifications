# Workspace Notifications

A notification inbox shared across workspaces, beside Zen's native workspace menu. Hover or click the workspace indicator to open the panel straight into the Inbox. Leaving both the indicator and popup closes it after 300 ms; Escape and outside clicks also close it. Saved workspace names and icons stay unchanged.

## Sources

Open the panel from the workspace indicator, then use **Apps → Add a source**:

- **Mail:** connect a signed-in Gmail tab. The account-specific Atom inbox feed is preferred, with rendered unread rows as fallback. Only unopened messages appear, newest first below live notifications. Clock times and dates come from messages, never scans. Atom uses the received/issued date before modified dates; clock-only labels later than the current time roll back to yesterday. Date-only/unknown dates preserve their original labels; unknown dates appear last in stable source order. Opening mail removes its card, cached scans cannot resurrect it, and new unread replies can appear again. Initial unread mail is seeded quietly.
- **GitHub:** connect any signed-in GitHub tab. The actor fetches the account's [unread notification inbox](https://docs.github.com/en/subscriptions-and-notifications/reference/inbox-filters) using that tab's existing session, without API tokens. Mentions, reviews, issues, pull requests, and discussions use stable thread IDs. Row text is reduced to the issue title alone; repo and number move into a compact `org/repo #123 · reason` detail line, with dates, comment counts, and subscription state stripped. The initial inbox is seeded quietly; read threads disappear, changed unread threads update, and opened/dismissed cards stay suppressed until a new revision. If GitHub does not return a usable inbox, existing cards remain and the source asks you to open Notifications / Unread.
- **Slack, Microsoft Teams, Discord, Outlook:** connect a signed-in web tab and enable desktop notifications in the app and its Zen site permissions. These sources capture future desktop alerts through the same native observer used for Calendar. Earlier unread messages are not imported. Connections match the exact site origin and container; accounts or workspaces sharing that origin/container are included together because native alerts do not provide a reliable account identity. Use separate containers to isolate them. Only the first connection for an origin/container is needed. A labeled **Send test alert** checks the mod's inbox path; it does not prove that the app or site permissions will deliver real alerts. Native system notifications continue normally.
- **Calendar:** two independent options. Connecting a Google Calendar tab mirrors reminders that actually fire as desktop notifications (turn them on in Google Calendar settings and allow them for `calendar.google.com` in Zen; past and upcoming events are never listed, and missed reminders are not reconstructed). The tab row reports blocked/allowed permission plus the last captured alert; **Send test reminder** in its options injects a labeled card through the real feed path. Subscribing to an **iCal feed URL** (Google Calendar Settings → Integrate calendar → Secret address in iCal format) needs no tab: the feed is polled every five minutes and timed events starting within 30 minutes — plus ongoing ones — appear automatically and close when over. All-day events never surface. The feed row shows polling state (`Monitoring · N upcoming`, or `Unavailable` with the reason). Calendar accounts in the same origin/container are included together; account identity is not guessed from notification text.
- **Sports team:** select NFL, NBA, MLB, or NHL, search by team name/abbreviation, and Follow. Public ESPN data supplies schedules, scores, full names, and logos without accounts, API keys, or background game tabs. Existing connected Google game tabs remain supported.
- **Scores tab:** connect a Google Search tab showing a live score, as an alternative to following a team.

Sources opens as a sidebar layout filling the panel: an icon-only rail (Inbox, Apps, Teams, Settings, plus an Add button) beside the main column, with a close button top right. The Inbox is the notification list. Apps holds the connect options plus the Connected apps and Followed teams sections. Cards show the native app or team icon, a status dot, a textless switch, and a chevron that opens per-source options (Open, Refresh / Send test reminder / Poll now, Disconnect, container and URL details). Team cards carry open and following-check icon buttons in their top-right corner; the team search uses plus/check icon buttons. All glyphs are native Zen icons from the build (no text or emoji icons). Diagnostics and optional tab reload settings are under **Settings**.

Pausing retains configuration. Disconnecting removes that source's cards/manual games. A game remains tracked after unfollowing a team if another followed team participates. Updates preserve controls, keyboard focus, search input, scroll position, and open menus.

The header and navigation stay visible while the main column scrolls. Buttons use the installed Zen toolbar colors and corner sizes; connected sources use flat rows. Opening a section moves keyboard focus to its heading. Empty connection views offer a refresh action and supported desktop-alert apps offer an Open action. Desktop-alert sources show blocked/missing permission guidance, changed-site status, and their own last captured alert time. These sources do not auto-reload.

## Notifications and live scores

In-progress games and active Calendar reminders appear under Live notifications at the top. Active reminders keep the Calendar icon and summary on the workspace indicator until dismissed with their dismiss control. Score updates change one existing card. Closed Calendar reminders move into the chronological list. Clicking a reminder opens its connected Calendar tab; native Windows notification behavior is untouched.

Scores show away logo, a score-only "24 – 27" line (pre-game shows "vs"), and opponent logo; live menu cards keep the full "Away vs Home" team names in their captions, and full names stay in accessibility labels. Failed provider logos use official abbreviations. The newest notification takes over the workspace icon and summary and stays there until dismissed or opened; dismissing it reveals the next newest, and the earliest-starting live game uses the indicator only when nothing is pinned (unless **Show in workspace** selects another). The − button at the right end of the indicator (where the workspace options button sits) unpins the shown item: its card stays in the notification center but never takes the indicator again. It appears when hovering any part of the workspace indicator (or focusing the bar) while the text shrinks to fit. Start/final alerts are emitted once per provider event ID, including when both teams are followed. Historical final results discovered on follow are added quietly.

Ordinary notifications are full-width flat rows with dividers (no card background or shadow), and all notification text is left-aligned. Titles clamp to two lines and top-row service/time labels ellipsize; per-account labels are hidden. Source rows are transparent dividers while switches and menu buttons float as their own pills, all fully hoverable/focusable. Cached mail remains hidden until a fresh unread scan after restart. Dismiss removes cards from this feed only. Mail/GitHub coverage is limited to unread Atom entries or verified inbox rows returned by the connected account. App icons reuse native tab favicons, except tab-free iCal feeds which use the inline Tabler calendar-clock glyph. The league picker uses inline buttons so it stays inside the popup.

## Refresh and persistence

- Gmail and GitHub poll once a minute with an eight-second timeout; feed availability varies by account.
- ESPN schedules refresh on follow and every six hours. Scoreboards refresh every five minutes near games, every 30 seconds while live, and every six hours otherwise. One coordinator shares requests across teams/windows. Requests time out after eight seconds and back off on errors up to 15 minutes. Failed requests retain follows and cached schedules with an unavailable status.
- Calendar uses Gecko's `web-notification-shown` and `web-notification-closed` observers. `browser.alerts.capture.enabled` is enabled while monitoring Calendar; its previous preference state is restored afterward unless another consumer changes it. Unsupported engines show an unavailable state. Missed reminders are not reconstructed.
- Optional auto-reload is for loaded inactive tab sources, at least two minutes apart. Editing, dialogs, audio, active navigation, recent interaction, and discarded tabs prevent reloads.
- Store version 2 preserves connections, container bindings, unread suppression, dismissed cards, and manual games. Old Calendar DOM alerts are removed. State stays in the profile's `workspace-notifications.json`. Private windows neither collect nor display notifications.
- Restored scan/alert timestamps retain their full millisecond values. Gmail's DOM fallback waits for the inbox list instead of treating an open message or another view as an empty inbox. GitHub scan failures display their recovery reason and retain existing cards.
- Invalid iCal responses retain reminders rather than clearing them. Reminders expire at their end time even while a feed is offline; changed titles/locations update the existing card. Disconnecting or pausing a feed during a request prevents its result from restoring source state. Tab-free iCal continues working in builds without native alert capture.
- Malformed sports responses retain cached schedules and report unavailable status. Manual refresh clears scoreboard cache and provider backoff so an explicit retry reaches the provider.

## Settings and debugging

Sine / about:config preferences: `workspace-notifications.enabled`, `hover-delay-ms` (250), `refresh-interval-min` (2, minimum 2), and `debug` (false), all under the `workspace-notifications.` prefix. The former Calendar reminder-lead and brief title-duration preferences are unused.

Browser Console helpers:

```js
WorkspaceNotifications.openSources()
WorkspaceNotifications.scanAll()
WorkspaceNotifications.state()
WorkspaceNotifications.providerStatus()
WorkspaceNotifications.diagnostics()
WorkspaceNotifications.logs()
WorkspaceNotifications.debug()
WorkspaceNotifications.followTeam({provider: "espn", league: "nfl", id: "23", name: "Pittsburgh Steelers"})
WorkspaceNotifications.unfollowTeam("espn:nfl:23")
```

Run deterministic checks from the Sine mods root: `node --test workspace-notifications/tests/*.test.mjs`. Fixture checks do not prove signed-in Gmail or Google Calendar delivery; report native Zen and browser interaction checks separately.

**Restart Zen after updating:** actor registrations and imported modules are cached until restart.
