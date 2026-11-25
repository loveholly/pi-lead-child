# Ticket #529: Slack card thumbnails, screenshots

The screenshots show the real `ChannelMessageCard`, rendered with made-up data: the people, the messages, the file ids (`slack:F0DEMO…`) and the chart numbers are all invented. The page loads images through a fake loader. One file id (`slack:F0DEMOGONE`) fails on purpose, so the card shows its text marker instead.

| File | Width | State |
|---|---|---|
| `desktop-light-thumbnails.png` | 1280 px | Thumbnails: a folded card (36 px), an opened card (72 px, a picture that fails to load falls back to its marker), six pictures with "+2", a file tag |
| `desktop-light-preview.png` | 1280 px | Preview open on picture 2 of 6, with arrows, "2 / 6" and "Open in Slack" |
| `phone-light-thumbnails.png` | 390 px | The same cards at phone width: three thumbnails fit in a row, so the third has "+3" |
| `phone-light-preview.png` | 390 px | Preview open on picture 1 of 2 |
| `desktop-light-time-hover.png` | 1280 px | A message time on hover: a link with an external-link icon |
| `phone-action-bar-before.png` | 390 px | The action bar before the fix (code before #529): "Do not reply" drops alone to a second line, on the left |
| `phone-action-bar-after.png` | 390 px | After the fix: "Later" and "Do not reply" wrap together and stay on the right |

There are no dark screenshots: the app has only the light theme (`packages/components/src/theme/config.ts`). Decision #48 recorded that the dark item does not apply.
