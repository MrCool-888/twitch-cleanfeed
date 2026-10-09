# Twitch CleanFeed

A browser userscript that tries to block Twitch ads while keeping stream quality high. Inspired by [twitch-patched](https://github.com/ryykitty/twitch-patched).

**[Install the script](https://raw.githubusercontent.com/MrCool-888/twitch-cleanfeed/main/twitch-cleanfeed.user.js)** · **[Download from Releases](https://github.com/MrCool-888/twitch-cleanfeed/releases/latest)**

## Get started

1. Install a userscript extension such as **Violentmonkey**.
2. Click **Install the script** above, then confirm installation in your extension.
3. Disable other Twitch ad-blocking userscripts and refresh Twitch.

Already using Twitch Direct Session? Choose **Check for updates** for the existing script in Violentmonkey, then refresh Twitch. It will become **Twitch CleanFeed v1.1.5**. Keep automatic updates enabled. If you install a new copy using the link instead, disable the old copy to avoid running both. If the link only shows code, replace the entire source of your existing script and save it.

## What to expect

- Tries to find an ad-free stream at the closest available quality.
- Shows a status message when replacing ads or waiting for clean content. Click the white **CleanFeed toggle** in the bottom-right player controls to show or hide it. No slash means **On**; a slash means **Off**. Your choice is saved.
- If no clean stream is available, playback may pause or buffer. Some ads may still get through; this is experimental.

Need help or want the technical details? Expand the guide below.

<details>
<summary><strong>Full guide: troubleshooting, settings, tests, and credits</strong></summary>

[Install / download the userscript](https://raw.githubusercontent.com/MrCool-888/twitch-cleanfeed/main/twitch-cleanfeed.user.js) · [License](./LICENSE) · [Attribution](./NOTICE)

Browser adaptation of [ryykitty/twitch-patched](https://github.com/ryykitty/twitch-patched/tree/ac1d3cbe090a482a256219938e6b77211319c95b), with quality-aware direct playback and strict handling of detected stream ads.

### Install the complete file

1. Open `twitch-cleanfeed.user.js` in Notepad and copy all its contents.
2. Open the script in Violentmonkey's dashboard. Select all the old code with Ctrl+A, paste the complete new file, then save with Ctrl+S. Enable this installation and disable older copies or other Twitch playback-rewriting scripts.
3. Refresh Twitch. The script must run in the **page** context at **document start**; both settings are in its metadata. Remove any user override that selects `content` injection. For Violentmonkey Manifest V2, enable **Synchronous page mode** in advanced settings if available. See [Violentmonkey's injection documentation](https://violentmonkey.github.io/api/metadata-block/).

Replace the entire source. A previously submitted saved copy combined old and replacement lines, creating duplicate variable declarations and an unmatched brace; that prevented the script from starting. Copying the complete file avoids retaining those obsolete lines.

Version 1.1.1 adds explicit download and update URLs pointing to the script on this repository’s `main` branch. Install it once to give an older manually pasted copy those URLs. Keep automatic updates enabled in your userscript extension. Future published versions must increase `@version`; the extension checks periodically, so updates are not instant. [Violentmonkey’s update documentation](https://violentmonkey.github.io/api/metadata-block/#downloadurl).

### The actual backup-rejection bug

Version 1.0.2 treated a generic `CLASS="twitch-trigger"` date-range marker as evidence of ads. A read-only probe of Dantes found this generic marker in all three alternate contexts, alongside eight live segments with known broadcast sequence numbers and no stitched-ad identifiers. The parser incorrectly rejected those playlists.

Version 1.1.0 accepts the generic trigger. It continues to detect actual stitched-ad markers, Twitch ad attributes, ad segment titles/paths, and cue-out markers. After the fix, all three captured media playlists parse as supported live content. This verifies the parser correction, not an end-to-end browser ad break.

### Strict mode is now the default

When an ad is detected, the script first tries clean compatible direct streams. If those searches fail, it **withholds the detected ad playlist** and polls for clean content instead of returning the original ad playlist.

The banner says **Ads withheld — waiting for clean live content** while waiting. Playback can buffer or pause if Twitch supplies no clean compatible stream. A request waits at most 90 seconds, then rejects rather than returning its detected ad playlist; Twitch may show a player/network error or retry. Navigation/request cancellation stops the wait.

Strict mode governs media playlists the script intercepts and identifies as ads. It cannot guarantee that every separate client-side ad path is prevented or that a new unknown ad format will be recognized. The Android patch's native authentication/token service and native eligibility hooks cannot be installed directly in a browser. Its source also returns original media when no safe backup exists; this browser's default strict fallback intentionally differs.

To restore the optional native-ad fallback, run this on Twitch and refresh:

```js
localStorage.setItem('twitchDirect_allowNativeAds', 'true');
```

To restore strict mode, remove that setting and refresh:

```js
localStorage.removeItem('twitchDirect_allowNativeAds');
```

### Quality and transport

- Direct backup sessions use `mobile_feed` on the Android platform and `popout` on the web platform. `autoplay` is probed alongside them as a last-resort candidate; a compatible full-quality source is preferred over it. This prevents slow source probes from consuming the entire search budget before autoplay is tried.
- Resolution, frame rate, and codec matching guide selection. The native quality ladder remains intact; compatible lower quality may be used if full quality is unavailable. The script cannot force a rendition that Twitch does not supply.
- Warm backup polling runs roughly every two seconds after each probe finishes, while the session is active. Cached media is reused only if it is at most 750 ms old and adds a newer broadcast segment; otherwise the current media is refreshed. Backup requests bypass HTTP caches. Searches have a 2.2-second budget and bounded requests.
- One forward-moving broadcast sequence/timestamp timeline governs source switching. Published URLs stay stable and source/map changes receive HLS discontinuities. Ad transitions do not force player reloads or insert empty video segments.
- GraphQL header capture now handles `Request` objects and seeds newly created workers with previously captured headers. Native request objects still pass through unchanged.
- Twitch's browser client-ad refusal hook is checked again after success so it can recover if Twitch resets its manager. A declined hook is not proof that every client ad was prevented.

To disable the potentially low-quality autoplay candidate, set `twitchAdSolutions_preferLowQualityBackup` to `'false'` in Twitch's localStorage and refresh. To restore it, remove that key. This preference carries over from older custom scripts.

### Live delay (v1.1.2)

Replacement feeds can already be behind Twitch’s native feed. A total delay of 4–7 seconds in 7TV does not mean the script added that much delay. This release reduces avoidable delay from stale cached media and excess buffered video; it cannot remove upstream delivery delay.

After a clean ad replacement, gentle catch-up uses 1.05–1.08× playback when at least 3.5 seconds of contiguous video is buffered. It returns to normal speed at 2.5 seconds of buffered video, and stops on a stall, pause, seek, stale playback status, or channel change. It yields to other playback-speed controls and does not seek or reload the player. Catch-up can continue for up to 45 seconds after native playback returns. It respects an explicitly disabled Twitch low-latency setting.

`window.twitchCleanFeedStatus().catchUp` reports the controller state and `bufferedAheadSeconds`. That value measures playable buffer ahead of the current position, not the broadcaster delay shown by 7TV.

To disable this script’s catch-up, run `localStorage.setItem('twitchDirect_catchUp', 'false')` on Twitch. Remove that key to enable it again.

Regression tests cover stale/non-advancing media refresh, cache bypass, playable buffer reserves, interruption, speed ownership, disjoint buffer ranges, stale status, opt-out, and recovery to native playback. Actual 7TV delay during browser ad breaks remains unverified.

### Status and diagnostics

Version 1.1.5 makes the **CleanFeed toggle** in the bottom-right player controls show or hide the top-left status message immediately. There is no settings panel. The icon stays white: **no slash = On; slash = Off.** Hover text and the accessible button label also report On/Off. Enter or Space activates it. This changes only the message; ad blocking stays active. The setting survives refreshes and player/control replacements. Before the control row loads, the toggle appears just above the bottom-right controls. Turning it on does not revive an expired status.

The canonical script and release asset are **`twitch-cleanfeed.user.js`**; tests are **`test-cleanfeed.cjs`**. `twitch-direct-session.user.js` is an identical compatibility copy for previously installed scripts checking the old update URL. Install only one copy. Both use the same name and namespace. New updates point to the CleanFeed filename. The namespace and preference keys retain their older internal names so existing installations and saved choices continue to work.

To upgrade a previously installed copy, use Violentmonkey’s **Check for updates**. A fresh manual installation when changing from the old Twitch Direct Session name may create a second copy; disable the older script if you install that way. [Violentmonkey’s metadata documentation](https://violentmonkey.github.io/api/metadata-block/#name) explains installation identity.

In Twitch's F12 Console, select the **top** execution context and type:

```js
window.twitchCleanFeedStatus()
```

The result includes version, strict mode, playlist outcome, backup context/quality, client-ad gate state, and per-context probe results. These diagnostics exclude tokens and signed media URLs. Probe states distinguish clean media, ads in the backup, no compatible rendition, unsupported media, missing live sequences, cooldowns, and token/master/media request failures. The old `window.twitchDirectStatus()` name remains an alias for compatibility. Console messages beginning `[DIRECT]` give additional detail.

The banner shows **checking replacement streams**, **ad playlist replaced** with context and quality, or **ads withheld** while waiting. Under the optional native-ad policy, it may report **no clean replacement; native playback**. It hides when clean native playback returns or playlist updates stop. Selecting a clean playlist does not by itself prove that the video decoded successfully.

If `twitchCleanFeedStatus is not a function`, first verify version 1.1.5 is installed and enabled, refresh, and select the main page console context. Violentmonkey's generic **Syntax error?** warning can also indicate an injection failure; see the [maintainer's explanation](https://github.com/violentmonkey/violentmonkey/discussions/1744). Errors for blocked analytics/tracking requests do not establish that stream ads were blocked.

### Validation

52 automated tests passed with Node.js 24. The direct toggle was also checked in a local browser player preview for mouse/keyboard operation, saved preferences, expired status, and player/control replacement. Live Twitch control layout remains unverified. Coverage includes the generic-trigger regression, actual ad attributes, backup selection and deadlines, autoplay budget access, strict waiting and timeout/cancellation, unsupported ad playlists, native recovery, forward/stable HLS timelines, header capture, client-ad rechecks, whole-script startup, and generated-worker initialization.

Read-only network requests obtained HTTP 200 token, master, and media responses for Dantes in all three contexts. The sampled renditions were 284x160 (`mobile_feed`), 1280x720 (`popout`), and 640x360 (`autoplay`); these samples are not claims about the full available quality ladders. The fixed parser accepted each captured playlist. No video segments were downloaded, and actual browser playback/ad-break success remains unverified.

Run the repository tests with Node.js:

```text
node --check twitch-cleanfeed.user.js
node --test test-cleanfeed.cjs
```

### Attribution and license

Android adaptation source: `ryykitty/twitch-patched`, commit `ac1d3cbe090a482a256219938e6b77211319c95b`, especially `PlaylistSessions.java`, `AdRuntime.java`, `HlsPlaylist.java`, and `LiveWindow.java`.

Browser transport derives from the supplied vaft v68.5.7 and local stability changes. The client-ad gate derives from [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock/blob/a1453021869b43870e30fac4c384d09b60bef435/vaft.user.js), commit `a1453021869b43870e30fac4c384d09b60bef435`.

GPL version 3 applies to this adaptation. Retain LICENSE, NOTICE, and TwitchAdBlock-MIT.txt when redistributing. The repository contains the unminified userscript source and runnable tests. This independent project is not endorsed by the upstream maintainers.

</details>

Licensed under [GPL-3.0](./LICENSE). Upstream credits and license notices are in [NOTICE](./NOTICE).

## Disclaimer

This project was built with AI assistance. It has automated tests, but real-world Twitch ad blocking has not been fully verified. Bugs, missed ads, lower quality, or buffering are possible. It is an independent project, not affiliated with Twitch or the upstream projects.
