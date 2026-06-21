# Extra opponent data available in MTGA logs

Findings from researching [manasight's Arena log format guide](https://blog.manasight.gg/arena-log-format-guide/) and verifying against our log at `/mnt/mtga-logs/Player.log`.

We currently use two event types in `store.rs`:

- `GameResult` (from `ConnectResp.gameStateMessage.gameInfo.results`) — match ID, result, reason
- `GameStateMessage.turnInfo` — phase/step timeline (1300+ events per match)

The guide points to three **additional event types** we're not currently ingesting. All three appear in our log file with rich data.

---

## 1. `matchGameRoomStateChangedEvent` — opponent identity

Fires at match start (`stateType: "Playing"`) and match end (`stateType: "MatchCompleted"`).

**8 occurrences in our log.**

### Start payload (excerpt from our log)

```json
{
  "gameRoomInfo": {
    "gameRoomConfig": {
      "matchId": "490c7444-1734-4ba7-93dd-a5e5cd20ca60",
      "eventId": "Jump_In_2024",
      "reservedPlayers": [
        {
          "userId": "SOHD5RLRYBB2VJTD7LGUPT4E3A",
          "playerName": "Faceless",
          "systemSeatId": 1,
          "teamId": 1,
          "courseId": "Avatar_Basic_Adventurer",
          "sessionId": "36e735f7-5a51-4c75-87a6-78dd32e6f04f",
          "platformId": "Windows",
          "eventId": "Jump_In_2024"
        },
        {
          "userId": "RVGKEWUE5VHYLJG4ONOQUEIUKI",
          "playerName": "KEV3K",
          "systemSeatId": 2,
          "teamId": 2,
          "courseId": "Avatar_Basic_Ziatora_SNC",
          "sessionId": "f20b8754-b203-4cc5-9914-f1c792b6535a",
          "platformId": "AndroidPhone",
          "eventId": "Jump_In_2024"
        }
      ]
    },
    "stateType": "MatchGameRoomStateType_Playing",
    "players": [
      { "userId": "SOHD5...", "playerName": "Faceless", "systemSeatId": 1, "teamId": 1 },
      { "userId": "RVGK...", "playerName": "KEV3K",    "systemSeatId": 2, "teamId": 2 }
    ]
  }
}
```

### End payload (excerpt)

```json
{
  "gameRoomInfo": {
    "stateType": "MatchGameRoomStateType_MatchCompleted",
    "finalMatchResult": {
      "matchId": "490c7444-1734-4ba7-93dd-a5e5cd20ca60",
      "matchCompletedReason": "MatchCompletedReasonType_Success",
      "resultList": [
        { "scope": "MatchScope_Game",  "result": "ResultType_WinLoss", "winningTeamId": 2, "reason": "ResultReason_Concede" },
        { "scope": "MatchScope_Match", "result": "ResultType_WinLoss", "winningTeamId": 2, "reason": "ResultReason_Concede" }
      ]
    }
  }
}
```

### What we can extract

| Field | Path | Notes |
|---|---|---|
| Opponent **playerName** | `reservedPlayers[?].playerName` | e.g. "KEV3K", "KynKier" |
| Opponent **userId** | `reservedPlayers[?].userId` | |
| Opponent **avatar (courseId)** | `reservedPlayers[?].courseId` | e.g. `Avatar_Basic_Ziatora_SNC` |
| Opponent **platform** | `reservedPlayers[?].platformId` | "Windows", "AndroidPhone", "iOS" |
| Opponent **sessionId** | `reservedPlayers[?].sessionId` | |
| Seat assignment | `reservedPlayers[?].systemSeatId`, `teamId` | teamId 1 = you, teamId 2 = opponent (in our log) |
| Per-game `winningTeamId` | `finalMatchResult.resultList[?].winningTeamId` | for Bo3 breakdown |
| Per-game `reason` | `finalMatchResult.resultList[?].reason` | "Game", "Concede", "Timeout" |
| `eventId` | `gameRoomConfig.eventId` | event name as written by server |

> **Privacy note from the guide:** "screen names were removed from most log entries in July 2021, and opponent display name tags were removed in July 2024". Our log was captured after that, yet still has opponent names — confirms WotC's removal is inconsistent or applied per-event-type. Treat playerName as data we *have*, not data we should *broadcast*.

---

## 2. `AnnotationType_ModifiedLife` — life total deltas

Lives inside `GameStateMessage.annotations[]`. **55 occurrences in our log.**

### Shape

```json
{
  "id": 128,
  "affectorId": 241,           ← game object instance that caused the change (a card ability)
  "affectedIds": [1],           ← PLAYER SEAT ID (1=you, 2=opponent) — NOT a card instance
  "type": ["AnnotationType_ModifiedLife"],
  "details": [
    { "key": "life", "type": "KeyValuePairValueType_int32", "valueInt32": [2] }
  ]
}
```

### Key insight: `affectedIds[0]` is the player seat, not a card

We see 32 events for seat 1 (us) and 23 for seat 2 (opponent). This makes life totals trivial to attribute per player.

### Key insight: `valueInt32` is a **delta**, not absolute

Verified by accumulation:
- You (32 events): sum of all deltas = -24 → final life = 20 - 24 = -4 (died)
- Opp (23 events): sum of all deltas = -68 → final life = 20 - 68 = -48 (got smashed)

Negative values dominate (-2, -3, -5, -15 etc. are typical damage ticks); small positives (1, 2, 3) are lifegain events.

### What we can extract

By accumulating per-seat deltas starting from 20 (standard starting life), we reconstruct the **full life-total timeline** for both players across the game.

> No other event type carries life totals in the log. `GameStateMessage.gameStateMessage.players[]` is only populated on the 8 Full-state events per match — and only with snapshot values, not per-step changes. Without ModifiedLife annotations, we'd have no life data at all.

---

## 3. `gameObjects[]` + `AnnotationType_ZoneTransfer` — opponent's cards

Every `GameStateMessage` carries two arrays we currently ignore:

```json
{
  "gameStateMessage": {
    "gameObjects": [
      { "instanceId": 163, "grpId": 93645, "type": "GameObjectType_Card",
        "zoneId": 35, "visibility": "Visibility_Private",        ← in HAND
        "ownerSeatId": 2, "controllerSeatId": 2,
        "cardTypes": ["CardType_Creature"],
        "subtypes": ["SubType_Angel", "SubType_Cleric"],
        "color": ["CardColor_White"], ... }
    ],
    "annotations": [
      { "id": 121, "affectedIds": [240], "type": ["AnnotationType_ZoneTransfer"],
        "details": [
          { "key": "zone_src",  "type": "KeyValuePairValueType_int32", "valueInt32": [31] },
          { "key": "zone_dest", "type": "KeyValuePairValueType_int32", "valueInt32": [28] },
          { "key": "category",  "type": "KeyValuePairValueType_string", "valueString": ["PlayLand"] }
        ]
      }
    ]
  }
}
```

### 229 ZoneTransfer annotations in our log — category breakdown

| Category | Count | Meaning |
|---|---|---|
| `Draw` | 87 | card moved library → hand |
| `Resolve` | 67 | resolved spell: stack → battlefield (or graveyard for non-permanents) |
| `CastSpell` | 66 | card moved hand → stack |
| `PlayLand` | 64 | land moved hand → battlefield |
| `SBA_Damage` | 13 | state-based damage |
| `Discard` | 7 | card moved hand → graveyard |
| `Sacrifice` | 7 | sacrificed |
| `Surveil` | 4 | surveilled (look at top, decide keep/put) |
| `Exile` | 3 | exiled |
| `Put` | 5 | put into zone (counter, etc.) |
| `SBA_UnattachedAura` | 3 | aura fell off |
| `Destroy`, `SBA_ZeroToughness`, `ManifestLike` | 3 | misc |

ZoneTransfer.affectedIds is a **game object instance ID**, not a player. To get the card, look up `gameObjects[].instanceId == <id>` in the same message → reads `grpId` → resolves to card name via Scryfall.

### 53 unique opponent cards revealed in our log

`gameObjects[]` includes cards in hand (visibility: `Private`), battlefield/stack/graveyard (`Public`), but **not library** (cards in library are face-down — only instance IDs are listed in the Library zone, not full gameObjects).

Sample of resolved opponent cards (WUBG four-color deck):

| grpId | Name | Type |
|---|---|---|
| 93645 | Inspiring Overseer | Creature — Angel Cleric |
| 92149 | Underwater Tunnel // Slimy A... | Enchantment — Room |
| 92163 | Defiled Crypt // Cadaver Lab | Enchantment — Room |
| 93708 | Thornweald Archer | Creature — Elf Archer |
| 93931 | Dwynen's Elite | Creature — Elf Warrior |
| 94846 | Glitch Ghost Surveyor | Creature — Spirit Scout |
| 94870 | Thopter Fabricator | Artifact — Vehicle |
| ... | (45 more — mix of creatures, lands, instants, sorceries) | |

The opponent's hand (Private visibility) is visible. Cards are face-down only in the UI, not in the log.

### What we can extract

- **Every card opponent drew / cast / played / resolved / discarded** — by joining `AnnotationType_ZoneTransfer.affectedIds[0]` to `gameObjects[].instanceId` for the grpId, then filtering by `ownerSeatId == 2`.
- **Turn-by-turn play log** — annotations have implicit ordering (the `id` field monotonically increases per match).
- **Approximate opponent deck composition** — unique grpIds the opponent ever had in hand / on battlefield / in graveyard.
- **Card counts** — `Lands played`, `Creatures cast`, `Spells resolved`, etc., by category, by player.

### What's still private

- **Opponent's library contents** (face-down cards before they enter hand)
- **Order of cards in opponent's library**
- **Opponent's sideboard** during a match (only visible via pre-match `DeckSubmission` if it exists, which it usually doesn't for Bo1)

---

## Comparison: what we use vs. what's available

| Source | Currently used | New info unlocked |
|---|---|---|
| `GameResult` (ConnectResp) | ✅ | match ID, result, reason |
| `GameStateMessage.turnInfo` | ✅ | phase/step timeline (1300+/match) |
| **`matchGameRoomStateChangedEvent`** | ❌ | opponent name, avatar, platform, Bo3 breakdown |
| **`AnnotationType_ModifiedLife`** | ❌ | both players' life totals over time |
| **`AnnotationType_ZoneTransfer`** | ❌ | every card drawn/cast/played (by both players) |
| **`gameObjects[]` (seat 2)** | ❌ | specific opponent card names (Scryfall-resolvable) |

---

## Implementation sketch

Three new tables in `events.db` (schema v3):

```sql
CREATE TABLE match_players (
    match_id      TEXT NOT NULL,
    seat_id       INTEGER NOT NULL,           -- 1 or 2
    team_id       INTEGER NOT NULL,           -- 1 (us) or 2 (opponent)
    player_name   TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    course_id     TEXT,                       -- avatar e.g. Avatar_Basic_Ziatora_SNC
    platform_id   TEXT,                       -- "Windows" / "AndroidPhone" / "iOS"
    is_local      BOOLEAN NOT NULL,           -- true if playerName == our authenticateResponse.screenName
    PRIMARY KEY (match_id, seat_id)
);

CREATE TABLE life_changes (
    match_id     TEXT NOT NULL,
    annotation_id INTEGER NOT NULL,           -- for stable ordering
    seat_id      INTEGER NOT NULL,            -- 1 or 2 (from affectedIds[0])
    delta        INTEGER NOT NULL,            -- from valueInt32[0]; positive = lifegain, negative = damage
    PRIMARY KEY (match_id, annotation_id)
);

CREATE TABLE zone_transfers (
    match_id       TEXT NOT NULL,
    annotation_id  INTEGER NOT NULL,
    seat_id        INTEGER,                   -- ownerSeatId of the affected gameObject (or NULL if not resolved)
    grp_id         INTEGER,                   -- from gameObjects[].grpId (or NULL if not resolved)
    category       TEXT NOT NULL,             -- "Draw", "CastSpell", "PlayLand", "Resolve", "Discard", etc.
    zone_src       INTEGER,
    zone_dest      INTEGER,
    PRIMARY KEY (match_id, annotation_id)
);
```

Ingestion changes (`ingest.rs` / `store.rs`):
1. Bracket on `matchGameRoomStateChangedEvent.gameRoomConfig.matchId` (start) to know when a match begins.
2. For each GameStateMessage during a match:
   - Walk annotations:
     - `ModifiedLife` → `life_changes` row.
     - `ZoneTransfer` → resolve `affectedIds[0]` to a `gameObjects[]` entry for `grpId` and `ownerSeatId`.
3. On `matchGameRoomStateChangedEvent` with `stateType == "MatchCompleted"`:
   - Insert `match_players` rows (from `reservedPlayers`).
   - Insert per-game result rows from `finalMatchResult.resultList`.

Web rendering additions (`web.rs`):
- Match detail header: opponent name + avatar + platform.
- New section: **Life totals** (mini line chart per player, or text timeline).
- New section: **Plays** (grouped by player, by category, with Scryfall-resolved card names).
- Matches index: optionally show opponent name in the table.

---

## Caveats / open questions

- **Library cards**: are they ever in `gameObjects[]`? Spot checks show no — only listed by instance ID in the Library zone. So we cannot reconstruct the full opponent deck, only the cards they actually drew.
- **First game state**: the initial 7 cards of each player's opening hand are in `gameObjects[]` with `visibility: "Visibility_Private"`. We see them but can't tell which cards got mulliganed.
- **Mulligan decisions**: `ClientMessageType_MulliganResp` appears in the log but we haven't parsed it. Could reveal keep/mulligan patterns.
- **`actions[]` field** in GameStateMessage (cast/play/activate) gives an explicit `seatId` per action — easier than inferring from `ownerSeatId`. Currently ignored.
- **AffecterId in life events**: the card instance that caused the life change. With a card-name resolution, we could build "who hit me with what" log.
- **Reserve players' matchId is the same across Playing and MatchCompleted**: pair them on `matchId` to avoid duplicate match_players rows.
- **Multiple games in one match (Bo3)**: the Playing event has the matchId once; MatchCompleted fires once per match (not per game). Each game's GameResult is still inside its GameStateMessage.

---

## Files to update when implementing

- `src/store.rs` — add `ingest_match_players()`, `ingest_life_changes()`, `ingest_zone_transfers()`; bump schema to v3
- `src/main.rs` — wire new ingest paths
- `src/web.rs` — render new match-detail sections (life chart, plays log, opponent info in header)
- `src/web.css` — styles for new sections
- `README.md` — document the new sections

Estimated effort: ~4-6 hours for all four additions end-to-end with tests.
