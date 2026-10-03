# Browser Audio Capture

A Windows desktop app with its own browser. Log in on a site, play audio, and record that audio to a WAV file on this PC.

The browser keeps its own cookies and site data. A login stays after you close the app or restart the PC, for as long as the site keeps that login valid.

## Run

You need [Node.js](https://nodejs.org/) installed.

```bash
npm install
npm start
```

Recordings are saved in the `captured` folder in this project.

## Tabs

Each tab opens its own site. Switching tabs does not stop a recording that is already running.

- **Record** on the toolbar, **F9**, or the dot on a tab records that tab only. Several tabs can record at the same time, each to its own WAV file.
- **Downloads** saves files the page itself downloads into the `downloads` folder, separate for each tab. The arrow on a tab shows that tab's latest download.
- Mute applies to the tab you are looking at. Other tabs keep their own mute setting.

Ctrl+T opens a tab, Ctrl+W closes the current tab, and Ctrl+Tab switches tabs. Closing a tab that is recording saves that take and leaves the other tabs alone.

## Record

1. Enter a site in the address bar and log in.
2. Play the audio.
3. Press the red record button, or press **F9**.
4. Press it again to stop.

The app records only this browser's audio, not other programs. The speaker button mutes this browser's sound so you can listen to something else on the PC. Recording keeps capturing the page either way, including if you mute or unmute while a take is in progress. The choice is remembered.

When recording stops, a dialog asks whether to trim silence at the beginning and end. **Keep as recorded** leaves the file as it is. **Trim silence at ends** removes the quiet parts at the two ends and leaves the middle unchanged. About a tenth of a second is kept so the start and end of the sound are not clipped.

**Stop after 1 min silence** is on by default. If the page stays quiet for 60 seconds, recording stops and the same trim dialog appears. Turn the switch off to let a take run through long quiet stretches. The choice is remembered.

Closing the app while a recording is in progress saves the file and skips the trim dialog.

## Files

Files are 48 kHz, 24-bit PCM WAV, usually stereo. The name is the date, time, and site, for example `2026-10-03_19-30-00_www.example.com.wav`.

The recorded level follows the volume inside the website, such as the player's own slider. The Windows volume, and muting the speakers, change what you hear and do not change the WAV.

## Shortcuts

| Key | Action |
| --- | --- |
| F9 | Start or stop recording for the current tab |
| Ctrl+T | New tab |
| Ctrl+W | Close the current tab |
| Ctrl+Tab | Next tab |
| Ctrl+L | Focus the address bar |
| Alt+Left / Alt+Right | Back / forward |
| Enter in the address bar | Open the address, or search if it is not a URL |

## Limits

Some sites block capture of protected audio. A recording can be silent even while you still hear playback.

Google sometimes refuses sign-in inside an embedded browser.

A login the site marks as "until the browser closes" ends when you quit the app. A login the site marks as persistent stays.
