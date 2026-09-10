# Baskets of comparable LE releases

*Analysis of 2026-09-10 on the full BigQuery funnel pull (2023-01-01 to 2026-09-10).
Reproduce with `node server/bigquery.js --write --full && python3 etl/analysis/release_clusters.py`;
the script prints everything quoted here and writes `data/release_clusters.csv` (every release's
window, features and basket) and `data/release_cluster_baskets.json` (the quartile tables).*

## 1. The question, and the short answer

The target model plans every channel and funnel stage from quartiles of one pooled panel
(`docs/METHODOLOGY.md` §3). A new artist, or a collaboration unlike any we have run, has no
previous campaign to pick against, so the question was whether the history sorts itself into
a few recognisable kinds of release whose quartiles would be a better prior than everyone's.

**It does, into two kinds robustly and four defensibly.** On 108 completed draw
campaigns (2023 Q3 to 2026 Q3), every test agrees that the first split is real and stable:
**paid-led** launches against **organic** ones. Below that, four baskets hold up under bootstrap
resampling and are preferred by the information criterion; three is an unstable halfway house,
and five or more dissolve into groups that do not survive resampling. The clusters are regions
of a continuum rather than islands (silhouette 0.20 to 0.22 against a no-structure ceiling of
0.08), so a launch is *placed* in a basket with judgement and read against the basket's whole
range, never against its median alone.

| # | Basket | Releases | In plain terms | Typical examples |
|---|---|---|---|---|
| 0 | **Paid-led headline launches** | 33 | Big editions (median 214 units) where paid social brings most of the traffic (median 61% of sessions), pre-order carries much of the demand, and the campaign paces evenly - half the sessions arrive by mid-campaign. The current operating model for headline names and estates. | Hank Willis Thomas · “Success is no accident.” · 2026 Q2; Zeng Fanzhi · Rainbow (Mask Series 1997 no.8) · 2026 Q3; Parra · Multiple · 2026 Q3; largest: Maurizio Cattelan · We are the Revolution · 2025 Q4; Anni and Josef Albers · Multiple · 2026 Q2; Piet Mondrian Estate · Multiple · 2026 Q3 |
| 1 | **Paid-supported small editions** | 17 | Small editions (median 32 units) run with the same paid-led playbook, but the traffic converts a third as well (0.3% of sessions to an eligible entry) and the draw ends undersubscribed (eligible entry units 0.71 × units sold). | Ahmed Mater · Multiple · 2026 Q3; Grant Riven Yun · High Fly Over the Valley · 2026 Q2; Antony Micallef · Self Portrait with Blue Slash · 2026 Q2; largest: Eddie Martinez · Olive Garden · 2026 Q2; Antony Micallef · Self Portrait with Blue Slash · 2026 Q2; Zeng Fanzhi · Multiple · 2026 Q3 |
| 2 | **Email-led collector launches with a private room** | 35 | Mid-size, organic launches (median 75 units) sold to the existing collector base: email is 61% of sessions, the private room books 39% of the units, 31% of units land before the announcement, and the announcement email *is* the campaign - half the sessions are in by 8% of the way through. | Ferrari Sheppard · Iris · 2025 Q2; José Parlá · Multiple · 2024 Q4; Jammie Holmes · Fred · 2025 Q1; largest: Javier Calleja · Multiple · 2024 Q2; Parra · Multiple · 2024 Q4; Ai Weiwei · Multiple · 2024 Q4 |
| 3 | **Artist-audience draws** | 23 | Small, short (19-day) organic draws where the artist's own audience arrives direct or by referral (36% search/direct/other, 16% referral artist), converts best in the panel (4.0% of sessions to an eligible entry), almost no private room, and the edition oversubscribes. Includes the digital-native names. | Jonny Niesche · Diamond Vibration (Caught by the fuzz) · 2023 Q4; Camilla Engström · Island Creators · 2023 Q4; Emily Xie · Guardian Lion · 2024 Q1; largest: George Condo · Multiple · 2024 Q1; Yoon Hyup · In The City · 2023 Q4; Johnson Tsang · Open the Right Mind · 2023 Q4 |
| – | **Legacy buy-now launches** | 47 | Everything before the draw mechanic (2023 Q1 to 2024 Q3, plus a few later no-draw releases): a launch day, a three-week sell-through tail, no entries. On the features they share, 37 of 47 sit nearest the artist-audience basket. | Ai Weiwei · Multiple · 2023 Q2; Ai Weiwei · Glass Vase · 2023 Q3; Yoon Hyup · City Fountain · 2024 Q3 |

**Repeat artists do not stay in one basket.** With the two-way split, same-artist pairs land
together 55% of the time against 50% by chance (permutation p = 0.27);
paid was switched on between most artists' releases. With four baskets it is 39% against
26% (p = 0.036), a real but weak pull: 5 of 19 repeat
artists keep to one basket. What an artist does carry over is the **size** of the launch
(intraclass correlation 0.79 for sessions, 0.77 for units) and, more loosely, where the traffic
comes from; the timing shape and the conversion rates follow the campaign design, not the
artist (§6). So the basket is chosen by what the launch is designed to be - paid or organic,
edition size, private room or not - which is exactly the information available for a new artist.

## 2. The panel

**Data.** `le_funnel_report_split_touch_export` from BigQuery, every row since 2023-01-01
(423,982 channel × day × release rows, 360 release names), plus the Meta spend table. The pull
is the one the dashboard makes; nothing was hand-edited.

**Campaign windows.** The upstream campaign clock (announce and close dates) exists only for
2026 launches - 27 releases in the panel. For everything earlier the window
is inferred from the funnel itself, using two facts of the mechanic: draws open at the
announcement, and draw units are booked on the day winners are allocated.

- *announce* = the first day of a run of two or more consecutive days with draw or pre-order
  entries, or a day with three or more (a stray single entry days before the announcement is not
  the announcement);
- *close* = the day with the most draw units booked, else the last day with entries.

Checked against the 32 clocked releases with a usable clock: the announce rule is exact on 26
and within two days on 31 (the miss is Pejac 2026 Q1, whose draw opened ten days after the
recorded announce); the close rule is exact on 24 of the 27 with draw units, and the three
misses (+7, +10, +15 days: Jaume Plensa, Felipe Pantone, Johnson Tsang Alliance) are draws
whose entries carried on past the clock's close, so the inferred date is arguably the truer
one. The dashboard's own reconstruction (`discover_releases`) supplies the dates where the
clock exists; the window for totals runs from 45 days before announce (early access reaches no
further: 44 sessions beyond that in the whole clocked panel) to three days after the later of
close and allocation.

**Mechanic eras.** The first draws appear in 2023 Q3 and Q4; by 2024 Q4 nearly every release
is one. Pre-order entries appear from 2024 Q4 and dominate 2026. Paid social shows up on a
handful of 2024 campaigns and is the majority of traffic from 2025. The clustering therefore sees three generations of playbook,
and the baskets partly encode when a release ran (§5) - which is a feature for planning, since
the paid baskets are the current playbook and the organic ones remain the right reference
for organic channels.

**Floors.** Draw panel: at least 10 eligible entry units and 10 units sold inside the window,
a window of 3 to 90 days, closed at least 7 days before the export's last day, and a window
that starts after the export begins. Legacy panel: at least 10 units and 300 sessions in the
window (launch day to +21 days). Excluded: 170 names with fewer than 10 entries and 10 units
(catalogue traffic, cancelled or tiny releases), 9 with under 10 units in the window, 8 whose
private-room phase predates the export, 7 named for a quarter before 2023, 4 draws under 10
eligible entry units in the window, 1 legacy launch under 300 sessions, and 6 in flight or not
yet settled on 2026-09-10: Andy Warhol Estate, Salvador Dali Estate, Glenn Ligon, Julian
Schnabel, Robert Longo and Ai Weiwei 2026 Q3. Re-run the script after they close.

## 3. Features and distance

Seventeen features in four blocks, each release measured over its own window. Every feature
is winsorised at the 2nd/98th percentile and z-scored; each block is then weighted by
1/√(features in the block) so the four blocks carry equal total variance in the distance,
and no block (five mix shares, say) outvotes another by having more columns.

| Block | Features |
|---|---|
| Scale | log sessions, log units sold, log eligible entry units |
| Channel mix of sessions | AA Email, AA Meta, Referral artist, Search/direct/other, Paid (untracked excluded from the denominator) |
| Demand and conversion | log oversubscription (eligible entry units ÷ units sold), private-room share of units, log eligible entry units per session, log units per session |
| Timing shape | campaign days, share of sessions before announce, share in the first 10% of the campaign, share in the last 10%, the point at which half the campaign's sessions are in |

Per-channel conversions and the campaign-stage shares are computed for every release and
reported per basket (§7) but not used in the distance, where they would double-count the
mix and timing blocks.

## 4. How many clusters the data supports

k-means (50 restarts) at every k from 2 to 8, judged by six independent readings. Silhouette
is compared with the same statistic on data whose columns were permuted independently (same
marginals, no joint structure; 200 draws). The gap statistic uses 100 uniform reference draws
in the PCA-rotated bounding box (Tibshirani et al.). Stability is Hennig's bootstrap Jaccard:
200 resamples, each cluster's mean best-match with a cluster found on the resample (above 0.75
is stable, 0.6 to 0.75 a pattern, below 0.5 dissolved), plus the adjusted Rand index between the
reference partition and the resample's. Ward agreement is the adjusted Rand index between
k-means and Ward hierarchical clustering cut at the same k.

| k | Silhouette | Permuted-data p95 | Gap ± se | GMM BIC (diag) | Jaccard mean / min | Bootstrap ARI | Ward ARI | Smallest cluster |
|---|---|---|---|---|---|---|---|---|
| 2 | 0.22 | 0.08 | 0.795 ± 0.028 | 1,972 | 0.97 / 0.96 | 0.94 | 0.76 | 48 |
| 3 | 0.22 | 0.07 | 0.805 ± 0.026 | 1,568 | 0.74 / 0.65 | 0.68 | 0.43 | 24 |
| 4 | 0.20 | 0.07 | 0.859 ± 0.026 | 1,503 | 0.84 / 0.79 | 0.81 | 0.59 | 17 |
| 5 | 0.19 | 0.07 | 0.854 ± 0.027 | 1,526 | 0.67 / 0.42 | 0.67 | 0.53 | 14 |
| 6 | 0.19 | 0.07 | 0.873 ± 0.028 | 1,567 | 0.63 / 0.40 | 0.61 | 0.57 | 8 |
| 7 | 0.19 | 0.07 | 0.899 ± 0.028 | 1,681 | 0.62 / 0.47 | 0.60 | 0.76 | 6 |
| 8 | 0.19 | 0.07 | 0.892 ± 0.029 | 1,662 | 0.62 / 0.41 | 0.61 | 0.61 | 6 |

Gap at k=1 is 0.707; the one-standard-error rule stops at **k = 2**. The GMM BIC is 2,676 at
k=1 and lowest at **k = 4**. The silhouette's permutation p-value is below 0.005 at every k, so
there is joint structure at every k; the question is only how much of it survives resampling,
and the answer is: two clusters almost perfectly (0.97), four well (0.84, no cluster below
0.79), three and five badly (0.74 with a cluster at 0.65; 0.67 with one at 0.42). The gap keeps
creeping up past four without an elbow, which is what a continuum looks like.

**What carries the structure.** Refitting with a block removed, or with one block alone, and
comparing with the full solution (adjusted Rand index; bootstrap Jaccard of the variant):

| Variant | ARI vs main k=2 | k=3 | k=4 | k=5 | Jaccard k=2 | k=3 | k=4 | k=5 |
|---|---|---|---|---|---|---|---|---|
| all blocks | 1.00 | 1.00 | 1.00 | 1.00 | 0.97 | 0.74 | 0.87 | 0.67 |
| without scale | 0.86 | 0.87 | 0.62 | 0.45 | 0.96 | 0.94 | 0.70 | 0.64 |
| without mix | 0.34 | 0.35 | 0.83 | 0.69 | 0.79 | 0.78 | 0.83 | 0.67 |
| without demand | 0.41 | 0.35 | 0.75 | 0.59 | 0.91 | 0.70 | 0.84 | 0.70 |
| without timing | 0.89 | 0.36 | 0.67 | 0.57 | 0.91 | 0.71 | 0.76 | 0.69 |
| organic mix (paid share dropped) | 0.72 | 0.29 | 0.76 | 0.50 | 0.70 | 0.78 | 0.84 | 0.67 |
| scale only | 0.09 | 0.01 | 0.23 | 0.33 | 0.91 | 0.94 | 0.75 | 0.80 |
| mix only | 0.86 | 0.55 | 0.37 | 0.42 | 0.99 | 0.90 | 0.90 | 0.81 |
| demand only | 0.35 | 0.35 | 0.18 | 0.22 | 0.80 | 0.78 | 0.71 | 0.71 |
| timing only | 0.19 | 0.34 | 0.37 | 0.17 | 0.93 | 0.76 | 0.64 | 0.68 |

The two-way split *is* the channel mix (mix alone reproduces it, ARI 0.86; without mix it goes,
0.34): paid on or off. The four-way structure is not: it survives dropping the mix block
entirely (0.83) or the paid share (0.76), and dropping any single block leaves it at 0.62 or
better, because it rests on size, the private room and the timing shape together. Scale alone
or timing alone reproduce neither solution.

## 5. The baskets in detail

Medians by basket, all 108 releases. The year rows show the era each basket comes from.

| | Paid-led headline launches | Paid-supported small editions | Email-led collector launches with a private room | Artist-audience draws |
|---|---|---|---|---|
| Releases | 33 | 17 | 35 | 23 |
| By year | 2024: 3, 2025: 8, 2026: 22 | 2024: 2, 2025: 4, 2026: 11 | 2023: 2, 2024: 13, 2025: 15, 2026: 5 | 2023: 12, 2024: 9, 2025: 2 |
| Typical (nearest the centre) | Hank Willis Thomas · “Success is no accident.” · 2026 Q2; Zeng Fanzhi · Rainbow (Mask Series 1997 no.8) · 2026 Q3; Parra · Multiple · 2026 Q3 | Ahmed Mater · Multiple · 2026 Q3; Grant Riven Yun · High Fly Over the Valley · 2026 Q2; Antony Micallef · Self Portrait with Blue Slash · 2026 Q2 | Ferrari Sheppard · Iris · 2025 Q2; José Parlá · Multiple · 2024 Q4; Jammie Holmes · Fred · 2025 Q1 | Jonny Niesche · Diamond Vibration (Caught by the fuzz) · 2023 Q4; Camilla Engström · Island Creators · 2023 Q4; Emily Xie · Guardian Lion · 2024 Q1 |
| Largest | Maurizio Cattelan · We are the Revolution · 2025 Q4; Anni and Josef Albers · Multiple · 2026 Q2; Piet Mondrian Estate · Multiple · 2026 Q3 | Eddie Martinez · Olive Garden · 2026 Q2; Antony Micallef · Self Portrait with Blue Slash · 2026 Q2; Zeng Fanzhi · Multiple · 2026 Q3 | Javier Calleja · Multiple · 2024 Q2; Parra · Multiple · 2024 Q4; Ai Weiwei · Multiple · 2024 Q4 | George Condo · Multiple · 2024 Q1; Yoon Hyup · In The City · 2023 Q4; Johnson Tsang · Open the Right Mind · 2023 Q4 |

The paid baskets are 2025 to 2026, the artist-audience basket is 2023 Q4 to 2024, and the
email-led basket bridges them. That is the playbook changing under the same artists: Ai Weiwei
is an email-led private-room launch twice in 2024 Q4 and a paid-led headline launch in 2025 Q4
and 2026 Q2; Johnson Tsang has been in three baskets. Five 2026 releases (Luc Tuymans, Backside
works., Miwa Komatsu, Johnson Tsang, Tschabalala Self) still sit in the email-led basket, two of
them with a quarter of their sessions paid, so the basket is a choice, not a date.

Full membership:

**0. Paid-led headline launches** (33; 2024: 3, 2025: 8, 2026: 22)

Eddie Martinez · Scaffold · 2024 Q2; Pejac · Multiple · 2024 Q3; Johnson Tsang · The Moment · 2024 Q4; Will Cotton · The Cowgirl · 2025 Q1; Hajime Sorayama · Untitled · 2025 Q2; Lee Ufan · Multiple · 2025 Q2; James Jarvis · Hang in there! · 2025 Q3; Johnson Tsang · Remembrance · 2025 Q3; Maurizio Cattelan · We are the Revolution · 2025 Q4; Alex Katz · Ada Ada · 2025 Q4; Ai Weiwei · Multiple · 2025 Q4; Ferrari Sheppard · Put Some Red On It · 2026 Q1; Lee Ufan · Dialogue · 2026 Q1; Pejac · Multiple · 2026 Q1; Maurizio Cattelan · Window · 2026 Q1; Jean-Michel Othoniel · Multiple · 2026 Q1; Jeff Koons · Multiple · 2026 Q1; Ai Weiwei · Arm · Multiple · 2026 Q2; Maurizio Cattelan · La Nona Ora · 2026 Q2; Maurizio Cattelan · THERAPY · 2026 Q2; Takashi Murakami · Multiple · 2026 Q2; Anni and Josef Albers · Multiple · 2026 Q2; Cindy Sherman · Untitled · 2026 Q2; Felipe Pantone · Subtractive Variability Dimensional 13 AA · 2026 Q2; Urs Fischer · Multiple · 2026 Q2; Johnson Tsang · Alliance · 2026 Q2; Hank Willis Thomas · “Success is no accident.” · 2026 Q2; Yoon Hyup · Ambre Roulette · 2026 Q3; Zeng Fanzhi · Rainbow (Mask Series 1997 no.8) · 2026 Q3; Jaume Plensa · UTOPIA · 2026 Q3; Piet Mondrian Estate · Multiple · 2026 Q3; James Jean · Multiple · 2026 Q3; Parra · Multiple · 2026 Q3

**1. Paid-supported small editions** (17; 2024: 2, 2025: 4, 2026: 11)

Magdalena Suarez Frimkess · Homage for Jasper Johns · 2024 Q3; Taku Obata · B BOY SEIDOU · 2024 Q4; Harland Miller · Multiple · 2025 Q1; Jenny Holzer · Multiple · 2025 Q1; En Iwamura · Multiple · 2025 Q3; Judy Chicago · Reincarnation Triptych · 2025 Q4; Joakim Ojanen · The dance we dance when we are together · 2026 Q1; DRIFT · Proto Nature I · 2026 Q1; Grant Riven Yun · High Fly Over the Valley · 2026 Q2; Paul Insect · Prismatic Visions · 2026 Q2; Eddie Martinez · Olive Garden · 2026 Q2; Antony Micallef · Self Portrait with Blue Slash · 2026 Q2; LY · LUV New Beginnings · 2026 Q3; Giuseppe Penone · Multiple · 2026 Q3; Ahmed Mater · Multiple · 2026 Q3; Abdulnasser Gharem · Hemisphere · 2026 Q3; Zeng Fanzhi · Multiple · 2026 Q3

**2. Email-led collector launches with a private room** (35; 2023: 2, 2024: 13, 2025: 15, 2026: 5)

Kotao Tomozawa · Multiple · 2023 Q4; Tomokazu Matsuyama · Perfect All Alone Ironic · 2023 Q4; Baldur Helgason · Menippean Satire · 2024 Q1; Javier Calleja · Multiple · 2024 Q2; Asuka Anastacia Ogawa · Sleepy · 2024 Q2; Kaï · Content · 2024 Q2; Paul Insect · Multiple · 2024 Q3; Antony Micallef · Portrait of Francis Bacon · 2024 Q3; TIDE · Multiple · 2024 Q4; Parra · Multiple · 2024 Q4; Ai Weiwei · To Be Looked At... · 2024 Q4; Miwa Komatsu · White and Black Guiding Yamainu-sama · 2024 Q4; Woo Kuk Won · Multiple · 2024 Q4; José Parlá · Multiple · 2024 Q4; Ai Weiwei · Multiple · 2024 Q4; Hilary Pecis · Multiple · 2025 Q1; Derek Fordjour · Multiple · 2025 Q1; George Condo · Fashion Model · 2025 Q1; Taku Obata · B BOY JUSHI · 2025 Q1; Jammie Holmes · Fred · 2025 Q1; Miwa Komatsu · Innocent Days and Wishes · 2025 Q2; Harland Miller · York So Good They Named It Once · 2025 Q2; Other World · Dogs of War · 2025 Q2; Ferrari Sheppard · Iris · 2025 Q2; LY · LUV Blossoming · 2025 Q2; Yoon Hyup · Summer in San Sebastian · 2025 Q3; Antony Micallef · Self Portrait with Yellow Lake and Magenta · 2025 Q3; Harland Miller · Multiple · 2025 Q3; Woo Kuk Won · Multiple · 2025 Q3; Tomokazu Matsuyama · Morning Sun Dance · 2025 Q3; Johnson Tsang · Work in Progress · 2026 Q1; Luc Tuymans · Bell Boy · 2026 Q1; Miwa Komatsu · Three Guardians: Gatekeeping the Heat and Cold · 2026 Q2; Backside works. · Multiple · 2026 Q3; Tschabalala Self · Multiple · 2026 Q3

**3. Artist-audience draws** (23; 2023: 12, 2024: 9, 2025: 2)

Ripcache · Security · 2023 Q3; Miwa Komatsu · Multiple · 2023 Q4; Johnson Tsang · Open the Right Mind · 2023 Q4; Arghavan Khosravi · The Earring · 2023 Q4; Camilla Engström · Island Creators · 2023 Q4; Roby Dwi Antono · CLEMENTINE · 2023 Q4; Jonny Niesche · Diamond Vibration (Caught by the fuzz) · 2023 Q4; Luis Ponce · And the Absurd Was Born · 2023 Q4; Alpha Centauri Kid · Warothy · 2023 Q4; Yoon Hyup · In The City · 2023 Q4; Dennis Osadebe · In Search For Light · 2023 Q4; LY · LUV Somewhere New · 2023 Q4; Jake Fried · Open Eyes (Signal) · 2024 Q1; William Mapan · Centrifuge · 2024 Q1; Laura El · Park Ave · 2024 Q1; DeeKay · Love Ripples · 2024 Q1; George Condo · Multiple · 2024 Q1; Emily Xie · Guardian Lion · 2024 Q1; Peter Halley · Rising High II · 2024 Q2; Slawn · Ugly Bastard · 2024 Q3; Danielle Mckinney · Shelter · 2024 Q3; Dominique Fung · Handheld Fan · 2025 Q3; Katherine Bradford · Swing Over Pool · 2025 Q3

**Legacy buy-now launches** (47)

Daniel Crews-Chubb · Immortal II (turquoise) · 2023 Q1; Maiko Kobayashi · Moving Colours · 2023 Q1; Hyangmok Baik · I Know What You Did Last Summer · 2023 Q1; Chris Huen Sin Kan · Joel, Tess and Haze · 2023 Q1; Prune Nourry · Mater Earth · 2023 Q1; Rooo Lou · Earnest · 2023 Q2; Chen Wei Ting · Poetic fragments · 2023 Q2; Deborah Brown · March Snowstorm · 2023 Q2; Takeru Amano · Venus · 2023 Q2; Keita Morimoto · Cityscape · 2023 Q2; Ai Weiwei · Glass Vase · 2023 Q3; Shigeki Matsuyama · Multiple · 2023 Q2; Ai Weiwei · Multiple · 2023 Q2; Christian Rex van Minnen · Multiple · 2023 Q2; Danielle Orchard · A Warm Garden · 2023 Q2; LY · Multiple · 2023 Q2; Marina Perez Simão · Untitled · 2023 Q2; Grant Riven Yun · Fall · 2023 Q2; Haroshi & James Jean · Multiple · 2023 Q3; Johnson Tsang · Multiple · 2023 Q3; Jake Fried · Open Eyes (Flower) · 2023 Q3; Kotao Tomozawa · slime XCIX · 2023 Q3; Szabolcs Bozó · Multiple · 2023 Q3; Paul Insect · Multiple · 2023 Q3; Tahnee Lonsdale · Dove · 2023 Q3; NKSIN · MY DAVID X · 2023 Q3; JR · GIANTS, High jump in Rio · 2023 Q3; Richard Woods · Multiple · 2023 Q4; Marcus Jansen · Afro Painter · 2023 Q4; So Youn Lee · Ready? · 2023 Q4; Michaela Yearwood-Dan · Multiple · 2023 Q4; Moe Nakamura · Inside Us · 2023 Q4; SETH · Little Sower · 2023 Q4; Bony Ramirez · TORO! · 2023 Q4; Devan Shimoyama · Le Mat · 2023 Q4; Hideaki Kawashima · Multiple · 2023 Q4; Dawnia Darkstone · Digital Chemicals · 2024 Q1; Yutaka Hashimoto · Study_for_Null_Portrait of someone#166 · 2024 Q1; Robert Nava · Death Carrier Bunny · 2024 Q1; Benrei Huang · Minority Rules · 2024 Q1; Cai Guo-Qiang · Snow Lotus No. 1 · 2024 Q1; Michael Kozlowski · Mecha · 2024 Q2; Kaï · Content (Hand-finished) · 2024 Q2; Yoon Hyup · City Fountain · 2024 Q3; Vhils · Multiple · 2024 Q3; Claire Tabouret · Paysage d’Intérieur (printemps) · 2024 Q4; Sayre Gomez · America's Tire · 2025 Q2

## 6. Repeat artists

19 artists have two or more releases in the draw panel (51 releases, 51 same-artist pairs).

| Split | Same-artist pairs in one basket | Expected by chance | Permutation p | Artists entirely in one basket |
|---|---|---|---|---|
| k = 2 (paid-led / organic) | 28 of 51 (55%) | 50% | 0.27 | 8 of 19 |
| k = 4 | 20 of 51 (39%) | 26% | 0.036 | 5 of 19 |

The five who stay put: Maurizio Cattelan, Lee Ufan and Pejac (paid-led headline), Tomokazu
Matsuyama and Woo Kuk Won (email-led private room). Everyone else moved basket between
releases, usually because paid was switched on (Ai Weiwei, Johnson Tsang, Yoon Hyup, Parra,
Ferrari Sheppard, Eddie Martinez, Zeng Fanzhi) or because the two releases differed in size
(Harland Miller, Antony Micallef, Paul Insect and Taku Obata each have one email-led launch and
one paid-supported small edition).

What a repeat artist carries from one release to the next, feature by feature - intraclass
correlation (1 − within-artist / total variance over the 51 releases) against its permutation
null (artist labels shuffled; the null is 0.36 rather than 0 because two to five releases per
artist bias the within-artist variance down):

| Feature | ICC | Null mean | p |
|---|---|---|---|
| log_sessions | 0.79 | 0.36 | 0.000 |
| log_units | 0.77 | 0.36 | 0.000 |
| log_entries | 0.64 | 0.36 | 0.002 |
| cliff_share | 0.58 | 0.36 | 0.014 |
| sess_share_paid | 0.56 | 0.36 | 0.022 |
| sess_share_aa_email | 0.54 | 0.36 | 0.032 |
| sess_share_referral_artist | 0.54 | 0.36 | 0.043 |
| private_room_share | 0.52 | 0.36 | 0.053 |
| campaign_days | 0.51 | 0.36 | 0.051 |
| log_oversub | 0.50 | 0.36 | 0.084 |
| sess_share_aa_social | 0.48 | 0.36 | 0.112 |
| log_units_per_session | 0.47 | 0.36 | 0.129 |
| sess_share_search_direct_other | 0.42 | 0.36 | 0.257 |
| log_entries_per_session | 0.36 | 0.36 | 0.484 |
| ea_share_sessions | 0.32 | 0.36 | 0.629 |
| burst_share | 0.29 | 0.36 | 0.750 |
| half_point | 0.28 | 0.36 | 0.815 |

Scale carries strongly; the paid share, the email share, the referral-artist share, the
private-room share, the campaign length and the last-chance cliff carry loosely (p between
0.01 and 0.05); the announcement burst, the half-point, the early-access share and the
conversion rates do not carry at all. For a new artist that is the reassuring result: the
timing curve and the conversion benchmarks come from the basket, and the only thing the
artist's history would have told us is how big the launch is, which the edition size already
says.

## 7. The baskets as numbers

Each cell is Medium (Low–High) in the Target setting tab's sense: the median and the 25th to
75th percentile across the basket's releases, so the picks can be read straight into the
model. Shares of sessions leave untracked out of the denominator; conversion rates use
unadjusted denominators, as the benchmarks do, and a channel group with under 30 sessions in
a release contributes no rate. Paid conversions in the organic baskets rest on one to three
releases and are not benchmarks.

**Scale and demand** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| Sessions in the campaign window | 23,543 (13,988–38,211) | 7,842 (5,389–9,119) | 4,142 (2,874–6,509) | 2,492 (1,496–3,892) | 1,421 (943–2,720) |
| Units sold | 214 (148–468) | 32 (23–48) | 75 (46–145) | 35 (30–79) | 33 (22–54) |
| Eligible entry units | 194 (153–425) | 20 (17–41) | 58 (42–130) | 86 (44–184) | – |
| Unique customers | 214 (145–454) | 28 (20–48) | 72 (42–107) | 35 (29–78) | 32 (20–46) |
| Oversubscription (eligible entry units ÷ units sold) | 0.89 (0.78–1.18) | 0.71 (0.65–0.86) | 0.99 (0.58–1.37) | 1.14 (0.95–2.49) | – |
| Eligible entry units ÷ draw units | 4.09 (2.69–7.97) | 3.75 (3.00–8.37) | 4.77 (1.63–10.10) | 2.63 (1.24–6.96) | – |
| Private-room share of units | 16% (8.3%–27%) | 15% (10%–22%) | 39% (28%–51%) | 6.5% (0.5%–11%) | 11% (6.8%–24%) |
| Pre-order share of units | 44% (13%–53%) | 49% (36%–65%) | 0.0% (0.0%–26%) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) |
| Draw share of units | 21% (13%–33%) | 14% (9.1%–21%) | 22% (9.0%–35%) | 54% (32%–71%) | 0.0% (0.0%–0.0%) |
| Other routes share of units | 8.8% (6.1%–23%) | 15% (6.8%–28%) | 20% (11%–28%) | 29% (16%–50%) | 88% (75%–93%) |
| Eligible entry units per session | 1.1% (0.6%–1.4%) | 0.3% (0.2%–0.6%) | 1.6% (1.1%–2.5%) | 4.0% (2.1%–5.2%) | – |
| Units per session | 1.1% (0.6%–1.6%) | 0.5% (0.3%–0.7%) | 1.8% (1.2%–2.7%) | 2.0% (1.4%–3.2%) | 2.1% (1.6%–3.3%) |
| Draw units ÷ eligible entry units | 24% (13%–37%) | 17% (11%–33%) | 21% (10%–61%) | 34% (12%–77%) | – |
| Page views per session | 1.36 (1.23–1.61) | 1.40 (1.32–1.48) | 1.93 (1.66–3.02) | 3.64 (3.18–4.15) | 3.54 (2.29–4.50) |

**Channel mix of sessions** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email | 19% (16%–31%) | 28% (15%–35%) | 61% (36%–68%) | 31% (12%–39%) | 24% (14%–40%) |
| AA Meta (organic social) | 3.0% (1.8%–4.0%) | 4.9% (3.0%–7.5%) | 10% (5.8%–14%) | 11% (7.8%–18%) | 12% (6.8%–16%) |
| Referral artist | 1.7% (0.0%–5.8%) | 3.2% (0.7%–4.4%) | 5.4% (0.5%–23%) | 16% (0.1%–28%) | 7.6% (0.1%–20%) |
| Search / direct / other | 6.3% (5.2%–10%) | 7.2% (5.6%–8.1%) | 18% (15%–23%) | 36% (31%–49%) | 44% (31%–58%) |
| Paid | 61% (51%–76%) | 56% (39%–67%) | 0.0% (0.0%–0.1%) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) |

**Channel share of eligible entry units** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email | 33% (23%–39%) | 39% (26%–50%) | 35% (26%–51%) | 26% (17%–38%) | – |
| AA Meta (organic social) | 4.0% (2.7%–6.0%) | 6.4% (0.0%–14%) | 8.7% (4.7%–15%) | 12% (8.1%–17%) | – |
| Referral artist | 0.5% (0.0%–7.4%) | 2.3% (0.0%–12%) | 4.9% (0.0%–19%) | 7.7% (0.0%–24%) | – |
| Search / direct / other | 32% (24%–37%) | 28% (17%–34%) | 35% (27%–42%) | 48% (37%–57%) | – |
| Paid | 31% (18%–35%) | 11% (5.0%–35%) | 0.0% (0.0%–2.3%) | 0.0% (0.0%–0.0%) | – |

**Channel share of units sold** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email | 38% (31%–46%) | 47% (28%–53%) | 43% (33%–53%) | 17% (8.9%–31%) | 18% (7.5%–27%) |
| AA Meta (organic social) | 3.7% (2.8%–5.4%) | 5.9% (0.0%–12%) | 5.4% (2.5%–8.1%) | 8.7% (4.6%–12%) | 4.1% (0.0%–10%) |
| Referral artist | 0.7% (0.0%–6.6%) | 5.6% (0.0%–9.1%) | 2.4% (0.0%–10%) | 6.3% (0.0%–17%) | 2.7% (0.0%–10%) |
| Search / direct / other | 30% (22%–36%) | 27% (22%–37%) | 39% (31%–46%) | 62% (46%–73%) | 67% (58%–82%) |
| Paid | 25% (11%–31%) | 8.3% (3.1%–28%) | 0.0% (0.0%–0.6%) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) |

**Session → eligible entry conversion by channel** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email | 1.5% (1.0%–2.1%) | 0.6% (0.2%–0.9%) | 1.1% (0.8%–1.5%) | 3.2% (1.8%–4.3%) | – |
| AA Meta (organic social) | 1.4% (1.0%–3.0%) | 0.4% (0.2%–1.2%) | 1.3% (0.8%–2.2%) | 2.9% (2.0%–5.4%) | – |
| Referral artist | 1.2% (0.3%–2.3%) | 0.4% (0.0%–0.7%) | 1.3% (0.9%–2.1%) | 2.5% (1.1%–3.8%) | – |
| Search / direct / other | 3.7% (2.8%–4.7%) | 1.4% (0.7%–1.8%) | 2.7% (1.9%–5.4%) | 4.2% (2.9%–5.8%) | – |
| Paid | 0.4% (0.3%–0.6%) | 0.1% (0.1%–0.2%) | 1.0% (0.9%–2.8%) | 3.1% (3.1%–3.1%) | – |

**Session → unit conversion by channel** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email | 2.2% (1.2%–2.7%) | 0.5% (0.5%–1.1%) | 1.4% (0.9%–2.1%) | 1.0% (0.3%–1.8%) | 1.2% (0.4%–2.4%) |
| AA Meta (organic social) | 1.5% (0.7%–2.4%) | 0.6% (0.2%–1.0%) | 0.8% (0.4%–1.4%) | 1.0% (0.3%–2.3%) | 0.6% (0.0%–1.5%) |
| Referral artist | 1.3% (0.5%–2.2%) | 0.4% (0.1%–0.7%) | 0.8% (0.2%–1.3%) | 0.7% (0.2%–2.3%) | 0.5% (0.2%–1.4%) |
| Search / direct / other | 3.5% (2.5%–4.6%) | 2.0% (1.1%–2.4%) | 3.8% (2.5%–4.5%) | 2.4% (1.1%–3.4%) | 3.0% (1.9%–4.9%) |
| Paid | 0.3% (0.2%–0.6%) | 0.1% (0.1%–0.1%) | 0.8% (0.4%–1.8%) | 4.6% (4.6%–4.6%) | 0.1% (0.1%–0.1%) |

**Timing shape** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| Campaign length, announce to close (days) | 26 (22–28) | 28 (26–29) | 27 (20–29) | 19 (16–24) | 21 (21–21) |
| Sessions before announce (early access) | 6.2% (3.0%–10%) | 7.9% (3.7%–15%) | 22% (11%–32%) | 1.1% (0.4%–2.1%) | 58% (41%–68%) |
| Units before announce | 14% (6.5%–23%) | 15% (0.0%–18%) | 31% (17%–53%) | 0.0% (0.0%–5.5%) | 50% (31%–61%) |
| Sessions in the first 10% of the campaign | 16% (9.3%–27%) | 19% (12%–26%) | 51% (45%–61%) | 22% (11%–31%) | 63% (42%–76%) |
| Sessions in the last 10% of the campaign | 16% (7.7%–19%) | 8.1% (3.8%–13%) | 12% (8.4%–23%) | 15% (11%–19%) | 2.5% (1.5%–4.0%) |
| Point in the campaign where half the sessions are in | 50% (33%–67%) | 52% (29%–67%) | 7.7% (4.2%–14%) | 36% (24%–48%) | 4.8% (0.0%–19%) |
| Peak day's share of campaign sessions | 14% (9.4%–20%) | 16% (13%–19%) | 34% (31%–43%) | 26% (21%–31%) | 47% (37%–58%) |
| Entries in the first 10% | 30% (23%–34%) | 28% (21%–42%) | 48% (40%–54%) | 24% (12%–42%) | – |
| Entries in the last 10% | 14% (10%–20%) | 11% (8.3%–15%) | 14% (10%–19%) | 15% (8.3%–20%) | – |
| Point where half the entries are in | 33% (20%–52%) | 29% (14%–43%) | 11% (7.1%–27%) | 33% (15%–42%) | – |

**Sessions by campaign stage** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| Early access (before announce) | 6.2% (3.0%–10%) | 7.9% (3.7%–15%) | 22% (11%–32%) | 1.1% (0.4%–2.1%) | 58% (41%–68%) |
| Sustain 1 | 27% (16%–46%) | 27% (19%–58%) | 48% (42%–60%) | 45% (34%–55%) | 29% (24%–39%) |
| Sustain 2 | 19% (11%–31%) | 26% (10%–44%) | 6.6% (5.1%–9.3%) | 18% (12%–28%) | 3.5% (2.1%–7.3%) |
| Sustain 3 | 27% (16%–38%) | 17% (6.6%–34%) | 12% (7.6%–17%) | 17% (13%–24%) | 2.4% (1.2%–6.6%) |
| Last chance (close day onward) | 4.5% (2.0%–6.2%) | 2.4% (1.3%–3.2%) | 4.2% (3.3%–5.2%) | 11% (7.9%–16%) | 0.8% (0.5%–2.2%) |

**Eligible entry units by campaign stage** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| Early access (before announce) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) | 0.0% (0.0%–0.0%) | – |
| Sustain 1 | 47% (36%–62%) | 51% (36%–67%) | 60% (53%–69%) | 47% (43%–61%) | – |
| Sustain 2 | 19% (10%–22%) | 16% (8.3%–37%) | 12% (8.7%–17%) | 20% (13%–24%) | – |
| Sustain 3 | 25% (17%–32%) | 17% (13%–27%) | 19% (11%–26%) | 20% (13%–28%) | – |
| Last chance (close day onward) | 5.1% (3.3%–7.2%) | 3.7% (0.0%–5.3%) | 3.8% (2.7%–7.7%) | 7.1% (2.4%–10%) | – |

**Units sold by campaign stage** - Medium (Low–High), i.e. median (p25–p75) across the basket's releases

| | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| Early access (before announce) | 14% (6.5%–23%) | 15% (0.0%–18%) | 31% (17%–53%) | 0.0% (0.0%–5.5%) | 50% (31%–61%) |
| Sustain 1 | 17% (12%–31%) | 32% (21%–43%) | 18% (11%–28%) | 11% (6.6%–20%) | 44% (30%–60%) |
| Sustain 2 | 8.7% (3.5%–19%) | 17% (13%–29%) | 2.7% (0.8%–12%) | 7.7% (1.6%–14%) | 0.0% (0.0%–6.4%) |
| Sustain 3 | 6.6% (1.7%–14%) | 4.2% (0.0%–12%) | 2.3% (0.3%–4.2%) | 8.3% (3.6%–13%) | 0.0% (0.0%–2.8%) |
| Last chance (close day onward) | 34% (25%–57%) | 25% (16%–32%) | 29% (25%–45%) | 60% (46%–77%) | 0.0% (0.0%–0.0%) |

Raw channels, share of sessions (median per basket):

| Channel (share of sessions, median) | Paid-led headline | Paid-supported small | Email-led private room | Artist-audience | Legacy buy-now |
|---|---|---|---|---|---|
| AA Email Man | 18% | 27% | 59% | 31% | 23% |
| AA Email Auto | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| AA Meta | 2.9% | 4.8% | 9.2% | 7.2% | 9.2% |
| AA X | 0.1% | 0.1% | 0.2% | 0.4% | 0.3% |
| Referral Artist | 1.7% | 3.2% | 5.4% | 16% | 7.6% |
| Direct | 4.1% | 4.4% | 14% | 22% | 32% |
| Organic Search | 0.5% | 0.4% | 1.1% | 1.7% | 2.4% |
| Other | 0.5% | 0.2% | 0.0% | 0.0% | 0.0% |
| AA Other | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |
| Referral Meta | 0.7% | 0.7% | 1.3% | 0.6% | 1.6% |
| Referral Other | 0.3% | 0.2% | 0.8% | 2.4% | 1.6% |
| Referral X | 0.0% | 0.0% | 0.0% | 0.1% | 0.0% |
| Paid Social | 61% | 56% | 0.0% | 0.0% | 0.0% |
| Paid Search | 0.0% | 0.0% | 0.0% | 0.0% | 0.0% |

## 8. What follows for the target model

1. **Pick the basket before the quartiles.** The default Medium row of the pooled panel is
   a blend of playbooks: an email-led private-room launch runs at 61% email sessions and
   books 39% of its units in the private room, a paid-led headline launch at 19% and 16%.
   For a new artist, choose the basket by what the launch is designed to be and take Low /
   Medium / High from `data/release_cluster_baskets.json`; the artist's own history would
   only have said how big the launch is.
2. **The curves differ by basket more than the tier probe could see.** The across-time
   curves are pooled and tier-blind (`docs/DATA_MODEL.md` §5.3, tested on 15 clocked 2026
   releases). Across the whole history the email-led basket has half its sessions in by 8%
   of the campaign and the paid baskets by 50%; last-chance books 60% of the units in the
   artist-audience basket and 25% in the paid-supported one. Cohorting the trajectory curves
   at least by paid-led against organic is worth testing now that the inferred windows put
   108 campaigns on the clock.
3. **Conversion benchmarks are era-sensitive.** Sessions to eligible entries run at 0.3% to
   1.1% in the paid baskets and 1.6% to 4.0% in the organic ones; a pooled median sits
   between them and fits nobody. The nightly benchmark recompute (§4 of the data model)
   should carry the basket as a dimension.
4. **Re-run as the panel grows.** Six 2026 Q3 campaigns are in flight; the script is
   deterministic (seeded) and prints the same tables, and the cluster count should be
   re-read from the stability column, not assumed. Cluster names are attached by rank
   (paid share, then size), so a re-run that changes the ranking would need the names
   checked.

**Caveats.** 81 of the 108 windows are inferred (validated above, but inferred). Oversubscription
is measured against units *sold*, not the edition size, which the funnel does not carry, so an
undersubscribed release reads lower than the workbook's definition would. The clusters are
regions of a continuum; releases near a boundary (the script's `dist_to_centroid` column) belong
to two baskets about equally and should be read against both.
