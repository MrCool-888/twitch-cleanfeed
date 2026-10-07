# Twitch Direct Session

A browser userscript that tries to block Twitch ads while keeping stream quality high. Inspired by [twitch-patched](https://github.com/ryykitty/twitch-patched).

**[Install the script](https://raw.githubusercontent.com/MrCool-888/twitch-direct-session-browser/main/twitch-direct-session.user.js)** · **[Download from Releases](https://github.com/MrCool-888/twitch-direct-session-browser/releases/latest)**

## Get started

1. Install a userscript extension such as **Violentmonkey**.
2. Click **Install the script** above, then confirm installation in your extension.
3. Disable other Twitch ad-blocking userscripts and refresh Twitch.

If the link shows code, copy the entire file into a new Violentmonkey script and save it. Install version 1.1.1 once to enable link-based updates. Keep automatic updates enabled in Violentmonkey; it will check this same link for newer versions. You can also check for updates from its dashboard.

## What to expect

- Tries to find an ad-free stream at the closest available quality.
- Shows a status message when replacing ads or waiting for clean content.
- If no clean stream is available, playback may pause or buffer. Some ads may still get through; this is experimental.

Need help or want the technical details? Expand the guide below.

<details>
<summary><strong>Full guide: troubleshooting, settings, tests, and credits</strong></summary>

[Install / download the userscript](https://raw.githubusercontent.com/MrCool-888/twitch-direct-session-browser/main/twitch-direct-session.user.js) · [License](./LICENSE) · [Attribution](./NOTICE)

Browser adaptation of [ryykitty/twitch-patched](https://github.com/ryykitty/twitch-patched/tree/ac1d3cbe090a482a256219938e6b77211319c95b), with quality-aware direct playback and strict handling of detected stream ads.

### Install the complete file

1. Open `twitch-direct-session.user.js` in Notepad and copy all its contents.
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
- Warm backup polling runs roughly every two seconds after each probe finishes, while the session is active. Snapshots expire after eight seconds. Searches have a 2.2-second budget and bounded requests.
- One forward-moving broadcast sequence/timestamp timeline governs source switching. Published URLs stay stable and source/map changes receive HLS discontinuities. Ad transitions do not force player reloads or insert empty video segments.
- GraphQL header capture now handles `Request` objects and seeds newly created workers with previously captured headers. Native request objects still pass through unchanged.
- Twitch's browser client-ad refusal hook is checked again after success so it can recover if Twitch resets its manager. A declined hook is not proof that every client ad was prevented.

To disable the potentially low-quality autoplay candidate, set `twitchAdSolutions_preferLowQualityBackup` to `'false'` in Twitch's localStorage and refresh. To restore it, remove that key. This preference carries over from older custom scripts.

### Status and diagnostics

In Twitch's F12 Console, select the **top** execution context and type:

```js
window.twitchDirectStatus()
```

The result includes version, strict mode, playlist outcome, backup context/quality, client-ad gate state, and per-context probe results. These diagnostics exclude tokens and signed media URLs. Probe states distinguish clean media, ads in the backup, no compatible rendition, unsupported media, missing live sequences, cooldowns, and token/master/media request failures. Console messages beginning `[DIRECT]` give additional detail.

The banner shows **checking replacement streams**, **ad playlist replaced** with context and quality, or **ads withheld** while waiting. Under the optional native-ad policy, it may report **no clean replacement; native playback**. It hides when clean native playback returns or playlist updates stop. Selecting a clean playlist does not by itself prove that the video decoded successfully.

If `twitchDirectStatus is not a function`, first verify version 1.1.1 is installed and enabled, refresh, and select the main page console context. Violentmonkey's generic **Syntax error?** warning can also indicate an injection failure; see the [maintainer's explanation](https://github.com/violentmonkey/violentmonkey/discussions/1744). Errors for blocked analytics/tracking requests do not establish that stream ads were blocked.

### Validation

43 automated tests passed with Node.js 24. Coverage includes the generic-trigger regression, actual ad attributes, backup selection and deadlines, autoplay budget access, strict waiting and timeout/cancellation, unsupported ad playlists, native recovery, forward/stable HLS timelines, header capture, client-ad rechecks, whole-script startup, and generated-worker initialization.

Read-only network requests obtained HTTP 200 token, master, and media responses for Dantes in all three contexts. The sampled renditions were 284x160 (`mobile_feed`), 1280x720 (`popout`), and 640x360 (`autoplay`); these samples are not claims about the full available quality ladders. The fixed parser accepted each captured playlist. No video segments were downloaded, and actual browser playback/ad-break success remains unverified.

Run the repository tests with Node.js:

```text
node --check twitch-direct-session.user.js
node --test test-direct-session.cjs
```

### Attribution and license

Android adaptation source: `ryykitty/twitch-patched`, commit `ac1d3cbe090a482a256219938e6b77211319c95b`, especially `PlaylistSessions.java`, `AdRuntime.java`, `HlsPlaylist.java`, and `LiveWindow.java`.

Browser transport derives from the supplied vaft v68.5.7 and local stability changes. The client-ad gate derives from [scamorza/TwitchAdBlock](https://github.com/scamorza/TwitchAdBlock/blob/a1453021869b43870e30fac4c384d09b60bef435/vaft.user.js), commit `a1453021869b43870e30fac4c384d09b60bef435`.

GPL version 3 applies to this adaptation. Retain LICENSE, NOTICE, and TwitchAdBlock-MIT.txt when redistributing. The repository contains the unminified userscript source and runnable tests. This independent project is not endorsed by the upstream maintainers.

</details>

Licensed under [GPL-3.0](./LICENSE). Upstream credits and license notices are in [NOTICE](./NOTICE).

## Vibe-coded disclaimer

This project was built with AI assistance (“vibe coded”). It has automated tests, but real-world Twitch ad blocking has not been fully verified. Bugs, missed ads, lower quality, or buffering are possible. It is an independent project, not affiliated with Twitch or the upstream projects.
