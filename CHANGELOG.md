# Changelog

All notable changes to Disk Space Over Time are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), with versions in the form
v<major>.<minor> (two-digit minor) to match the Git tags and Docker image tags.

## [Unreleased]

## [1.00] - 2026-11-24

### Added
- First release: reads the size and free space of each drive once a day (at `RECORD_TIME`,
  default 03:00, and the first time it runs) and keeps every reading (`KEEP_DAYS` to trim).
- A card per drive with its free space, a bar for how full it is, the change over the last 30
  days, and when it will be full at the rate of the last `TREND_DAYS` (default 90) days.
- A chart of the space used over time with the drive's size as a dashed line and the trend
  carried on to the right, Month / 3 months / Year / All, a hover (and arrow-key) reading for any
  day, and a Readings table under each chart.
- Low on space (under `LOW_PERCENT`, default 10%) and Filling up (full within `SOON_DAYS`, default
  90) marks, with totals across all drives.
- You pick the drives to check in Settings: drives on a NAS or another computer over SSH, and
  any drives of this machine mounted read-only under `/drives` (none are needed for a NAS alone).
  Settings makes an SSH key in the app (or takes yours) and shows the `authorized_keys` line,
  which limits the key to running `df`. The key is stored encrypted.
- A drive that can't be read (a sleeping NAS) is tried again every 30 minutes that day and nothing
  is recorded for it meanwhile. Record now reads every drive at once.
- Download CSV of every reading (Excel-safe drive names).
- Sign-in with one username and password and a lockout after 10 wrong passwords in 15 minutes.
- Light and dark looks, Help, About and `GET /healthz`.
