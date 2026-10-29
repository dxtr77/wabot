# Morning, evening, bedtime and Friday reminders

An owner can opt each enabled group into three daily Arabic reminders: morning,
evening and bedtime adhkar, plus a Surah al-Kahf reading reminder on Fridays.
New settings default to 06:00, 18:00 and 22:00, with the Friday reminder at 10:00,
in Asia/Kolkata. The feature is off until an owner enables it.
First enable the group bot with `!bot on`.

```text
!azkar on                              # use the saved/default schedules
!azkar on 06:00 18:00 Asia/Kolkata      # morning, evening, IANA time zone
!azkar on 07:00 19:00 Africa/Khartoum
!azkar bedtime 22:30                   # choose a bedtime reminder time
!azkar friday on 10:00                 # Friday reading reminder time
!azkar friday off                      # disable the Friday reminder only
!azkar status                          # schedules and delivery results
!azkar sources                         # verified hadith references
!azkar test morning                    # owner-only morning preview
!azkar test evening                    # owner-only evening preview
!azkar test bedtime                    # owner-only bedtime preview
!azkar test friday                     # owner-only Friday preview on any day
!azkar test all                        # four labelled previews, no settings changes
!azkar off                             # owner disables all reminders for this group
```

`!adhkar`, `!doaa`, `!اذكار`, and `!أذكار` are aliases. Only bot owners may enable,
disable, change schedules or send previews. Members may read status and sources.
Private chats cannot enable reminders. Tests work while reminders are disabled
and do not enable them or consume any scheduled send. `!azkar test` without a
period previews morning before noon, evening thereafter, or bedtime after its
configured time. `test sleep` and `test kahf` are aliases for the corresponding
previews. `test all` sends four separate marked messages, even on a non-Friday.
The Friday switch is part of the master reminder setting: `!azkar on` is needed
for automatic delivery, and `!azkar off` pauses all four types.

Omitted times/zone retain the saved values. The previous command form
`!azkar on 08:00 Africa/Khartoum` still works: a single time updates its matching
morning/evening slot and preserves the other slot. Morning times must be before
12:00; evening times must be 12:00 or later. Bedtime must be 18:00 or later, and
the Friday reading reminder must be before 18:00.

## Authenticity and wording

The bundled selection in `src/reminders/azkar-content.js` was checked against the
following sources on 2026-10-28. Each entry in each message includes its reference
and URL. Morning and evening use their respective wording; general daily duas
are no longer presented as a morning/evening litany.

| Entry | Period | Source |
| --- | --- | --- |
| “We have entered the morning…” opening, an explicitly labelled excerpt | Morning | [Sahih Muslim 2723b](https://sunnah.com/muslim:2723b) |
| Evening supplication, including the good of this night and protection from its evil | Evening | [Sahih Muslim 2723a](https://sunnah.com/muslim:2723a) |
| Sayyid al-istighfar | Both; the narration describes day and night recitation | [Sahih al-Bukhari 6306](https://sunnah.com/bukhari:6306) |
| Subhan Allah wa bihamdihi, 100 times in each period | Morning/evening | [Sahih Muslim 2692](https://sunnah.com/muslim:2692) |
| Supplication when going to sleep | Bedtime | [Sahih al-Bukhari 6324](https://sunnah.com/bukhari:6324) |
| Tasbih 33, tahmid 33, takbir 34 | Bedtime | [Sahih Muslim 2727a](https://sunnah.com/muslim:2727a) |

These are selected authentic adhkar, not a complete compilation. No Quran verses,
invented rewards, generated texts or unverified narrations are included. The
morning opening is labelled as an excerpt; it is not represented as the full
narration. No extra count is prescribed for entries without a displayed count. Bedtime
counts use Muslim 2727a, avoiding a different count variant in other narrations.
These reminders prompt recitation when going to bed; 22:00 is a configurable
reminder time, not a prescribed worship time.

The Friday message is a short reading reminder linking to [Surah al-Kahf, chapter
18](https://quran.com/18). It includes no Quran verses and makes no reward claims.
It cites [al-Albani's grading in Sahih al-Jami 6470, catalogued by Dorar](https://dorar.net/h/xEr7mhnH?osoul=1).
This attribution identifies the grading used; it does not claim unanimous
agreement on the narration's grading.

Sunnah.com's [official API](https://sunnah.com/developers) requires an issued API
key. The bot uses this reviewed local collection and needs no new credentials or
live content API. Check wording, reference, authenticity and period/count before
adding an entry. Delivery times are configurable local clock times for reminders;
these are not location-based Fajr/Maghrib calculations or a ruling on the limits
of religious recitation times.

## Scheduling and persistence

The scheduler checks every 30 seconds while WhatsApp is connected. Morning sends
can catch up after their scheduled time until 11:59; after noon they are skipped.
Evening sends catch up until the configured bedtime when bedtime is later
than the evening time; otherwise their window ends at midnight. Bedtime sends
catch up from their configured time until 23:59. Friday reminders are eligible
only on the group's local Friday, from their configured time until before 18:00.
This daytime cutoff is a scheduling choice, not a sunset calculation. Reconnecting
in the evening cannot send a missed morning message. There is no backlog from
previous dates. Disabling the group bot pauses all reminders.

Settings and claims are saved atomically in `data/daily-azkar.json`. Each local
calendar date has independent morning, evening, bedtime and Friday claims and
message IDs. Friday eligibility also requires that the local weekday be Friday. A
morning send cannot suppress an evening send; an evening send cannot overwrite a
morning claim. Restarting, toggling off/on, changing times, or repeated DST hours
does not reset a period's claim.

Old version-1 settings migrate automatically without changing group enablement
or time zone. The old time and delivery claim move to their matching period.
Missing periods receive the new default times. Version-2 two-period files also
migrate with their existing claims intact. Bedtime and the Friday component
(default on within the master setting) are added without enabling a group whose
master setting is off. A subsequent setting or claim write saves version 3 in
the same file. Existing data is not erased.

Claims are persisted before sending. After an ambiguous send failure, timeout or
crash, that period's claim remains held to avoid a duplicate; status reports it
as unconfirmed. The other periods remain eligible, as do later days or later Fridays. A failed
claim write prevents the send. Owner previews remain available without resetting
claims. Automatic messages carry the invisible bot marker to prevent AI replies
to the bot's own reminders.
